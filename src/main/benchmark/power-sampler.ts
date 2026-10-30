/**
 * Power sampler.
 *
 * The sampler polls an injected power provider at a fixed interval and records
 * one `BenchmarkMeasurement` per tick.
 *
 * Design rules:
 *  - The provider is INJECTED. This module never imports the telemetry engine,
 *    so both can evolve independently and tests can feed synthetic readings.
 *  - A failed tick is skipped, never fatal: the run continues and the gap is
 *    later detected by the energy integration.
 *  - A GPU that did not report a power reading is simply ABSENT from the
 *    sample. It is never reported as 0 W, which would fabricate idle power.
 */

import type { BenchmarkMeasurement, GpuDevice, GpuUuid, TelemetrySample } from '../../shared/types';

/** One power reading of a single GPU. */
export interface PowerReading {
  uuid: GpuUuid;
  /** Instantaneous board power draw in watts. Null when the driver did not report it. */
  watts: number | null;
  /** Board temperature in °C. Null when the driver did not report it. */
  temperatureC?: number | null;
  /**
   * Power limit the driver reports, in watts.
   *
   * It is what the hardware REALLY has configured. Null when the driver did
   * not report it: the limit is then unknown, never guessed.
   */
  limitW?: number | null;
}

/** Reads the instantaneous power draw of every GPU currently visible. */
export type PowerReader = () => Promise<PowerReading[]>;

/** Builds a reader on top of a device provider (the shape the telemetry engine exposes). */
export function powerReaderFromDevices(
  devices: () => GpuDevice[] | Promise<GpuDevice[]>,
): PowerReader {
  return async () => {
    const list = await devices();
    return (Array.isArray(list) ? list : []).map((device) => ({
      uuid: device.uuid,
      watts: device.power?.drawW ?? null,
      temperatureC: device.temperatureC ?? null,
      limitW: device.power?.limitW ?? null,
    }));
  };
}

/** Builds a reader on top of a telemetry provider. */
export function powerReaderFromTelemetry(
  snapshot: () => TelemetrySample | Promise<TelemetrySample>,
): PowerReader {
  return async () => {
    const sample = await snapshot();
    return (sample?.gpus ?? []).map((device) => ({
      uuid: device.uuid,
      watts: device.power?.drawW ?? null,
      temperatureC: device.temperatureC ?? null,
      limitW: device.power?.limitW ?? null,
    }));
  };
}

export interface PowerSamplerOptions {
  /** Sampling interval in milliseconds. Defaults to 1000. */
  intervalMs?: number;
  /** Injectable clock, in epoch milliseconds. */
  now?: () => number;
  /** Called for every recorded sample. */
  onSample?: (measurement: BenchmarkMeasurement) => void;
  /** Called when a tick fails. The tick is skipped, the run continues. */
  onError?: (error: Error) => void;
}

const DEFAULT_INTERVAL_MS = 1000;

export class PowerSampler {
  private readonly reader: PowerReader;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onSample: ((measurement: BenchmarkMeasurement) => void) | undefined;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly recorded: BenchmarkMeasurement[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private failedTicks = 0;

  constructor(reader: PowerReader, options: PowerSamplerOptions = {}) {
    this.reader = reader;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.onSample = options.onSample;
    this.onError = options.onError;
  }

  /** Samples recorded so far, oldest first. */
  get samples(): readonly BenchmarkMeasurement[] {
    return this.recorded;
  }

  /** Number of ticks that failed. A failed tick does not stop the sampler. */
  get failures(): number {
    return this.failedTicks;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The nominal sampling period, in milliseconds. */
  get sampleIntervalMs(): number {
    return this.intervalMs;
  }

  /** Starts sampling. Safe to call twice: the second call is ignored. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  /** Stops sampling. The already recorded samples are kept. */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Takes one extra reading, e.g. to close the window of a finished run.
   *
   * The reading is skipped when the sampler is still running: the periodic
   * tick is already in charge then.
   */
  async sampleOnce(): Promise<void> {
    if (this.running) return;
    await this.read();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const startedAt = this.now();
    try {
      await this.read();
    } finally {
      if (this.running) {
        // The cadence is fixed: the next tick is due one interval after the
        // previous one started, so the duration of the read does not stretch
        // the sampling period (and the energy integration stays honest).
        const elapsed = this.now() - startedAt;
        const delay = Math.max(0, this.intervalMs - elapsed);
        this.timer = setTimeout(() => {
          void this.tick();
        }, delay);
        // Never keep the Electron main process alive just for the sampler.
        const timer = this.timer as unknown as { unref?: () => void };
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
    }
  }

  /** Reads the provider once and records the measurement. */
  private async read(): Promise<void> {
    try {
      const readings = await this.reader();
      const powerW: Record<GpuUuid, number> = {};
      const temperatureC: Record<GpuUuid, number> = {};
      const powerLimitW: Record<GpuUuid, number> = {};
      for (const reading of Array.isArray(readings) ? readings : []) {
        if (!reading || typeof reading.uuid !== 'string' || reading.uuid.length === 0) continue;
        const watts = reading.watts;
        if (typeof watts === 'number' && Number.isFinite(watts) && watts >= 0) {
          powerW[reading.uuid] = watts;
        }
        const celsius = reading.temperatureC;
        if (typeof celsius === 'number' && Number.isFinite(celsius)) {
          temperatureC[reading.uuid] = celsius;
        }
        // The limit the driver REALLY reports: it is observed, never set.
        const limit = reading.limitW;
        if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
          powerLimitW[reading.uuid] = limit;
        }
      }
      const measurement: BenchmarkMeasurement = { at: this.now(), powerW };
      if (Object.keys(temperatureC).length > 0) {
        measurement.temperatureC = temperatureC;
      }
      if (Object.keys(powerLimitW).length > 0) {
        measurement.powerLimitW = powerLimitW;
      }
      this.recorded.push(measurement);
      if (this.onSample) {
        this.onSample(this.recorded[this.recorded.length - 1]);
      }
    } catch (error) {
      this.failedTicks += 1;
      if (this.onError) {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
