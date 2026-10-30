/**
 * The telemetry engine.
 *
 * It owns the polling loop, the registry of known GPUs and the push
 * subscriptions used by the IPC layer.
 *
 * Rules that must not be broken:
 *  - GPUs are identified by UUID: a device that changes its driver index
 *    keeps its identity and its history;
 *  - a GPU that disappears is **kept** in the list with `present: false` and
 *    a frozen `lastSeenAt`; it is never dropped;
 *  - a driver failure never crashes the service and never rejects: the last
 *    known snapshot is preserved and the error is pushed to the subscribers.
 */

import { ErrorCode, type AppError, type GpuDevice, type TelemetrySample } from '../../shared/types';
import type { GpuService } from '../../shared/contracts';
import { createLogger, nullLogger, type Logger } from '../nvidia/logger';
import type { GpuSource } from '../nvidia/source';
import { systemClock, type Clock, type TimerHandle } from './clock';
import { TelemetryHistory } from './history';

export const DEFAULT_TELEMETRY_INTERVAL_MS = 1000;
export const MIN_TELEMETRY_INTERVAL_MS = 250;
export const MAX_TELEMETRY_INTERVAL_MS = 10_000;

/** Clamps a user supplied interval into the supported range. */
export function clampIntervalMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs)) return DEFAULT_TELEMETRY_INTERVAL_MS;
  const rounded = Math.round(intervalMs);
  if (rounded < MIN_TELEMETRY_INTERVAL_MS) return MIN_TELEMETRY_INTERVAL_MS;
  if (rounded > MAX_TELEMETRY_INTERVAL_MS) return MAX_TELEMETRY_INTERVAL_MS;
  return rounded;
}

export interface TelemetryServiceOptions {
  /** Where the devices come from: the real driver or the simulator. */
  source: GpuSource;
  /** Polling interval in milliseconds. Clamped to 250..10000. */
  intervalMs?: number;
  /** Injectable clock/timer, so the tests never wait in real time. */
  clock?: Clock<TimerHandle>;
  /** Injectable logger. */
  logger?: Logger;
  /** Injectable history buffer. */
  history?: TelemetryHistory;
  /** Called for every polling failure, e.g. to push `telemetry:error`. */
  onError?: (error: AppError) => void;
}

interface CodedError {
  code: string;
  message: string;
}

function isCodedError(error: unknown): error is CodedError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return typeof candidate.code === 'string' && typeof candidate.message === 'string';
}

/** Turns any thrown value into a user facing error. */
export function toTelemetryAppError(error: unknown): AppError {
  if (isCodedError(error)) {
    return {
      code: error.code,
      message: 'Não foi possível consultar o driver NVIDIA.',
      detail: error.message,
    };
  }
  if (error instanceof Error) {
    return {
      code: ErrorCode.Unknown,
      message: 'Não foi possível consultar o driver NVIDIA.',
      detail: error.message,
    };
  }
  return {
    code: ErrorCode.Unknown,
    message: 'Não foi possível consultar o driver NVIDIA.',
    detail: String(error),
  };
}

export class TelemetryService implements GpuService {
  private readonly source: GpuSource;
  private readonly clock: Clock<TimerHandle>;
  private readonly logger: Logger;
  private readonly historyBuffer: TelemetryHistory;
  private readonly onErrorOption: ((error: AppError) => void) | undefined;

  /** Every GPU ever seen, keyed by UUID. */
  private readonly devices = new Map<string, GpuDevice>();
  private readonly listeners = new Set<(sample: TelemetrySample) => void>();
  private readonly errorListeners = new Set<(error: AppError) => void>();

  private timer: TimerHandle = null;
  private polling = false;
  private inFlight: Promise<boolean> | null = null;
  private primed = false;
  private currentSample: TelemetrySample = { at: 0, gpus: [] };
  private intervalMs: number;

  constructor(options: TelemetryServiceOptions) {
    this.source = options.source;
    this.clock = options.clock ?? (systemClock as Clock<TimerHandle>);
    this.logger = options.logger ?? nullLogger;
    this.historyBuffer = options.history ?? new TelemetryHistory({ now: () => this.clock.now() });
    this.onErrorOption = options.onError;
    this.intervalMs = clampIntervalMs(options.intervalMs ?? DEFAULT_TELEMETRY_INTERVAL_MS);
  }

  /* ------------------------------------------------------------- lifecycle */

  /** Starts the polling loop. Safe to call twice. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = this.clock.setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.logger.debug(`Telemetria iniciada com intervalo de ${this.intervalMs} ms.`);
    void this.bootstrap();
  }

  /** Stops the polling loop and releases the timer. Safe to call twice. */
  stop(): void {
    if (this.timer === null) return;
    this.clock.clearInterval(this.timer);
    this.timer = null;
    this.logger.debug('Telemetria parada.');
  }

  /** True while the polling loop is armed. */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /** Changes the polling interval and restarts the timer when needed. */
  setIntervalMs(intervalMs: number): void {
    const next = clampIntervalMs(intervalMs);
    if (next === this.intervalMs && this.timer !== null) return;
    this.intervalMs = next;
    if (this.timer !== null) {
      this.clock.clearInterval(this.timer);
      this.timer = this.clock.setInterval(() => {
        void this.tick();
      }, this.intervalMs);
    }
  }

  /** The interval currently in use. */
  getIntervalMs(): number {
    return this.intervalMs;
  }

  /* ---------------------------------------------------------- gpu service */

  async list(): Promise<GpuDevice[]> {
    if (!this.primed) {
      this.primed = true;
      await this.pollOnce();
    }
    // A poll may already be running: wait for it instead of returning a
    // half filled list.
    if (this.inFlight !== null) {
      await this.inFlight;
    }
    return this.currentDevices();
  }

  snapshot(): TelemetrySample {
    return this.currentSample;
  }

  isSimulated(): boolean {
    return this.source.isSimulated();
  }

  subscribe(listener: (sample: TelemetrySample) => void): () => void {
    this.listeners.add(listener);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.listeners.delete(listener);
    };
  }

  /** Subscribes to polling failures, e.g. to push `telemetry:error`. */
  onError(listener: (error: AppError) => void): () => void {
    this.errorListeners.add(listener);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.errorListeners.delete(listener);
    };
  }

  /** The retained telemetry history. */
  history(): TelemetrySample[] {
    return this.historyBuffer.list();
  }

  /** The history buffer, so the renderer can downsample it. */
  getHistoryBuffer(): TelemetryHistory {
    return this.historyBuffer;
  }

  /* --------------------------------------------------------------- polling */

  /**
   * Runs a single poll. Never rejects: a failure is reported to the error
   * subscribers and the previous snapshot is kept.
   */
  async pollOnce(): Promise<boolean> {
    if (this.inFlight !== null) {
      this.logger.debug('Poll ignorado: a leitura anterior ainda está em curso.');
      return false;
    }
    this.polling = true;
    const run = this.runPoll();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = null;
      this.polling = false;
    }
  }

  /** The actual read of the source, isolated from the scheduling logic. */
  private async runPoll(): Promise<boolean> {
    try {
      const devices = await this.source.poll();
      this.applyDevices(devices);
      this.publish();
      return true;
    } catch (error) {
      this.logger.warn('Falha ao consultar as GPUs.', error);
      this.emitError(toTelemetryAppError(error));
      return false;
    }
  }

  /** Timer callback: skips the tick when a poll is still running. */
  private async tick(): Promise<void> {
    if (this.polling) {
      this.logger.debug('Tick pulado: poll anterior ainda em curso.');
      return;
    }
    await this.pollOnce();
  }

  /** One-time bootstrap: reads the driver banner before the first poll. */
  private async bootstrap(): Promise<void> {
    if (this.primed) return;
    this.primed = true;
    try {
      await this.source.prime?.();
    } catch (error) {
      this.logger.warn('Falha no bootstrap da fonte de GPUs.', error);
    }
    await this.pollOnce();
  }

  /**
   * Merges a fresh reading into the registry.
   *
   * Devices are keyed by UUID, so a permutation of the driver indexes does
   * not change the identity of anything. Devices that are missing from the
   * reading are flagged as absent and keep their last known reading time.
   */
  private applyDevices(devices: readonly GpuDevice[]): void {
    const at = this.clock.now();
    const seen = new Set<string>();

    for (const device of devices) {
      if (!device || typeof device.uuid !== 'string' || device.uuid === '') continue;
      seen.add(device.uuid);
      this.devices.set(device.uuid, {
        ...device,
        present: true,
        lastSeenAt: at,
      });
    }

    for (const [uuid, device] of [...this.devices.entries()]) {
      if (seen.has(uuid)) continue;
      if (device.present) {
        this.devices.set(uuid, { ...device, present: false });
      }
    }
  }

  /** Publishes the current snapshot to the subscribers. */
  private publish(): void {
    const sample: TelemetrySample = {
      at: this.clock.now(),
      gpus: this.currentDevices(),
    };
    this.currentSample = sample;
    this.historyBuffer.push(sample);
    for (const listener of [...this.listeners]) {
      try {
        listener(sample);
      } catch (error) {
        this.logger.warn('Assinante de telemetria lançou uma exceção.', error);
      }
    }
  }

  /** Notifies the error subscribers about a polling failure. */
  private emitError(error: AppError): void {
    for (const listener of [...this.errorListeners]) {
      try {
        listener(error);
      } catch (listenerError) {
        this.logger.warn('Assinante de erro de telemetria lançou uma exceção.', listenerError);
      }
    }
    if (this.onErrorOption) {
      try {
        this.onErrorOption(error);
      } catch (listenerError) {
        this.logger.warn('Callback de erro de telemetria lançou uma exceção.', listenerError);
      }
    }
  }

  /** A copy of every known device, in the order they were first seen. */
  private currentDevices(): GpuDevice[] {
    return [...this.devices.values()].map((device) => ({ ...device }));
  }
}
