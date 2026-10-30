/**
 * Benchmark engine.
 *
 * Implements the `BenchmarkService` contract:
 *
 *   idle -> running -> completed | failed | aborted
 *
 * While a run is active the engine samples the real power draw of every
 * participating GPU. When the run ends the samples are integrated into energy
 * (trapezoidal integration of the measured power) and the throughput is taken
 * from the workload adapter.
 *
 * Everything the engine depends on is injected: the power reader, the adapter
 * registry, the run store and the clock. That keeps the engine testable and
 * free of any dependency on the telemetry module.
 */

import { randomUUID } from 'node:crypto';
import type { BenchmarkService as BenchmarkServiceContract } from '../../shared/contracts';
import { energyFromMeasurements, MINIMUM_COVERAGE_PCT } from '../../shared/energy';
import {
  ErrorCode,
  type AppError,
  type BenchmarkMeasurement,
  type BenchmarkResult,
  type BenchmarkRunConfig,
  type BenchmarkStatus,
  type EnergySummary,
  type ThroughputResult,
  type WorkloadAdapterInfo,
  type WorkloadKind,
} from '../../shared/types';
import {
  assertArray,
  assertGpuUuid,
  assertIntRange,
  assertNonEmptyString,
  assertOneOf,
  assertPlainObject,
  assertWatts,
  ValidationError,
} from '../../shared/validation';
import {
  AdapterError,
  toAdapterInfo,
  type WorkloadAdapter,
  type WorkloadRunContext,
} from './adapters/types';
import { createInMemoryBenchmarkStore, type BenchmarkRunStore } from './benchmark-store';
import { BENCHMARK_SAMPLE_INTERVAL_MS } from './driver-reader';
import { PowerSampler, type PowerReader } from './power-sampler';

const WORKLOAD_KINDS: readonly WorkloadKind[] = [
  'llm-inference',
  'image-generation',
  'video-generation',
  'cuda-synthetic',
  'manual',
];

/** Maximum number of runs kept in memory and on disk. */
const MAX_STORED_RUNS = 50;

export interface BenchmarkServiceOptions {
  /** Reads the instantaneous power draw of every GPU. */
  powerReader: PowerReader;
  /** Adapters this engine can drive. */
  adapters: WorkloadAdapter[];
  /** Where the finished runs are persisted. Defaults to memory only. */
  store?: BenchmarkRunStore;
  /** Sampling interval in milliseconds. Defaults to the driver resolution. */
  sampleIntervalMs?: number;
  /**
   * Minimum fraction of the run that must have been measured, in percent.
   *
   * Defaults to {@link MINIMUM_COVERAGE_PCT}. A run below it is published as
   * partial: the driver only answered part of the time, so the joules do not
   * describe the whole workload.
   */
  minimumCoveragePct?: number;
  /** Injectable clock, in epoch milliseconds. */
  now?: () => number;
  /** Injectable id generator. */
  createId?: () => string;
  /** Called when the persistence of a run fails. */
  onStoreError?: (error: Error) => void;
}

interface LiveRun {
  result: BenchmarkResult;
  sampler: PowerSampler;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  /** True while the run is being finalised, so it is finalised only once. */
  finalizing: boolean;
}

/** Validates a run configuration coming from the renderer. */
export function validateBenchmarkConfig(config: unknown): BenchmarkRunConfig {
  const raw = assertPlainObject(config, 'config');

  const name = assertNonEmptyString(raw.name, 'name', 120);
  const workload = assertOneOf<WorkloadKind>(raw.workload, WORKLOAD_KINDS, 'workload');

  const adapterId =
    raw.adapterId === null || raw.adapterId === undefined
      ? null
      : assertNonEmptyString(raw.adapterId, 'adapterId', 64);

  const rawUuids = assertArray(raw.uuids, 'uuids', 16);
  const uuids = rawUuids.map((uuid, index) => assertGpuUuid(uuid, `uuids[${index}]`));
  if (uuids.length === 0) {
    throw new ValidationError('uuids', 'Selecione ao menos uma GPU para a medição.');
  }

  const rawWatts = assertPlainObject(raw.wattsPerGpu, 'wattsPerGpu');
  const wattsPerGpu: Record<string, number> = {};
  for (const [uuid, watts] of Object.entries(rawWatts)) {
    assertGpuUuid(uuid, `wattsPerGpu.${uuid}`);
    wattsPerGpu[uuid] = assertWatts(watts, `wattsPerGpu.${uuid}`);
  }
  for (const uuid of uuids) {
    if (wattsPerGpu[uuid] === undefined) {
      throw new ValidationError(
        `wattsPerGpu.${uuid}`,
        'Informe o limite de potência de cada GPU selecionada.',
      );
    }
  }

  const durationLimitSeconds =
    raw.durationLimitSeconds === null || raw.durationLimitSeconds === undefined
      ? null
      : assertIntRange(raw.durationLimitSeconds, 'durationLimitSeconds', 1, 86_400);

  return { name, workload, adapterId, uuids, wattsPerGpu, durationLimitSeconds };
}

export class BenchmarkServiceImpl implements BenchmarkServiceContract {
  private readonly powerReader: PowerReader;
  private readonly adapterRegistry: WorkloadAdapter[];
  private readonly store: BenchmarkRunStore;
  private readonly sampleIntervalMs: number;
  private readonly minimumCoveragePct: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly onStoreError: ((error: Error) => void) | undefined;

  private readonly live = new Map<string, LiveRun>();
  private finished: BenchmarkResult[] = [];
  private loaded: Promise<void> | null = null;

  constructor(options: BenchmarkServiceOptions) {
    this.powerReader = options.powerReader;
    this.adapterRegistry = options.adapters;
    this.store = options.store ?? createInMemoryBenchmarkStore();
    this.sampleIntervalMs = options.sampleIntervalMs ?? BENCHMARK_SAMPLE_INTERVAL_MS;
    this.minimumCoveragePct = options.minimumCoveragePct ?? MINIMUM_COVERAGE_PCT;
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? (() => randomUUID());
    this.onStoreError = options.onStoreError;
  }

  /** Lists the adapters and whether they can be used on this machine. */
  async adapters(): Promise<WorkloadAdapterInfo[]> {
    return Promise.all(
      this.adapterRegistry.map(async (adapter) => {
        try {
          const detection = await adapter.detect();
          return toAdapterInfo(adapter, detection);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return toAdapterInfo(adapter, {
            available: false,
            endpoint: null,
            hint: `Falha ao detectar o adaptador: ${message}`,
          });
        }
      }),
    );
  }

  /** Starts a run and returns immediately with the running result. */
  async start(config: BenchmarkRunConfig): Promise<BenchmarkResult> {
    const validated = validateBenchmarkConfig(config);
    const adapter = this.resolveAdapter(validated);

    const id = this.createId();
    const startedAt = this.now();
    const result: BenchmarkResult = {
      id,
      config: validated,
      startedAt,
      endedAt: null,
      status: 'running',
      durationSeconds: null,
      energy: null,
      throughput: null,
      samples: [],
    };

    const controller = new AbortController();
    const sampler = new PowerSampler(this.powerReader, {
      intervalMs: this.sampleIntervalMs,
      now: this.now,
      onSample: (measurement) => {
        result.samples.push(measurement);
      },
    });

    const live: LiveRun = {
      result,
      sampler,
      controller,
      timer: null,
      finalizing: false,
    };
    this.live.set(id, live);

    sampler.start();

    if (adapter) {
      await this.prepareAdapter(live, adapter);
      if (this.isLive(live)) {
        void this.runWorkload(live, adapter);
      }
    }

    if (this.isLive(live) && validated.durationLimitSeconds !== null) {
      live.timer = setTimeout(() => {
        void this.finalize(live, 'aborted', {
          code: ErrorCode.Timeout,
          message: `Duração máxima de ${validated.durationLimitSeconds} s atingida; a medição foi interrompida.`,
        });
      }, validated.durationLimitSeconds * 1000);
      const timer = live.timer as unknown as { unref?: () => void };
      if (timer && typeof timer.unref === 'function') timer.unref();
    }

    return { ...result, samples: [...result.samples] };
  }

  /** Stops a running run and finalises it. */
  async stop(runId: string): Promise<BenchmarkResult | null> {
    const live = this.live.get(runId);
    if (!live) {
      return this.run(runId);
    }
    const hasSamples = live.result.samples.some(
      (sample) => Object.keys(sample.powerW).length > 0,
    );
    // A workload driven by an adapter that never delivered a throughput never
    // finished: it was interrupted. Publishing it as "completed" would offer
    // an unfinished measurement to the optimiser as if it were a reference.
    //
    // A MANUAL measurement is the opposite case: it legitimately ends when the
    // user stops it, and it has no adapter at all.
    const interruptedAdapter =
      live.result.config.adapterId !== null && live.result.throughput === null;
    const status: BenchmarkStatus = interruptedAdapter
      ? 'aborted'
      : hasSamples
        ? 'completed'
        : 'aborted';
    return this.finalize(live, status);
  }

  /** Every run, the live ones first, newest first. */
  async runs(): Promise<BenchmarkResult[]> {
    await this.ensureLoaded();
    const running = [...this.live.values()].map((live) => live.result);
    return [...running, ...this.finished].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** A single run, live or finished. */
  async run(id: string): Promise<BenchmarkResult | null> {
    const live = this.live.get(id);
    if (live) return live.result;
    await this.ensureLoaded();
    return this.finished.find((result) => result.id === id) ?? null;
  }

  /** Energy measured so far by a running benchmark. */
  async samples(runId: string): Promise<EnergySummary | null> {
    const live = this.live.get(runId);
    if (live) {
      return energyFromMeasurements(live.result.samples, {
        // Only the GPUs the user selected take part in the measurement.
        uuids: live.result.config.uuids,
        expectedIntervalMs: this.sampleIntervalMs,
        durationMs: Math.max(0, this.now() - live.result.startedAt),
      });
    }
    const result = await this.run(runId);
    return result?.energy ?? null;
  }

  /** Finds the adapter of a configuration. Manual runs have no adapter. */
  private resolveAdapter(config: BenchmarkRunConfig): WorkloadAdapter | null {
    if (config.adapterId === null || config.workload === 'manual') return null;
    const adapter = this.adapterRegistry.find((candidate) => candidate.id === config.adapterId);
    if (!adapter) {
      throw new ValidationError(
        'adapterId',
        `Adaptador desconhecido: ${config.adapterId}. Escolha um adaptador disponível na lista.`,
      );
    }
    return adapter;
  }

  /** Detects the tool before running it, so failures are explicit. */
  private async prepareAdapter(live: LiveRun, adapter: WorkloadAdapter): Promise<void> {
    try {
      const detection = await adapter.detect();
      if (!detection.available) {
        await this.finalize(live, 'failed', {
          code: ErrorCode.AdapterUnavailable,
          message: detection.hint,
        });
      }
    } catch (error) {
      await this.finalize(live, 'failed', {
        code: ErrorCode.AdapterUnavailable,
        message: `Não foi possível verificar o adaptador "${adapter.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  /** Runs the workload and finalises the run when it ends. */
  private async runWorkload(live: LiveRun, adapter: WorkloadAdapter): Promise<void> {
    const ctx: WorkloadRunContext = {
      uuids: live.result.config.uuids,
      signal: live.controller.signal,
      durationLimitSeconds: live.result.config.durationLimitSeconds,
    };

    try {
      const throughput: ThroughputResult = await adapter.run(ctx);
      if (!this.isLive(live)) return;
      live.result.throughput = throughput;
      await this.finalize(live, 'completed');
    } catch (error) {
      if (!this.isLive(live)) return;
      await this.finalize(live, 'failed', toAppError(error));
    }
  }

  /** Finalises a run: stops the sampler, integrates the energy, persists it. */
  private async finalize(
    live: LiveRun,
    status: BenchmarkStatus,
    error?: AppError,
  ): Promise<BenchmarkResult> {
    if (!this.isLive(live) || live.finalizing) return live.result;
    live.finalizing = true;

    live.sampler.stop();
    // One last reading, so the measured window covers the end of the run and
    // not only the last periodic tick.
    await live.sampler.sampleOnce();
    live.controller.abort();
    if (live.timer !== null) clearTimeout(live.timer);

    const result = live.result;
    result.endedAt = this.now();
    result.durationSeconds = Math.max(0, (result.endedAt - result.startedAt) / 1000);
    const durationMs = Math.max(0, result.endedAt - result.startedAt);

    // The limit the driver really had configured during the run, and the
    // verdict about the requested label. The benchmark only READS the driver.
    const verdict = this.buildLimitVerdict(
      result.config.uuids,
      result.config.wattsPerGpu,
      result.samples,
    );
    result.observedLimitsW = verdict.observed;
    result.limitVerified = verdict.verified;

    // The energy is integrated for the GPUs the user selected, and the
    // coverage tells how much of the run the readings really covered.
    result.energy = energyFromMeasurements(result.samples, {
      uuids: result.config.uuids,
      expectedIntervalMs: this.sampleIntervalMs,
      durationMs,
    });
    result.measuredMs = result.energy.measuredMs ?? null;
    result.coveragePct = result.energy.coveragePct ?? null;

    // A run whose driver only answered part of the time does NOT describe the
    // energy of the whole workload: the unmeasured window would be rendered
    // as zero joules. Such a run is published as partial, never as complete.
    const coveragePct = result.coveragePct;
    const coverageComplete =
      coveragePct !== null && coveragePct >= this.minimumCoveragePct;
    let finalStatus = status;
    if (status === 'completed' && !coverageComplete) {
      finalStatus = 'partial';
      result.error = {
        code: ErrorCode.MeasurementIncomplete,
        message:
          `A medição cobriu apenas ${formatCoveragePct(coveragePct)} da execução ` +
          `(mínimo de ${formatCoveragePct(this.minimumCoveragePct)}): o restante do tempo ` +
          'não foi medido, então os joules não descrevem o workload inteiro.',
      };
    }
    result.status = finalStatus;
    if (error) result.error = error;

    // The history must be loaded before saving, otherwise the file on disk
    // would be overwritten with only the run that just finished.
    await this.ensureLoaded();
    this.finished.unshift(result);
    if (this.finished.length > MAX_STORED_RUNS) {
      this.finished = this.finished.slice(0, MAX_STORED_RUNS);
    }
    // The run leaves the live map only when it is already in the history: a
    // reader never sees a run that is neither live nor finished.
    this.live.delete(live.result.id);
    try {
      await this.store.save(this.finished);
    } catch (storeError) {
      if (this.onStoreError) {
        this.onStoreError(
          storeError instanceof Error ? storeError : new Error(String(storeError)),
        );
      }
    }

    return result;
  }

  /**
   * Reads the power limit the driver really reports, from the readings of the
   * run itself.
   *
   * The benchmark NEVER writes to the driver: it only observes what is
   * configured. The first and the last reading of the run are the start and
   * the end of the observation, and every reading in between must agree with
   * them: a limit that changed during the run invalidates the label.
   *
   * A limit that could not be read stays `null`: unknown is not the same as
   * zero, and it is never trusted silently.
   */
  private buildLimitVerdict(
    uuids: readonly string[],
    requested: Record<string, number>,
    samples: readonly BenchmarkMeasurement[],
  ): { observed: Record<string, number | null>; verified: boolean | null } {
    const observed: Record<string, number | null> = {};
    let anyObserved = false;
    let allVerified = true;

    for (const uuid of uuids) {
      const target = requested[uuid];
      const limits: number[] = [];
      for (const sample of samples) {
        const limit = sample.powerLimitW?.[uuid];
        if (typeof limit === 'number' && Number.isFinite(limit)) limits.push(limit);
      }

      // The limit at the start of the run and the limit at the end of it.
      const startLimit = limits.length > 0 ? limits[0] : null;
      const endLimit = limits.length > 0 ? limits[limits.length - 1] : null;
      // A reading that reported another limit breaks the verification: the
      // run was NOT executed at the requested limit for the whole time.
      const mismatch = limits.some((limit) => limit !== target);

      const value = startLimit ?? endLimit;
      observed[uuid] = value;
      if (value !== null) anyObserved = true;

      const verified =
        typeof target === 'number' &&
        startLimit !== null &&
        endLimit !== null &&
        startLimit === target &&
        endLimit === target &&
        !mismatch;
      if (!verified) allVerified = false;
    }

    // Nothing could be observed: the limit is unknown, not wrong. The
    // distinction matters: unknown is never trusted, but it is not a mismatch
    // either.
    return { observed, verified: anyObserved ? allVerified : null };
  }

  private isLive(live: LiveRun): boolean {
    return this.live.get(live.result.id) === live;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          this.finished = await this.store.load();
        } catch {
          this.finished = [];
        }
      })();
    }
    await this.loaded;
  }
}

/** Converts an adapter failure into a user facing error. */
function toAppError(error: unknown): AppError {
  if (error instanceof AdapterError) {
    return { code: error.code, message: error.message };
  }
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const candidate = error as { code: unknown; message: unknown };
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return { code: candidate.code, message: candidate.message };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: ErrorCode.BenchmarkFailed, message: `Falha no benchmark: ${message}` };
}

/** Formats a coverage percentage for the user, in Brazilian Portuguese. */
function formatCoveragePct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'uma parte desconhecida';
  return `${value.toLocaleString('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}
