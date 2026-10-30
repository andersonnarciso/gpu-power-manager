/**
 * Real power limit backend, driven by the NVIDIA driver.
 *
 * Reading the limits does not need any privilege, so it is done directly with
 * `nvidia-smi`. Writing a limit does need root, and the app must never run
 * as root, so every change is delegated to the privileged helper, which is
 * executed through `pkexec`.
 */

import { ErrorCode, type GpuUuid } from '../../shared/types';
import { AppErrorException, asAppError, fail } from '../privileged/errors';
import { ExecFailure, nodeExecRunner, type ExecRunner } from '../privileged/exec';
import { HelperClient } from '../privileged/helper-client';
import { nodeFileProbe, type FileProbe } from '../privileged/polkit';
import type { BackendPowerLimits, PowerLimitBackend } from './backend';

/** Locations of `nvidia-smi` on a typical Linux installation. */
export const NVIDIA_SMI_CANDIDATES: readonly string[] = [
  '/usr/bin/nvidia-smi',
  '/usr/local/bin/nvidia-smi',
  '/usr/sbin/nvidia-smi',
];

/** Fields queried from the driver, in order. */
const QUERY_FIELDS = 'uuid,name,power.min_limit,power.default_limit,power.max_limit,power.limit';

const DEFAULT_READ_TIMEOUT_MS = 15_000;

export interface NvidiasmiBackendOptions {
  /** Executor used to query the driver. */
  runner?: ExecRunner;
  /** Client of the privileged helper used for the changes. */
  helperClient?: HelperClient;
  /** Explicit path of `nvidia-smi`. */
  nvidiaSmiPath?: string | null;
  /** Filesystem probe used to locate `nvidia-smi`. */
  probe?: FileProbe;
  /** Timeout applied to the read only queries. */
  timeoutMs?: number;
}

/** One GPU as reported by `nvidia-smi`. */
export interface NvidiasmiGpu {
  uuid: string;
  name: string | null;
  minWatts: number | null;
  defaultWatts: number | null;
  maxWatts: number | null;
  currentWatts: number | null;
}

/** Parses a numeric field of the CSV output. `[N/A]` becomes null. */
export function parseWattValue(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === '[N/A]' || trimmed === 'N/A') return null;
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value)) return null;
  return Math.round(value);
}

/**
 * Parses the CSV produced by
 * `nvidia-smi --query-gpu=... --format=csv,noheader,nounits`.
 */
export function parseNvidiaSmiCsv(stdout: string): NvidiasmiGpu[] {
  const gpus: NvidiasmiGpu[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const fields = trimmed.split(',').map((field) => field.trim());
    if (fields.length < 6) continue;
    const uuid = fields[0];
    if (!uuid.startsWith('GPU-')) continue;
    // The name may contain spaces, and theoretically commas, so the four
    // numeric fields are taken from the end of the line.
    const current = parseWattValue(fields[fields.length - 1]);
    const max = parseWattValue(fields[fields.length - 2]);
    const defaultLimit = parseWattValue(fields[fields.length - 3]);
    const min = parseWattValue(fields[fields.length - 4]);
    const name = fields.slice(1, fields.length - 4).join(',');
    gpus.push({
      uuid,
      name: name.length > 0 ? name : null,
      minWatts: min,
      defaultWatts: defaultLimit,
      maxWatts: max,
      currentWatts: current,
    });
  }
  return gpus;
}

/** Locates `nvidia-smi`, falling back to the PATH lookup done by execve. */
export function findNvidiaSmi(probe: FileProbe = nodeFileProbe): string {
  for (const candidate of NVIDIA_SMI_CANDIDATES) {
    if (probe.exists(candidate)) return candidate;
  }
  return 'nvidia-smi';
}

export class NvidiasmiBackend implements PowerLimitBackend {
  private readonly runner: ExecRunner;
  private readonly helperClient: HelperClient;
  private readonly probe: FileProbe;
  private readonly timeoutMs: number;
  private readonly explicitPath: string | null;

  constructor(options: NvidiasmiBackendOptions = {}) {
    this.runner = options.runner ?? nodeExecRunner;
    this.probe = options.probe ?? nodeFileProbe;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.explicitPath = options.nvidiaSmiPath ?? null;
    this.helperClient = options.helperClient ?? new HelperClient({ runner: this.runner });
  }

  isSimulated(): boolean {
    return false;
  }

  async exists(uuid: GpuUuid): Promise<boolean> {
    try {
      const gpus = await this.listGpus();
      return gpus.some((gpu) => gpu.uuid === uuid);
    } catch (error) {
      if (error instanceof AppErrorException) {
        if (error.appError.code === ErrorCode.GpuNotFound) return false;
        throw error;
      }
      throw error;
    }
  }

  async bounds(uuid: GpuUuid): Promise<BackendPowerLimits> {
    const gpus = await this.listGpus(uuid);
    const gpu = gpus.find((candidate) => candidate.uuid === uuid);
    if (gpu === undefined) {
      throw fail(ErrorCode.GpuNotFound, `A GPU ${uuid} não existe no sistema.`);
    }
    return {
      min: gpu.minWatts,
      max: gpu.maxWatts,
      defaultLimit: gpu.defaultWatts,
      current: gpu.currentWatts,
    };
  }

  async apply(uuid: GpuUuid, watts: number): Promise<void> {
    // The change itself happens inside the privileged helper.
    await this.helperClient.setPowerLimit(uuid, watts);
  }

  async reset(uuid: GpuUuid): Promise<void> {
    await this.helperClient.resetPowerLimit(uuid);
  }

  /** Reads every GPU known to the driver, or only the requested one. */
  async listGpus(uuid?: GpuUuid): Promise<NvidiasmiGpu[]> {
    const smi = this.resolveNvidiaSmiPath();
    const args: string[] = [];
    if (uuid !== undefined) args.push('-i', uuid);
    args.push(`--query-gpu=${QUERY_FIELDS}`, '--format=csv,noheader,nounits');

    let stdout: string;
    try {
      const result = await this.runner.run(smi, args, { timeoutMs: this.timeoutMs });
      stdout = result.stdout;
    } catch (error) {
      throw this.mapReadFailure(error, uuid);
    }
    return parseNvidiaSmiCsv(stdout);
  }

  private resolveNvidiaSmiPath(): string {
    if (this.explicitPath !== null) return this.explicitPath;
    return findNvidiaSmi(this.probe);
  }

  private mapReadFailure(error: unknown, uuid?: GpuUuid): AppErrorException {
    if (!(error instanceof ExecFailure)) {
      const appError = asAppError(error);
      return fail(appError.code, appError.message, { detail: appError.detail });
    }
    if (error.errno === 'ENOENT') {
      return fail(
        ErrorCode.DriverUnavailable,
        'O utilitário nvidia-smi não foi encontrado neste sistema.',
        { detail: 'Instale o driver NVIDIA (pacote nvidia-utils) para gerenciar o limite de potência.' },
      );
    }
    if (error.timedOut) {
      return fail(ErrorCode.Timeout, `O driver NVIDIA não respondeu a tempo (${this.timeoutMs} ms).`);
    }
    const stderr = error.stderr.trim();
    if (stderr.includes('No devices were found') || error.exitCode === 6) {
      return fail(
        ErrorCode.GpuNotFound,
        uuid === undefined
          ? 'O driver NVIDIA não encontrou nenhuma GPU.'
          : `A GPU ${uuid} não foi encontrada pelo driver NVIDIA.`,
        { detail: stderr.length > 0 ? stderr : undefined },
      );
    }
    return fail(ErrorCode.CommandFailed, 'Não foi possível consultar o driver NVIDIA.', {
      detail: stderr.length > 0 ? stderr : undefined,
    });
  }
}
