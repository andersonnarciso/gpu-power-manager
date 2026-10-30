import { describe, expect, it } from 'vitest';
import {
  OptimizerServiceImpl,
  throughputMetric,
} from '../../src/main/optimizer/optimizer-service';
import type { BenchmarkResult, ThroughputResult } from '../../src/shared/types';

const GPU_A = 'GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1';

interface RunOptions {
  id: string;
  watts: number;
  joules: number;
  /** Measured rate. Null means the workload could not report a rate. */
  perSecond?: number | null;
  /** True when the workload reported what it produced, even without a rate. */
  reported?: boolean;
  count?: number;
  workload?: BenchmarkResult['config']['workload'];
  uuid?: string;
  /** Adapter that produced the run. Runs of different adapters never compare. */
  adapterId?: string | null;
  /** Status of the run. Only a completed run is comparable. */
  status?: BenchmarkResult['status'];
  /** Fraction of the run that was really measured, in percent. */
  coveragePct?: number | null;
  /**
   * Whether the power limit the driver really had configured matched the
   * target. Null means the limit could not be observed at all.
   */
  limitVerified?: boolean | null;
  /** The limit the driver really reported, watts. */
  observedLimitW?: number | null;
}

function makeRun(options: RunOptions): BenchmarkResult {
  const uuid = options.uuid ?? GPU_A;
  const throughput: ThroughputResult | null =
    options.reported === true
      ? {
          unit: 'token',
          count: options.count ?? 100,
          label: 'tokens gerados',
          source: 'teste',
          perSecond: options.perSecond ?? null,
        }
      : options.perSecond === null || options.perSecond === undefined
        ? null
        : {
            unit: 'token',
            count: options.count ?? 100,
            label: 'tokens gerados',
            source: 'teste',
            perSecond: options.perSecond,
          };

  const limitVerified = options.limitVerified === undefined ? true : options.limitVerified;
  const observedLimitW =
    options.observedLimitW === undefined ? options.watts : options.observedLimitW;
  const coveragePct = options.coveragePct === undefined ? 100 : options.coveragePct;

  return {
    id: options.id,
    config: {
      name: `Medição em ${options.watts} W`,
      workload: options.workload ?? 'llm-inference',
      adapterId: options.adapterId === undefined ? 'ollama' : options.adapterId,
      uuids: [uuid],
      wattsPerGpu: { [uuid]: options.watts },
      durationLimitSeconds: null,
    },
    startedAt: Date.now(),
    endedAt: Date.now() + 30_000,
    status: options.status ?? 'completed',
    durationSeconds: 30,
    energy: {
      joulesTotal: options.joules,
      wattHoursTotal: options.joules / 3600,
      measuredMs: 30_000,
      coveragePct,
      sampleIntervalMs: 200,
      perGpu: {
        [uuid]: {
          joules: options.joules,
          wattHours: options.joules / 3600,
          avgPowerW: options.joules / 30,
          peakPowerW: options.joules / 30,
          measuredMs: 30_000,
          coveragePct,
        },
      },
    },
    measuredMs: 30_000,
    coveragePct,
    limitVerified,
    observedLimitsW: { [uuid]: observedLimitW },
    throughput,
    samples: [],
  };
}

function createService(runs: BenchmarkResult[]): OptimizerServiceImpl {
  return new OptimizerServiceImpl({
    runs: {
      list: async () => runs,
    },
  });
}

const BASELINE = makeRun({ id: 'base', watts: 285, joules: 1000, perSecond: 100 });
const CANDIDATE_250 = makeRun({ id: 'c250', watts: 250, joules: 900, perSecond: 97 });
const CANDIDATE_200 = makeRun({ id: 'c200', watts: 200, joules: 800, perSecond: 88 });
const CANDIDATE_180 = makeRun({ id: 'c180', watts: 180, joules: 700, perSecond: null });

describe('OptimizerServiceImpl', () => {
  it('recommends the cheapest candidate that respects the performance budget', async () => {
    const service = createService([BASELINE, CANDIDATE_250, CANDIDATE_200, CANDIDATE_180]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [250, 200, 180],
      maxPerformanceLossPct: 5,
      baselineRunId: 'base',
    });

    const recommended = recommendations[0];
    expect(recommended.watts).toBe(250);
    expect(recommended.meetsConstraint).toBe(true);
    expect(recommended.performanceDeltaPct).toBeCloseTo(-3, 6);
    expect(recommended.energyDeltaPct).toBeCloseTo(-10, 6);
    expect(recommended.baselineWatts).toBe(285);
    expect(recommended.reason).toMatch(/250 W/);
    expect(recommended.reason).toMatch(/10,0%/);
  });

  it('excludes a candidate that loses more than the budget', async () => {
    const service = createService([BASELINE, CANDIDATE_250, CANDIDATE_200]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [250, 200],
      maxPerformanceLossPct: 5,
      baselineRunId: 'base',
    });

    const candidate200 = recommendations.find((item) => item.watts === 200);
    expect(candidate200).toBeDefined();
    expect(candidate200?.meetsConstraint).toBe(false);
    expect(candidate200?.performanceDeltaPct).toBeCloseTo(-12, 6);
    expect(candidate200?.reason).toMatch(/12,0%/);
    expect(recommendations[0].watts).toBe(250);
  });

  it('falls back honestly when NO candidate qualifies, even when the reference is in the range', async () => {
    // Regression: the reference used to be evaluated as a candidate against
    // itself, which yields a 0 % delta and always satisfied the constraint.
    // The "nothing qualified" branch was therefore unreachable, and the user
    // was shown a green recommendation that saved nothing.
    const baseline = makeRun({ id: 'base', watts: 180, joules: 1200, perSecond: 100 });
    // The only real candidate loses 50 % of the throughput: far outside a 10 %
    // budget.
    const tooSlow = makeRun({ id: 'slow', watts: 150, joules: 400, perSecond: 50 });
    const service = createService([baseline, tooSlow]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      // The default flow seeds the range with the measured watts of every
      // comparable run, which INCLUDES the reference's own watts.
      candidateWatts: [150, 180],
      maxPerformanceLossPct: 10,
      baselineRunId: 'base',
    });

    const recommended = recommendations[0];
    expect(recommended.fallback).toBe(true);
    expect(recommended.watts).toBe(180);
    expect(recommended.meetsConstraint).toBe(true);
    // The deltas of the reference against itself are not a saving.
    expect(recommended.energyDeltaPct).toBeCloseTo(0, 6);
    expect(recommended.reason).toMatch(/Nenhum limite candidato cumpre/);
    expect(recommended.reason).not.toMatch(/Recomendado:/);

    // The candidate that failed the budget is still listed, with the real
    // reason and without being presented as an answer.
    const rejected = recommendations.find((item) => item.watts === 150);
    expect(rejected).toBeDefined();
    expect(rejected?.meetsConstraint).toBe(false);
    expect(rejected?.fallback).toBeUndefined();
  });

  it('recommends the candidate with the lowest measured energy', async () => {
    // Both candidates are inside the budget: the ranking is decided by the
    // energy that was really measured, never by the order of the list.
    const service = createService([BASELINE, CANDIDATE_250, CANDIDATE_200]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [250, 200],
      maxPerformanceLossPct: 20,
      baselineRunId: 'base',
    });

    // 200 W measured 800 J, less than the 900 J of the 250 W candidate.
    expect(recommendations[0].watts).toBe(200);
    expect(recommendations[0].energyDeltaPct).toBeCloseTo(-20, 6);
    expect(recommendations[0].reason).toMatch(/200 W/);
  });

  it('never accepts a candidate whose throughput is unknown', async () => {
    const service = createService([BASELINE, CANDIDATE_180]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [180],
      maxPerformanceLossPct: 5,
      baselineRunId: 'base',
    });

    const candidate180 = recommendations.find((item) => item.watts === 180);
    expect(candidate180?.meetsConstraint).toBe(false);
    expect(candidate180?.performanceDeltaPct).toBeNull();
    expect(candidate180?.reason).toMatch(/throughput/i);

    // The baseline is recommended instead, with the explanation.
    expect(recommendations[0].watts).toBe(285);
    expect(recommendations[0].reason).toMatch(/Nenhum limite candidato/i);
  });

  it('reports that measurements are required when there is no measured run', async () => {
    const service = createService([]);

    await expect(
      service.recommend({
        uuid: GPU_A,
        workload: 'llm-inference',
        candidateWatts: [250],
        maxPerformanceLossPct: 5,
        baselineRunId: null,
      }),
    ).rejects.toThrow(/medição|benchmark/i);
  });

  it('reports a candidate that was never measured without inventing numbers', async () => {
    const service = createService([BASELINE, CANDIDATE_250]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [250, 220],
      maxPerformanceLossPct: 5,
      baselineRunId: 'base',
    });

    const candidate220 = recommendations.find((item) => item.watts === 220);
    expect(candidate220).toBeDefined();
    expect(candidate220?.meetsConstraint).toBe(false);
    expect(candidate220?.energyDeltaPct).toBeNull();
    expect(candidate220?.performanceDeltaPct).toBeNull();
    expect(candidate220?.reason).toMatch(/Sem medição/i);
  });

  it('uses the highest measured limit as the baseline when none is given', async () => {
    const service = createService([BASELINE, CANDIDATE_250]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [250],
      maxPerformanceLossPct: 5,
      baselineRunId: null,
    });

    expect(recommendations[0].baselineWatts).toBe(285);
    expect(recommendations[0].energyDeltaPct).toBeCloseTo(-10, 6);
  });

  it('ignores runs of another workload or another GPU', async () => {
    const otherWorkload = makeRun({
      id: 'other',
      watts: 240,
      joules: 100,
      perSecond: 100,
      workload: 'image-generation',
    });
    const otherGpu = makeRun({
      id: 'other-gpu',
      watts: 240,
      joules: 100,
      perSecond: 100,
      uuid: 'GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646',
    });

    const service = createService([BASELINE, otherWorkload, otherGpu]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [240],
      maxPerformanceLossPct: 5,
      baselineRunId: 'base',
    });

    const candidate240 = recommendations.find((item) => item.watts === 240);
    expect(candidate240?.meetsConstraint).toBe(false);
    expect(candidate240?.reason).toMatch(/Sem medição/i);
  });

  it('rejects an invalid request', async () => {
    const service = createService([BASELINE]);

    await expect(
      service.recommend({
        uuid: 'not-a-uuid',
        workload: 'llm-inference',
        candidateWatts: [250],
        maxPerformanceLossPct: 5,
        baselineRunId: null,
      }),
    ).rejects.toThrow(/GPU inválido/i);

    await expect(
      service.recommend({
        uuid: GPU_A,
        workload: 'llm-inference',
        candidateWatts: [],
        maxPerformanceLossPct: 5,
        baselineRunId: null,
      }),
    ).rejects.toThrow(/ao menos um/i);
  });
});

describe('the optimiser and the unmeasured energy', () => {
  it('never ranks a candidate whose energy was not measured', async () => {
    const zero = makeRun({ id: 'zero', watts: 180, joules: 0, perSecond: 100 });
    const service = createService([BASELINE, zero]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [285, 180],
      maxPerformanceLossPct: 5,
      baselineRunId: 'base',
    });

    const candidate180 = recommendations.find((item) => item.watts === 180);
    // The energy of the candidate was not measured, so it cannot be compared:
    // the delta stays null and the reason says why.
    expect(candidate180?.energyDeltaPct).toBeNull();
    expect(candidate180?.reason).toMatch(/energia não medida/i);

    // The recommendation is the measured reference, never the limit whose
    // energy could not be measured.
    expect(recommendations[0].watts).toBe(285);
    expect(recommendations[0].energyDeltaPct).toBe(0);
  });

  it('does not recommend the highest limit when every candidate measured zero', async () => {
    const base = makeRun({ id: 'base', watts: 285, joules: 0, perSecond: 100 });
    const high = makeRun({ id: 'high', watts: 285, joules: 0, perSecond: 100 });
    const low = makeRun({ id: 'low', watts: 180, joules: 0, perSecond: 100 });
    const service = createService([base, high, low]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [285, 180],
      maxPerformanceLossPct: 5,
      baselineRunId: 'base',
    });

    expect(recommendations[0].watts).toBe(285);
    expect(recommendations[0].energyDeltaPct).toBeNull();
    expect(recommendations[0].reason).toMatch(/não pôde ser medida/i);
    expect(recommendations[0].reason).not.toMatch(/0,0 J/);
  });

  it('reports a null energy delta when the baseline energy is unknown', async () => {
    const base = makeRun({ id: 'base', watts: 285, joules: 0, perSecond: 100 });
    const candidate = makeRun({ id: 'c', watts: 250, joules: 0, perSecond: 100 });
    const service = createService([base, candidate]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [250],
      maxPerformanceLossPct: 5,
      baselineRunId: 'base',
    });

    expect(recommendations[0].energyDeltaPct).toBeNull();
    expect(recommendations[0].reason).toMatch(/energia não medida/i);
  });

  it('derives the performance delta of the fallback from the real measurement', async () => {
    // The fallback is the reference itself: the delta comes from the measured
    // rate, and it stays null when there is no measurable throughput.
    const base = makeRun({ id: 'base', watts: 285, joules: 0, perSecond: 100 });
    const service = createService([base]);

    const withRate = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [250],
      maxPerformanceLossPct: 5,
      baselineRunId: 'base',
    });

    expect(withRate[0].performanceDeltaPct).toBe(0);

    // The workload reported what it produced, but without a measurable rate:
    // the delta stays null instead of being invented.
    const withoutRate = makeRun({
      id: 'base',
      watts: 285,
      joules: 0,
      perSecond: null,
      reported: true,
    });
    const other = createService([withoutRate]);

    const result = await other.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [250],
      maxPerformanceLossPct: 5,
      baselineRunId: 'base',
    });

    expect(result[0].performanceDeltaPct).toBeNull();
  });
});

describe('the optimiser and the comparability of the runs', () => {
  it('never compares runs measured by different adapters', async () => {
    const foreign = makeRun({
      id: 'foreign',
      watts: 250,
      joules: 900,
      perSecond: 120,
      adapterId: 'llama-cpp',
    });
    const service = createService([BASELINE, foreign]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [250],
      maxPerformanceLossPct: 5,
      baselineRunId: 'base',
    });

    const candidate250 = recommendations.find((item) => item.watts === 250);
    expect(candidate250?.meetsConstraint).toBe(false);
    expect(candidate250?.performanceDeltaPct).toBeNull();
    expect(candidate250?.energyDeltaPct).toBeNull();
    expect(candidate250?.reason).toMatch(/outro adaptador/i);
  });

  it('never uses an aborted run as the baseline', async () => {
    const aborted = makeRun({
      id: 'aborted',
      watts: 285,
      joules: 1000,
      perSecond: 100,
      status: 'aborted',
    });
    const service = createService([aborted]);

    await expect(
      service.recommend({
        uuid: GPU_A,
        workload: 'llm-inference',
        candidateWatts: [250],
        maxPerformanceLossPct: 5,
        baselineRunId: null,
      }),
    ).rejects.toThrow(/medição|benchmark/i);

    await expect(
      service.recommend({
        uuid: GPU_A,
        workload: 'llm-inference',
        candidateWatts: [250],
        maxPerformanceLossPct: 5,
        baselineRunId: 'aborted',
      }),
    ).rejects.toThrow(/medição|benchmark/i);
  });

  it('never ranks an aborted run as a candidate', async () => {
    const aborted = makeRun({
      id: 'aborted',
      watts: 250,
      joules: 700,
      perSecond: 100,
      status: 'aborted',
    });
    const service = createService([BASELINE, aborted]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [250],
      maxPerformanceLossPct: 5,
      baselineRunId: 'base',
    });

    const candidate250 = recommendations.find((item) => item.watts === 250);
    expect(candidate250?.meetsConstraint).toBe(false);
    // The aborted run is not hidden: the reason says why it was rejected.
    expect(candidate250?.reason).toMatch(/rejeitada/i);
    expect(candidate250?.reason).toMatch(/interrompida/i);
  });
});

describe('the optimiser and the incomplete measurements', () => {
  it('never ranks a partially measured run', async () => {
    // The driver only answered during 43,8% of the run: the joules only
    // describe the measured window, so they cannot be ranked.
    const partial = makeRun({
      id: 'partial',
      watts: 180,
      joules: 700,
      perSecond: 100,
      status: 'partial',
      coveragePct: 43.8,
    });
    const service = createService([BASELINE, partial]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [285, 180],
      maxPerformanceLossPct: 5,
      baselineRunId: 'base',
    });

    const candidate180 = recommendations.find((item) => item.watts === 180);
    expect(candidate180?.meetsConstraint).toBe(false);
    expect(candidate180?.energyDeltaPct).toBeNull();
    expect(candidate180?.reason).toMatch(/rejeitada/i);
    expect(candidate180?.reason).toMatch(/parcial/i);

    // The recommendation is the complete reference, never the partial run.
    expect(recommendations[0].watts).toBe(285);
  });

  it('rejects a run whose coverage is below the minimum, even when it says completed', async () => {
    // An old run, published before the coverage was tracked: it claims to be
    // complete but its coverage says otherwise.
    const partial = makeRun({
      id: 'partial',
      watts: 180,
      joules: 700,
      perSecond: 100,
      coveragePct: 43.8,
    });
    const service = createService([BASELINE, partial]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [285, 180],
      maxPerformanceLossPct: 5,
      baselineRunId: 'base',
    });

    const candidate180 = recommendations.find((item) => item.watts === 180);
    expect(candidate180?.meetsConstraint).toBe(false);
    expect(candidate180?.reason).toMatch(/rejeitada/i);
    expect(recommendations[0].watts).toBe(285);
  });

  it('never ranks a run whose real power limit did not match the target', async () => {
    // The user asked for 180 W, but the driver was still at 285 W.
    const unverified = makeRun({
      id: 'unverified',
      watts: 180,
      joules: 700,
      perSecond: 100,
      limitVerified: false,
      observedLimitW: 285,
    });
    const service = createService([BASELINE, unverified]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [285, 180],
      maxPerformanceLossPct: 5,
      baselineRunId: 'base',
    });

    const candidate180 = recommendations.find((item) => item.watts === 180);
    expect(candidate180?.meetsConstraint).toBe(false);
    expect(candidate180?.energyDeltaPct).toBeNull();
    expect(candidate180?.reason).toMatch(/rejeitada/i);
    expect(candidate180?.reason).toMatch(/285 W/);
    expect(candidate180?.reason).toMatch(/180 W/);

    expect(recommendations[0].watts).toBe(285);
  });

  it('never ranks a run whose limit could not be observed', async () => {
    const unknown = makeRun({
      id: 'unknown',
      watts: 180,
      joules: 700,
      perSecond: 100,
      limitVerified: null,
      observedLimitW: null,
    });
    const service = createService([BASELINE, unknown]);

    const recommendations = await service.recommend({
      uuid: GPU_A,
      workload: 'llm-inference',
      candidateWatts: [285, 180],
      maxPerformanceLossPct: 5,
      baselineRunId: 'base',
    });

    const candidate180 = recommendations.find((item) => item.watts === 180);
    expect(candidate180?.meetsConstraint).toBe(false);
    expect(candidate180?.reason).toMatch(/não pôde ser lido/i);
  });

  it('refuses a reference run whose limit was not verified', async () => {
    const unverified = makeRun({
      id: 'unverified',
      watts: 285,
      joules: 1000,
      perSecond: 100,
      limitVerified: false,
      observedLimitW: 180,
    });
    const service = createService([unverified]);

    await expect(
      service.recommend({
        uuid: GPU_A,
        workload: 'llm-inference',
        candidateWatts: [180],
        maxPerformanceLossPct: 5,
        baselineRunId: 'unverified',
      }),
    ).rejects.toThrow(/não corresponde ao alvo|limite/i);
  });

  it('explains why no measurement is available', async () => {
    const unverified = makeRun({
      id: 'unverified',
      watts: 285,
      joules: 1000,
      perSecond: 100,
      limitVerified: false,
      observedLimitW: 180,
    });
    const service = createService([unverified]);

    await expect(
      service.recommend({
        uuid: GPU_A,
        workload: 'llm-inference',
        candidateWatts: [180],
        maxPerformanceLossPct: 5,
        baselineRunId: null,
      }),
    ).rejects.toThrow(/limite de potência real/i);
  });
});

describe('throughputMetric', () => {
  it('returns the rate reported by the adapter', () => {
    const throughput: ThroughputResult = {
      unit: 'token',
      count: 128,
      label: 'tokens gerados',
      source: 'teste',
      perSecond: 55.5,
    };

    expect(throughputMetric(throughput)).toBeCloseTo(55.5, 6);
  });

  it('returns null when the adapter reported no rate', () => {
    const throughput: ThroughputResult = {
      unit: 'token',
      count: 128,
      label: 'tokens gerados',
      source: 'teste',
    };

    expect(throughputMetric(throughput)).toBeNull();
  });

  it('never uses the amount of work as a rate', () => {
    const throughput: ThroughputResult = {
      unit: 'token',
      count: 5000,
      label: 'tokens gerados',
      source: 'teste',
      perSecond: null,
    };

    // A count is not a rate: a run that produced more tokens is not faster.
    expect(throughputMetric(throughput)).toBeNull();
  });

  it('returns null without a throughput', () => {
    expect(throughputMetric(null)).toBeNull();
  });
});
