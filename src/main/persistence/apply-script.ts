/**
 * Apply script logic.
 *
 * This module owns the algorithm that applies a persisted profile to the
 * GPUs. It exists in two shapes:
 *
 *  1. **TypeScript** (this file): the reference implementation. It is used to
 *     validate a payload before it is written to the root owned state
 *     directory, and it is the function the unit tests drive with a fake
 *     `nvidia-smi` runner. It never touches the real driver during a test.
 *
 *  2. **Python** (`resources/systemd/gpu-power-manager-apply.py`): the
 *     privileged helper started by the systemd unit at boot. It implements the
 *     very same rules, but without Electron, so the persistence works even
 *     when the application is not running.
 *
 * The rules implemented by both:
 *  - the NVIDIA driver is awaited (bounded timeout) before anything is
 *    applied;
 *  - the limits are read from the driver again and the profile is re-resolved
 *    against those live values;
 *  - a value outside the accepted range is rejected, never applied;
 *  - the limit never goes above the factory default of the card;
 *  - `nvidia-smi` is always called with an argv array (`shell=False`);
 *  - everything is written to stderr, so it lands in the journal.
 */

import { isValidGpuUuid } from '../../shared/validation';
import type { ProfileStrategy } from '../../shared/types';
import { resolveStrategyWatts } from '../profiles/strategy';

export const APPLY_SCRIPT_FILE_NAME = 'gpu-power-manager-apply.py';
export const APPLY_STATE_FILE_NAME = 'profile.json';
export const PAYLOAD_VERSION = 1;

export const DEFAULT_STATE_DIR = '/var/lib/gpu-power-manager';
export const DEFAULT_STATE_FILE = `${DEFAULT_STATE_DIR}/${APPLY_STATE_FILE_NAME}`;
export const DEFAULT_SCRIPT_PATH = `/usr/local/lib/gpu-power-manager/${APPLY_SCRIPT_FILE_NAME}`;
export const DEFAULT_NVIDIA_SMI_PATH = '/usr/bin/nvidia-smi';
export const DEFAULT_DEVICE_NODE = '/dev/nvidiactl';
export const DEFAULT_DRIVER_TIMEOUT_MS = 120_000;
export const DEFAULT_DRIVER_POLL_INTERVAL_MS = 2_000;

/* ------------------------------------------------------------------ payload */

export interface PayloadEntry {
  uuid: string;
  /** Explicit watt value, `null` when the strategy decides. */
  watts: number | null;
  strategy: ProfileStrategy;
  ratio?: number | undefined;
}

export interface ApplyPayload {
  version: number;
  profileId: string;
  profileName: string;
  builtin: boolean;
  installedAt: number;
  entries: PayloadEntry[];
  lastAppliedAt: number | null;
  lastError: string | null;
}

/* ------------------------------------------------------------------- runner */

export interface NvidiaSmiResult {
  stdout: string;
  stderr: string;
}

/** Runs `nvidia-smi` with an argv array. Injected so the tests never touch the driver. */
export type NvidiaSmiRunner = (args: string[]) => Promise<NvidiaSmiResult>;

/* ------------------------------------------------------------------- driver */

export interface DriverWaitOptions {
  runner: NvidiaSmiRunner;
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Path of the character device exposed by the driver. */
  deviceNodePath?: string;
  /** Tells whether the device node exists. */
  deviceExists?: (devicePath: string) => boolean;
  log?: (message: string) => void;
}

export interface DriverWaitResult {
  ready: boolean;
  attempts: number;
  waitedMs: number;
  reason: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Waits until the NVIDIA driver answers.
 *
 * The driver is considered ready when `nvidia-smi -L` succeeds. The
 * `/dev/nvidiactl` device node is inspected as well and reported in the log.
 * The wait is bounded: when the timeout expires the caller is told that the
 * driver is not available instead of blocking the boot forever.
 */
export async function waitForDriver(options: DriverWaitOptions): Promise<DriverWaitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_DRIVER_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const devicePath = options.deviceNodePath ?? DEFAULT_DEVICE_NODE;
  const deviceExists = options.deviceExists ?? (() => true);
  const log = options.log ?? (() => undefined);

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastError = '';

  for (;;) {
    attempts += 1;

    let probeOk = false;
    try {
      const result = await options.runner(['-L']);
      probeOk = result.stdout.trim().length > 0 || result.stderr.trim().length === 0;
      if (!probeOk) {
        lastError = result.stderr.trim();
      }
    } catch (error) {
      probeOk = false;
      lastError = error instanceof Error ? error.message : String(error);
    }

    const devicePresent = deviceExists(devicePath);

    if (probeOk) {
      const waitedMs = Date.now() - startedAt;
      log(
        `Driver NVIDIA disponível após ${attempts} tentativa(s) em ${Math.round(waitedMs / 1000)}s.` +
          (devicePresent ? '' : ` (${devicePath} ausente)`),
      );
      return { ready: true, attempts, waitedMs, reason: '' };
    }

    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= timeoutMs) {
      const reason =
        `O driver NVIDIA não ficou disponível em ${Math.round(timeoutMs / 1000)}s.` +
        (lastError !== '' ? ` Última mensagem: ${lastError}` : '');
      log(reason);
      return { ready: false, attempts, waitedMs, reason };
    }

    log(
      `Aguardando o driver NVIDIA (tentativa ${attempts}, ${Math.round(waitedMs / 1000)}s/${
        Math.round(timeoutMs / 1000)
      }s).`,
    );
    await sleep(pollIntervalMs);
  }
}

/* ------------------------------------------------------------------- limits */

export interface GpuLimits {
  uuid: string;
  minWatts: number;
  maxWatts: number;
  defaultWatts: number;
}

export const LIMITS_QUERY_ARGS: readonly string[] = [
  '--query-gpu=uuid,power.min_limit,power.max_limit,power.default_limit',
  '--format=csv,noheader,nounits',
];

/** Reads the power limits the driver accepts for every GPU. */
export async function queryGpuLimits(runner: NvidiaSmiRunner): Promise<GpuLimits[]> {
  const result = await runner([...LIMITS_QUERY_ARGS]);
  const limits: GpuLimits[] = [];

  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 4) {
      continue;
    }
    const uuid = parts[0];
    const minWatts = Number(parts[1]);
    const maxWatts = Number(parts[2]);
    const defaultWatts = Number(parts[3]);

    if (!isValidGpuUuid(uuid)) {
      continue;
    }
    if (!Number.isFinite(minWatts) || !Number.isFinite(maxWatts) || !Number.isFinite(defaultWatts)) {
      continue;
    }

    limits.push({ uuid, minWatts, maxWatts, defaultWatts });
  }

  return limits;
}

/* -------------------------------------------------------------------- apply */

export interface ApplyProfileOptions {
  payload: ApplyPayload;
  runner: NvidiaSmiRunner;
  log?: (message: string) => void;
  /** When provided, the driver is awaited before the limits are applied. */
  wait?: DriverWaitOptions;
  /** Validates and reports the plan without touching the hardware. */
  dryRun?: boolean;
}

export interface ApplyProfileOutcome {
  ok: boolean;
  /** Limits that were applied (or that would be applied on a dry run). */
  applied: Array<{ uuid: string; watts: number }>;
  /** Entries that were ignored, with the reason. */
  skipped: Array<{ uuid: string; reason: string }>;
  /** Entries whose application failed, with the reason. */
  failed: Array<{ uuid: string; reason: string }>;
  /** Set when the whole operation could not even start. */
  error: string | null;
}

/**
 * Resolves and applies every entry of the payload.
 *
 * A GPU that is missing or that rejects the value does not abort the batch:
 * the problem is reported for that GPU and the other GPUs are still applied.
 */
export async function applyProfilePayload(
  options: ApplyProfileOptions,
): Promise<ApplyProfileOutcome> {
  const log = options.log ?? (() => undefined);
  const outcome: ApplyProfileOutcome = {
    ok: true,
    applied: [],
    skipped: [],
    failed: [],
    error: null,
  };

  if (options.wait) {
    const ready = await waitForDriver(options.wait);
    if (!ready.ready) {
      outcome.ok = false;
      outcome.error = ready.reason;
      return outcome;
    }
  }

  let limits: GpuLimits[];
  try {
    limits = await queryGpuLimits(options.runner);
  } catch (error) {
    outcome.ok = false;
    outcome.error = error instanceof Error ? error.message : String(error);
    return outcome;
  }

  const limitsByUuid = new Map(limits.map((item) => [item.uuid, item]));

  for (const entry of options.payload.entries) {
    const item = limitsByUuid.get(entry.uuid);
    if (item === undefined) {
      outcome.skipped.push({
        uuid: entry.uuid,
        reason: 'A GPU não está presente neste computador.',
      });
      continue;
    }

    const resolution = resolveStrategyWatts(
      {
        strategy: entry.strategy,
        ratio: entry.ratio,
        watts: entry.watts,
      },
      { minWatts: item.minWatts, maxWatts: item.maxWatts, defaultWatts: item.defaultWatts },
    );

    if (!resolution.ok) {
      outcome.skipped.push({ uuid: entry.uuid, reason: resolution.reason });
      continue;
    }

    const watts = resolution.watts;

    if (options.dryRun === true) {
      outcome.applied.push({ uuid: entry.uuid, watts });
      log(`(dry-run) ${entry.uuid}: ${watts} W`);
      continue;
    }

    try {
      await options.runner(['-i', entry.uuid, '-pl', String(watts)]);
      outcome.applied.push({ uuid: entry.uuid, watts });
      log(`${entry.uuid}: limite aplicado em ${watts} W`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      outcome.failed.push({ uuid: entry.uuid, reason });
      outcome.ok = false;
      log(`${entry.uuid}: falha ao aplicar ${watts} W — ${reason}`);
    }
  }

  return outcome;
}
