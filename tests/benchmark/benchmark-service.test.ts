import { describe, expect, it } from 'vitest';
import { BenchmarkServiceImpl } from '../../src/main/benchmark/benchmark-service';
import { createInMemoryBenchmarkStore } from '../../src/main/benchmark/benchmark-store';
import { AdapterError, type WorkloadAdapter } from '../../src/main/benchmark/adapters/types';
import type { PowerReader, PowerReading } from '../../src/main/benchmark/power-sampler';
import { ErrorCode, type BenchmarkRunConfig } from '../../src/shared/types';

const GPU_A = 'GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1';
const GPU_B = 'GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646';

const SAMPLE_INTERVAL_MS = 20;

/**
 * Number of readings a real workload produces.
 *
 * The coverage of a run is the measured window over the duration of the run.
 * The first reading always arrives after the latency of the driver, so a run
 * that is too short can never be completely measured: the tests use a
 * realistic number of readings.
 */
const REALISTIC_SAMPLES = 10;

function manualConfig(overrides: Partial<BenchmarkRunConfig> = {}): BenchmarkRunConfig {
  return {
    name: 'Carga manual',
    workload: 'manual',
    adapterId: null,
    uuids: [GPU_A],
    wattsPerGpu: { [GPU_A]: 200 },
    durationLimitSeconds: null,
    ...overrides,
  };
}

/** Waits until the condition is satisfied or the timeout expires. */
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error('Tempo esgotado aguardando a condição.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface ReaderOptions {
  /** Power of the selected GPU, watts. */
  watts?: number;
  /** Power limit the driver really reports, watts. Null when it is unknown. */
  limitW?: number | null;
  /** Temperature the driver really reports, °C. */
  temperatureC?: number | null;
  /** A second GPU that is visible in the driver but was not selected. */
  otherGpu?: { uuid: string; watts: number };
  /** Fails the readings whose number satisfies the predicate. */
  failWhen?: (readNumber: number) => boolean;
}

/** A power reader with a controlled clock: every read advances by one sample. */
function createReader(options: ReaderOptions = {}): {
  reader: PowerReader;
  clock: () => number;
  reads: () => number;
} {
  let clock = 0;
  let reads = 0;
  const reader = async (): Promise<PowerReading[]> => {
    reads += 1;
    clock += SAMPLE_INTERVAL_MS;
    if (options.failWhen?.(reads)) {
      throw new Error('falha na leitura do driver');
    }
    const readings: PowerReading[] = [
      {
        uuid: GPU_A,
        watts: options.watts ?? 100,
        temperatureC: options.temperatureC ?? null,
        limitW: options.limitW === undefined ? null : options.limitW,
      },
    ];
    if (options.otherGpu) {
      readings.push({
        uuid: options.otherGpu.uuid,
        watts: options.otherGpu.watts,
        temperatureC: null,
        limitW: null,
      });
    }
    return readings;
  };
  return { reader, clock: () => clock, reads: () => reads };
}

/** Waits until the run collected the given number of readings. */
async function waitForSamples(
  service: BenchmarkServiceImpl,
  runId: string,
  count: number,
): Promise<void> {
  await waitFor(async () => {
    const run = await service.run(runId);
    return (run?.samples.length ?? 0) >= count;
  });
}

describe('BenchmarkServiceImpl', () => {
  it('measures the energy of a full run with the injected power provider', async () => {
    const { reader, clock } = createReader({ watts: 100 });
    const store = createInMemoryBenchmarkStore();
    const service = new BenchmarkServiceImpl({
      powerReader: reader,
      adapters: [],
      store,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      now: () => clock(),
      createId: () => 'run-1',
    });

    const started = await service.start(manualConfig());
    expect(started.status).toBe('running');
    expect(started.id).toBe('run-1');

    await waitForSamples(service, 'run-1', REALISTIC_SAMPLES);

    const stopped = await service.stop('run-1');
    expect(stopped).not.toBeNull();
    expect(stopped?.status).toBe('completed');
    expect(stopped?.samples.length).toBeGreaterThanOrEqual(REALISTIC_SAMPLES);

    // Every measured second of the series is a trapezoid of 100 W:
    // 0.5 * (100 + 100) * 0.02 s = 2 J per interval.
    const intervals = (stopped?.samples.length ?? 0) - 1;
    expect(stopped?.energy?.joulesTotal).toBeCloseTo(intervals * 2, 4);
    expect(stopped?.energy?.perGpu[GPU_A].avgPowerW).toBeCloseTo(100, 4);
    expect(stopped?.durationSeconds).toBeGreaterThan(0);

    const persisted = await store.load();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe('run-1');
  });

  it('exposes the window that was really measured and the coverage of the run', async () => {
    const { reader, clock } = createReader({ watts: 100 });
    const service = new BenchmarkServiceImpl({
      powerReader: reader,
      adapters: [],
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      now: () => clock(),
      createId: () => 'run-coverage',
    });

    await service.start(manualConfig());
    await waitForSamples(service, 'run-coverage', REALISTIC_SAMPLES);
    const stopped = await service.stop('run-coverage');

    const measuredMs = stopped?.measuredMs ?? 0;
    expect(measuredMs).toBeGreaterThan(0);
    expect(stopped?.energy?.measuredMs).toBe(measuredMs);
    expect(stopped?.coveragePct).toBeCloseTo(stopped?.energy?.coveragePct ?? 0, 2);
    expect(stopped?.coveragePct).toBeGreaterThan(80);
    expect(stopped?.energy?.perGpu[GPU_A].coveragePct).toBeCloseTo(
      stopped?.coveragePct ?? 0,
      2,
    );
  });

  it('publishes a partially measured run as partial, never as complete', async () => {
    // The driver only answers half of the times, in bursts: the gaps break
    // the series, so the unmeasured window would be rendered as zero joules
    // and the run cannot be published as complete.
    const { reader, clock } = createReader({
      watts: 100,
      failWhen: (read) => read % 4 >= 2,
    });
    const service = new BenchmarkServiceImpl({
      powerReader: reader,
      adapters: [],
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      now: () => clock(),
      createId: () => 'run-partial',
    });

    await service.start(manualConfig());
    await waitFor(async () => {
      const run = await service.run('run-partial');
      return (run?.samples.length ?? 0) >= 10;
    });
    const stopped = await service.stop('run-partial');

    expect(stopped?.status).toBe('partial');
    expect(stopped?.status).not.toBe('completed');
    expect(stopped?.coveragePct).not.toBeNull();
    expect(stopped?.coveragePct ?? 100).toBeLessThan(80);
    expect(stopped?.error?.code).toBe(ErrorCode.MeasurementIncomplete);
    expect(stopped?.error?.message).toMatch(/não foi medido/i);
  });

  it('integrates only the GPUs the user selected', async () => {
    // The 5060 Ti is selected; the 4070 Ti is merely visible in the driver.
    const { reader, clock } = createReader({ watts: 100, otherGpu: { uuid: GPU_B, watts: 50 } });
    const service = new BenchmarkServiceImpl({
      powerReader: reader,
      adapters: [],
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      now: () => clock(),
      createId: () => 'run-scope',
    });

    await service.start(manualConfig());
    await waitForSamples(service, 'run-scope', REALISTIC_SAMPLES);
    const stopped = await service.stop('run-scope');

    expect(Object.keys(stopped?.energy?.perGpu ?? {})).toEqual([GPU_A]);
    // The total is the energy of the selected GPU, not of the machine.
    expect(stopped?.energy?.joulesTotal).toBeCloseTo(
      stopped?.energy?.perGpu[GPU_A].joules ?? 0,
      4,
    );
  });

  it('carries the temperature the driver reported', async () => {
    const { reader, clock } = createReader({ watts: 100, temperatureC: 61 });
    const service = new BenchmarkServiceImpl({
      powerReader: reader,
      adapters: [],
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      now: () => clock(),
      createId: () => 'run-temp',
    });

    await service.start(manualConfig());
    await waitForSamples(service, 'run-temp', REALISTIC_SAMPLES);
    const stopped = await service.stop('run-temp');

    expect(stopped?.energy?.perGpu[GPU_A].avgTemperatureC).toBeCloseTo(61, 2);
    expect(stopped?.energy?.perGpu[GPU_A].maxTemperatureC).toBeCloseTo(61, 2);
    expect(stopped?.energy?.avgTemperatureC).toBeCloseTo(61, 2);
    expect(stopped?.energy?.maxTemperatureC).toBeCloseTo(61, 2);
  });

  it('reports no temperature, never zero, when the driver reports none', async () => {
    const { reader, clock } = createReader({ watts: 100 });
    const service = new BenchmarkServiceImpl({
      powerReader: reader,
      adapters: [],
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      now: () => clock(),
      createId: () => 'run-no-temp',
    });

    await service.start(manualConfig());
    await waitForSamples(service, 'run-no-temp', REALISTIC_SAMPLES);
    const stopped = await service.stop('run-no-temp');

    expect(stopped?.energy?.perGpu[GPU_A].avgTemperatureC).toBeNull();
    expect(stopped?.energy?.perGpu[GPU_A].maxTemperatureC).toBeNull();
    expect(stopped?.energy?.avgTemperatureC).toBeNull();
    expect(stopped?.energy?.maxTemperatureC).toBeNull();
  });

  it('verifies the limit the driver really had configured', async () => {
    const { reader, clock } = createReader({ watts: 100, limitW: 200 });
    const service = new BenchmarkServiceImpl({
      powerReader: reader,
      adapters: [],
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      now: () => clock(),
      createId: () => 'run-verified',
    });

    await service.start(manualConfig());
    await waitForSamples(service, 'run-verified', REALISTIC_SAMPLES);
    const stopped = await service.stop('run-verified');

    // The requested limit was really the one configured in the driver.
    expect(stopped?.limitVerified).toBe(true);
    expect(stopped?.observedLimitsW?.[GPU_A]).toBe(200);
  });

  it('marks the run as unverified when the driver had another limit', async () => {
    // The user asked for 200 W, but the driver was still at 285 W: the run
    // says nothing about 200 W.
    const { reader, clock } = createReader({ watts: 100, limitW: 285 });
    const service = new BenchmarkServiceImpl({
      powerReader: reader,
      adapters: [],
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      now: () => clock(),
      createId: () => 'run-unverified',
    });

    await service.start(manualConfig());
    await waitForSamples(service, 'run-unverified', REALISTIC_SAMPLES);
    const stopped = await service.stop('run-unverified');

    expect(stopped?.limitVerified).toBe(false);
    expect(stopped?.observedLimitsW?.[GPU_A]).toBe(285);
  });

  it('marks the run as unverified when the driver does not report the limit', async () => {
    const { reader, clock } = createReader({ watts: 100, limitW: null });
    const service = new BenchmarkServiceImpl({
      powerReader: reader,
      adapters: [],
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      now: () => clock(),
      createId: () => 'run-unknown-limit',
    });

    await service.start(manualConfig());
    await waitForSamples(service, 'run-unknown-limit', REALISTIC_SAMPLES);
    const stopped = await service.stop('run-unknown-limit');

    // Unknown is not the same as wrong, but it is never trusted either.
    expect(stopped?.limitVerified).toBeNull();
    expect(stopped?.observedLimitsW?.[GPU_A]).toBeNull();
  });

  it('reports the live energy while the run is running', async () => {
    const { reader, clock } = createReader({ watts: 50 });
    const service = new BenchmarkServiceImpl({
      powerReader: reader,
      adapters: [],
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      now: () => clock(),
      createId: () => 'run-live',
    });

    await service.start(manualConfig());
    await waitFor(async () => {
      const live = await service.samples('run-live');
      return live !== null && live.joulesTotal > 0;
    });

    const live = await service.samples('run-live');
    expect(live?.joulesTotal).toBeGreaterThan(0);
    expect(live?.perGpu[GPU_A]).toBeDefined();
    expect(live?.coveragePct).not.toBeNull();

    await service.stop('run-live');
  });

  it('marks the run as failed when the adapter fails', async () => {
    const failingAdapter: WorkloadAdapter = {
      id: 'failing',
      name: 'Adaptador que falha',
      workload: 'llm-inference',
      detect: async () => ({ available: true, endpoint: null, hint: 'disponível' }),
      run: async () => {
        throw new AdapterError(
          ErrorCode.BenchmarkFailed,
          'O servidor respondeu com um resultado inválido.',
        );
      },
    };

    const { reader, clock } = createReader({ watts: 100 });
    const service = new BenchmarkServiceImpl({
      powerReader: reader,
      adapters: [failingAdapter],
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      now: () => clock(),
      createId: () => 'run-fail',
    });

    await service.start(
      manualConfig({ workload: 'llm-inference', adapterId: 'failing' }),
    );

    await waitFor(async () => {
      const run = await service.run('run-fail');
      return run?.status === 'failed';
    });

    const run = await service.run('run-fail');
    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toBe('O servidor respondeu com um resultado inválido.');
    expect(run?.error?.code).toBe(ErrorCode.BenchmarkFailed);
    expect(run?.throughput).toBeNull();
  });

  it('finalises a stopped run without samples as aborted', async () => {
    const service = new BenchmarkServiceImpl({
      powerReader: async () => [],
      adapters: [],
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      createId: () => 'run-abort',
    });

    await service.start(manualConfig());
    const stopped = await service.stop('run-abort');

    expect(stopped?.status).toBe('aborted');
    expect(stopped?.energy?.joulesTotal).toBe(0);
  });

  it('stores the throughput reported by the adapter', async () => {
    const { reader, clock } = createReader({ watts: 100 });
    const adapter: WorkloadAdapter = {
      id: 'fast',
      name: 'Adaptador rápido',
      workload: 'llm-inference',
      detect: async () => ({ available: true, endpoint: null, hint: 'disponível' }),
      run: async () => {
        // The workload lasts long enough for the measurement to cover it.
        await waitFor(() => clock() >= REALISTIC_SAMPLES * SAMPLE_INTERVAL_MS);
        return {
          unit: 'token',
          count: 100,
          label: 'tokens gerados',
          source: 'teste',
          perSecond: 42,
        };
      },
    };

    const service = new BenchmarkServiceImpl({
      powerReader: reader,
      adapters: [adapter],
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      now: () => clock(),
      createId: () => 'run-ok',
    });

    await service.start(manualConfig({ workload: 'llm-inference', adapterId: 'fast' }));
    await waitFor(async () => {
      const run = await service.run('run-ok');
      return run?.status === 'completed';
    });

    const run = await service.run('run-ok');
    expect(run?.status).toBe('completed');
    expect(run?.throughput?.count).toBe(100);
    expect(run?.throughput?.source).toBe('teste');
  });

  it('rejects an invalid configuration', async () => {
    const service = new BenchmarkServiceImpl({
      powerReader: async () => [],
      adapters: [],
    });

    await expect(
      service.start(manualConfig({ uuids: ['not-a-uuid'] })),
    ).rejects.toThrow(/GPU inválido|inválido/i);

    await expect(
      service.start(manualConfig({ wattsPerGpu: { [GPU_A]: 99999 } })),
    ).rejects.toThrow(/limite de potência/i);

    await expect(service.start(manualConfig({ uuids: [] }))).rejects.toThrow(/ao menos uma GPU/i);

    await expect(
      service.start(manualConfig({ durationLimitSeconds: 0 })),
    ).rejects.toThrow(/entre 1 e 86400/i);
  });

  it('rejects an unknown adapter', async () => {
    const service = new BenchmarkServiceImpl({
      powerReader: async () => [],
      adapters: [],
    });

    await expect(
      service.start(manualConfig({ workload: 'llm-inference', adapterId: 'ghost' })),
    ).rejects.toThrow(/Adaptador desconhecido/i);
  });

  it('lists the adapters with their availability', async () => {
    const adapter: WorkloadAdapter = {
      id: 'available',
      name: 'Disponível',
      workload: 'llm-inference',
      detect: async () => ({ available: true, endpoint: 'http://127.0.0.1:1', hint: 'ok' }),
      run: async () => ({ unit: 'token', count: 1, label: 'x', source: 'y' }),
    };
    const broken: WorkloadAdapter = {
      id: 'broken',
      name: 'Quebrado',
      workload: 'llm-inference',
      detect: async () => {
        throw new Error('detecção explodiu');
      },
      run: async () => ({ unit: 'token', count: 1, label: 'x', source: 'y' }),
    };

    const service = new BenchmarkServiceImpl({
      powerReader: async () => [],
      adapters: [adapter, broken],
    });

    const infos = await service.adapters();
    expect(infos).toHaveLength(2);
    expect(infos[0].available).toBe(true);
    expect(infos[0].endpoint).toBe('http://127.0.0.1:1');
    expect(infos[1].available).toBe(false);
    expect(infos[1].detectionHint).toMatch(/Falha ao detectar/i);
  });

  it('keeps the persisted history when a run finishes before any listing', async () => {
    const previous = {
      id: 'old-run',
      config: manualConfig(),
      startedAt: 1,
      endedAt: 2,
      status: 'completed' as const,
      durationSeconds: 1,
      energy: null,
      throughput: null,
      samples: [],
    };

    const store = createInMemoryBenchmarkStore([previous]);
    const { reader, clock } = createReader({ watts: 100 });
    const service = new BenchmarkServiceImpl({
      powerReader: reader,
      adapters: [],
      store,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      now: () => clock(),
      createId: () => 'run-new',
    });

    await service.start(manualConfig());
    await waitForSamples(service, 'run-new', REALISTIC_SAMPLES);
    await service.stop('run-new');

    const persisted = await store.load();
    expect(persisted.map((run) => run.id)).toContain('old-run');
    expect(persisted.map((run) => run.id)).toContain('run-new');
  });

  it('measures several GPUs of the same run', async () => {
    let clock = 0;
    const service = new BenchmarkServiceImpl({
      powerReader: async () => {
        clock += SAMPLE_INTERVAL_MS;
        return [
          { uuid: GPU_A, watts: 100 },
          { uuid: GPU_B, watts: 50 },
        ];
      },
      adapters: [],
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      now: () => clock,
      createId: () => 'run-multi',
    });

    await service.start(
      manualConfig({ uuids: [GPU_A, GPU_B], wattsPerGpu: { [GPU_A]: 200, [GPU_B]: 150 } }),
    );
    await waitForSamples(service, 'run-multi', REALISTIC_SAMPLES);

    const stopped = await service.stop('run-multi');
    const intervals = (stopped?.samples.length ?? 0) - 1;
    expect(stopped?.energy?.perGpu[GPU_A].joules).toBeCloseTo(intervals * 2, 4);
    expect(stopped?.energy?.perGpu[GPU_B].joules).toBeCloseTo(intervals * 1, 4);
    expect(stopped?.energy?.joulesTotal).toBeCloseTo(intervals * 3, 4);
  });
});
