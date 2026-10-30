/**
 * Optimisation assistant.
 *
 * The optimiser never guesses. It compares ONLY real, measured benchmark runs:
 * for every candidate power limit it looks for a run that was measured at that
 * exact limit, by the SAME adapter, and compares its energy against the
 * reference run and checks the performance loss against the budget the user
 * defined.
 *
 * A candidate is only comparable when the measurement is COMPLETE: the run
 * finished, the driver answered for the whole run, and the power limit the
 * driver really had configured was the requested one. A run that was only
 * partially measured, or that was executed at another limit than the one it is
 * labelled with, is rejected with the reason why — it is never ranked as if
 * it were complete.
 *
 * A candidate whose throughput could not be measured is never accepted: the
 * app cannot prove that it respects the budget, so it is reported as not
 * acceptable instead of being optimistically recommended. The same holds for
 * the energy: zero joules is not a measurement, it is the absence of one, so
 * it can never rank a candidate either.
 */

import type { OptimizerService as OptimizerServiceContract } from '../../shared/contracts';
import { MINIMUM_COVERAGE_PCT, coverageOfRun } from '../../shared/energy';
import {
  ErrorCode,
  type BenchmarkResult,
  type OptimizerRecommendation,
  type OptimizerRequest,
  type ThroughputResult,
  type WorkloadKind,
} from '../../shared/types';
import {
  assertArray,
  assertGpuUuid,
  assertNonEmptyString,
  assertNumberRange,
  assertOneOf,
  assertPlainObject,
  assertWatts,
  ValidationError,
} from '../../shared/validation';
import type { PowerReader } from '../benchmark/power-sampler';

const WORKLOAD_KINDS: readonly WorkloadKind[] = [
  'llm-inference',
  'image-generation',
  'video-generation',
  'cuda-synthetic',
  'manual',
];

/** Where the measured runs come from. */
export interface BenchmarkRunSource {
  list(): Promise<BenchmarkResult[]>;
}

export interface OptimizerServiceOptions {
  /** Source of the measured runs. */
  runs: BenchmarkRunSource;
  /** Optional power reader, used to report whether the GPU is still present. */
  powerReader?: PowerReader;
}

/** A candidate power limit and what was actually measured for it. */
interface CandidateEvaluation {
  watts: number;
  run: BenchmarkResult | null;
  joules: number | null;
  metric: number | null;
  performanceDeltaPct: number | null;
  energyDeltaPct: number | null;
  meetsConstraint: boolean;
  /** True when the energy was really measured, i.e. it is greater than zero. */
  energyMeasured: boolean;
  /** Adapter of a run measured at this limit that cannot be compared. */
  incompatibleAdapterId: string | null;
  /** Why the run measured at this limit was rejected, when there is one. */
  rejection: RunRejection | null;
}

/**
 * Why a run cannot be compared with the others.
 *
 * The reason is machine readable (`code`) and human readable (`message`), so
 * the interface can show exactly what is missing instead of hiding the run.
 */
export interface RunRejection {
  code:
    | 'not-completed'
    | 'partial-coverage'
    | 'limit-unverified'
    | 'energy-missing'
    | 'throughput-missing'
    | 'out-of-scope';
  /** The reason, in Brazilian Portuguese. */
  message: string;
}

export class OptimizerServiceImpl implements OptimizerServiceContract {
  private readonly runs: BenchmarkRunSource;
  private readonly powerReader: PowerReader | undefined;

  constructor(options: OptimizerServiceOptions) {
    this.runs = options.runs;
    this.powerReader = options.powerReader;
  }

  /**
   * Recommends the power limit with the lowest measured energy that still
   * respects the performance budget.
   *
   * The first element of the returned list is the recommendation; the other
   * elements are the evaluated candidates, for transparency.
   */
  async recommend(request: OptimizerRequest): Promise<OptimizerRecommendation[]> {
    const validated = validateOptimizerRequest(request);
    const runs = await this.runs.list();

    // The runs of this GPU and this workload, whatever their state.
    const scoped = runs.filter((run) => matchesScope(run, validated.uuid, validated.workload));

    // Only the runs that can really be compared take part in the analysis.
    const eligible = scoped.filter(
      (run) => evaluateRun(run, validated.uuid, validated.workload).eligible,
    );

    if (eligible.length === 0) {
      throw {
        code: ErrorCode.BenchmarkFailed,
        message: this.noMeasurementMessage(scoped, validated.uuid, validated.workload),
      } satisfies OptimizerError;
    }

    const baseline = this.resolveBaseline(eligible, runs, validated);
    const baselineAdapterId = baseline.config.adapterId;
    const baselineJoules = joulesOf(baseline, validated.uuid);
    const baselineMetric = throughputMetric(baseline.throughput);
    const baselineEnergyMeasured = baselineJoules !== null && baselineJoules > 0;

    // Only the runs measured by the SAME adapter are comparable: the rate of
    // Ollama is decode only, while the rate of llama.cpp falls back to the
    // wall clock. Comparing them would invent a performance delta.
    const comparable = eligible.filter((run) => run.config.adapterId === baselineAdapterId);

    const evaluations: CandidateEvaluation[] = validated.candidateWatts.map((watts) => {
      const run = findRunAtWatts(comparable, validated.uuid, watts, baselineAdapterId);

      if (!run) {
        // No comparable run at this limit: the reason why is reported
        // instead of a number that was never measured.
        const rejected = findRejectedRunAtWatts(
          scoped,
          validated.uuid,
          watts,
          baselineAdapterId,
        );
        const rejection = rejected
          ? evaluateRun(rejected, validated.uuid, validated.workload).rejection
          : null;
        const incompatibleAdapterId = findForeignAdapterAtWatts(
          eligible,
          validated.uuid,
          watts,
          baselineAdapterId,
        );
        return {
          watts,
          run: null,
          joules: null,
          metric: null,
          performanceDeltaPct: null,
          energyDeltaPct: null,
          meetsConstraint: false,
          energyMeasured: false,
          incompatibleAdapterId,
          rejection,
        };
      }

      const joules = joulesOf(run, validated.uuid);
      const metric = throughputMetric(run.throughput);

      // Zero joules is not a measurement: it means the energy of the workload
      // could not be resolved, so it can never rank a candidate.
      const energyMeasured = joules !== null && joules > 0;

      const performanceDeltaPct = percentageDelta(metric, baselineMetric);
      const energyDeltaPct =
        energyMeasured && baselineEnergyMeasured
          ? percentageDelta(joules, baselineJoules)
          : null;
      const meetsConstraint =
        performanceDeltaPct !== null &&
        performanceDeltaPct >= -validated.maxPerformanceLossPct;

      return {
        watts,
        run,
        joules,
        metric,
        performanceDeltaPct,
        energyDeltaPct,
        meetsConstraint,
        energyMeasured,
        incompatibleAdapterId: null,
        rejection: null,
      };
    });

    const presenceNote = await this.readPresenceNote(validated.uuid);
    const baselineWatts = wattsOf(baseline, validated.uuid);

    // A candidate is acceptable only when BOTH its energy and its throughput
    // were really measured.
    //
    // The reference is NEVER a candidate for itself: comparing the reference
    // with itself yields a 0 % delta, which would ALWAYS satisfy the
    // constraint and would make the "nothing qualified" case unreachable —
    // the user would be shown a green recommendation that saves nothing.
    // The reference still appears honestly in the list of the other limits.
    const acceptable = evaluations.filter(
      (evaluation) =>
        evaluation.meetsConstraint &&
        evaluation.energyMeasured &&
        evaluation.watts !== baselineWatts,
    );

    const recommended =
      acceptable.length > 0
        ? acceptable.reduce((best, current) => {
            if (current.joules !== best.joules) {
              return (current.joules ?? Number.POSITIVE_INFINITY) <
                (best.joules ?? Number.POSITIVE_INFINITY)
                ? current
                : best;
            }
            // Same measured energy: the lower limit is the better answer.
            return current.watts < best.watts ? current : best;
          })
        : null;

    const recommendations: OptimizerRecommendation[] = [];

    if (recommended) {
      recommendations.push(
        this.toRecommendation(
          validated.uuid,
          recommended,
          baselineWatts,
          this.reasonForRecommended(recommended, validated.maxPerformanceLossPct, presenceNote),
        ),
      );
    } else {
      const reason = this.reasonForFallback(
        evaluations,
        baselineWatts,
        baselineJoules,
        baselineEnergyMeasured,
        validated.maxPerformanceLossPct,
      );
      recommendations.push({
        uuid: validated.uuid,
        watts: baselineWatts ?? 0,
        baselineWatts,
        // The reference is compared against itself: the delta is derived from
        // the real measurement, never invented. It stays null when the
        // reference has no measurable throughput.
        performanceDeltaPct: percentageDelta(baselineMetric, baselineMetric),
        // The same for the energy: null when the reference energy was not
        // measured (unknown or zero).
        energyDeltaPct: percentageDelta(baselineJoules, baselineJoules),
        meetsConstraint: true,
        // NOTHING qualified: the reference is kept because no candidate met
        // the requirement, not because the reference is the best answer. The
        // interface must say so instead of showing a green recommendation
        // that saves nothing.
        fallback: true,
        reason: `${reason}${presenceNote}`,
      });
    }

    const others = evaluations
      .filter((evaluation) => evaluation !== recommended)
      .sort((a, b) => {
        if (a.meetsConstraint !== b.meetsConstraint) return a.meetsConstraint ? -1 : 1;
        return (a.joules ?? Number.POSITIVE_INFINITY) - (b.joules ?? Number.POSITIVE_INFINITY);
      });

    for (const evaluation of others) {
      recommendations.push(
        this.toRecommendation(
          validated.uuid,
          evaluation,
          baselineWatts,
          this.reasonForCandidate(evaluation, validated.maxPerformanceLossPct),
        ),
      );
    }

    return recommendations;
  }

  /** Finds the reference run: the requested one, or the highest limit measured. */
  private resolveBaseline(
    eligible: BenchmarkResult[],
    allRuns: BenchmarkResult[],
    request: ValidatedOptimizerRequest,
  ): BenchmarkResult {
    if (request.baselineRunId) {
      const run = allRuns.find((candidate) => candidate.id === request.baselineRunId);
      if (!run) {
        throw {
          code: ErrorCode.ProfileNotFound,
          message: `A execução de referência "${request.baselineRunId}" não foi encontrada.`,
        } satisfies OptimizerError;
      }
      const evaluation = evaluateRun(run, request.uuid, request.workload);
      if (!evaluation.eligible) {
        throw {
          code: ErrorCode.BenchmarkFailed,
          message:
            `A execução de referência "${request.baselineRunId}" não é uma medição válida ` +
            `para esta GPU: ${rejectionMessage(run, request.uuid)}.`,
        } satisfies OptimizerError;
      }
      return run;
    }

    return eligible.reduce((best, current) =>
      (wattsOf(current, request.uuid) ?? 0) > (wattsOf(best, request.uuid) ?? 0) ? current : best,
    );
  }

  /**
   * Explains that no run can be compared, and why the existing ones were
   * rejected.
   */
  private noMeasurementMessage(
    scoped: BenchmarkResult[],
    uuid: string,
    workload: WorkloadKind,
  ): string {
    const reasons: string[] = [];
    for (const run of scoped) {
      const evaluation = evaluateRun(run, uuid, workload);
      if (evaluation.eligible || evaluation.rejection === null) continue;
      const message = evaluation.rejection.message;
      if (!reasons.includes(message)) reasons.push(message);
    }

    const detail =
      reasons.length > 0 ? ` Motivo: ${reasons.slice(0, 3).join('; ')}.` : '';
    return (
      'Nenhuma medição válida para esta GPU e este tipo de workload.' +
      detail +
      ' Execute o benchmark nos limites de potência candidatos, com o limite realmente aplicado, ' +
      'antes de pedir uma recomendação.'
    );
  }

  /** Notes whether the GPU is still present on the machine. */
  private async readPresenceNote(uuid: string): Promise<string> {
    if (!this.powerReader) return '';
    try {
      const readings = await this.powerReader();
      const present = readings.some((reading) => reading.uuid === uuid);
      return present
        ? ''
        : ' A GPU não está presente neste momento; a comparação usa medições anteriores.';
    } catch {
      return '';
    }
  }

  private toRecommendation(
    uuid: string,
    evaluation: CandidateEvaluation,
    baselineWatts: number | null,
    reason: string,
  ): OptimizerRecommendation {
    return {
      uuid,
      watts: evaluation.watts,
      baselineWatts,
      performanceDeltaPct: evaluation.performanceDeltaPct,
      energyDeltaPct: evaluation.energyDeltaPct,
      meetsConstraint: evaluation.meetsConstraint,
      reason,
    };
  }

  private reasonForRecommended(
    evaluation: CandidateEvaluation,
    maxPerformanceLossPct: number,
    presenceNote: string,
  ): string {
    const joules =
      evaluation.joules !== null ? `${formatNumber(evaluation.joules, 1)} J` : 'energia desconhecida';
    const energy = formatEnergyDelta(evaluation.energyDeltaPct);
    const performance = formatPerformance(evaluation.performanceDeltaPct);

    return (
      `Recomendado: ${formatNumber(evaluation.watts, 0)} W consumiu ${joules} (${energy}) ` +
      `com ${performance}, dentro do orçamento de ${formatNumber(
        maxPerformanceLossPct,
      )}% de perda.${presenceNote}`
    );
  }

  private reasonForFallback(
    evaluations: readonly CandidateEvaluation[],
    baselineWatts: number | null,
    baselineJoules: number | null,
    baselineEnergyMeasured: boolean,
    maxPerformanceLossPct: number,
  ): string {
    const measuredCandidates = evaluations.filter((evaluation) => evaluation.energyMeasured);
    const budget = `Nenhum limite candidato cumpre a perda máxima de ${formatNumber(
      maxPerformanceLossPct,
    )}%.`;

    // "There is no measurement at this limit" and "the measurement could not
    // be taken" are different facts and must not be reported with the same
    // sentence: the first means the user simply has not run the benchmark
    // there yet, the second means the run happened but its energy was not
    // measurable.
    const missingRuns = evaluations.filter(
      (evaluation) => evaluation.rejection === null && evaluation.joules === null,
    );
    if (evaluations.length > 0 && missingRuns.length === evaluations.length) {
      return (
        'Não há medição nos limites candidatos: execute o benchmark em cada limite antes de comparar. ' +
        `${budget} ` +
        `Mantida a referência de ${formatNumber(baselineWatts ?? 0, 0)} W.`
      );
    }

    if (measuredCandidates.length === 0 || !baselineEnergyMeasured) {
      // The energy could not be measured: saying "0 J" would be a lie, so the
      // app says that the measurement is missing instead.
      return (
        'A energia não pôde ser medida nos limites candidatos: nenhum registro com joules medidos e positivos. ' +
        `${budget} ` +
        `Mantida a referência de ${formatNumber(baselineWatts ?? 0, 0)} W (energia não medida).`
      );
    }

    return (
      `${budget} ` +
      `Mantida a referência de ${formatNumber(baselineWatts ?? 0, 0)} W` +
      ` (${formatNumber(baselineJoules ?? 0, 1)} J medidos).`
    );
  }

  private reasonForCandidate(
    evaluation: CandidateEvaluation,
    maxPerformanceLossPct: number,
  ): string {
    if (!evaluation.run) {
      if (evaluation.rejection) {
        return `Medição em ${formatNumber(
          evaluation.watts,
          0,
        )} W rejeitada: ${evaluation.rejection.message}.`;
      }
      if (evaluation.incompatibleAdapterId) {
        return `Medido com outro adaptador (${evaluation.incompatibleAdapterId}) em ${formatNumber(
          evaluation.watts,
          0,
        )} W: a taxa não é comparável com a referência.`;
      }
      return `Sem medição neste limite de potência (${formatNumber(
        evaluation.watts,
        0,
      )} W): execute o benchmark antes de comparar.`;
    }

    if (evaluation.performanceDeltaPct === null) {
      return `Sem throughput medido em ${formatNumber(
        evaluation.watts,
        0,
      )} W: não é possível comprovar a perda máxima de ${formatNumber(maxPerformanceLossPct)}%.`;
    }

    if (!evaluation.meetsConstraint) {
      return `Fora do orçamento: ${formatNumber(evaluation.watts, 0)} W perde ${formatNumber(
        Math.abs(evaluation.performanceDeltaPct),
      )}% de desempenho (limite de ${formatNumber(maxPerformanceLossPct)}%).`;
    }

    if (!evaluation.energyMeasured) {
      return `Energia não medida em ${formatNumber(
        evaluation.watts,
        0,
      )} W: 0 J não é uma medição válida, então a economia não pode ser comparada com a referência.`;
    }

    const energy = formatEnergyDelta(evaluation.energyDeltaPct);
    return `Dentro do orçamento: ${formatNumber(evaluation.watts, 0)} W usa ${
      evaluation.joules !== null ? `${formatNumber(evaluation.joules, 1)} J` : 'energia desconhecida'
    } (${energy}) com ${formatPerformance(evaluation.performanceDeltaPct)}.`;
  }
}

/** Error shape used when the request cannot be answered with real data. */
interface OptimizerError {
  code: string;
  message: string;
}

interface ValidatedOptimizerRequest {
  uuid: string;
  workload: WorkloadKind;
  candidateWatts: number[];
  maxPerformanceLossPct: number;
  baselineRunId: string | null;
}

/** Validates the request coming from the renderer. */
export function validateOptimizerRequest(request: unknown): ValidatedOptimizerRequest {
  const raw = assertPlainObject(request, 'request');

  const uuid = assertGpuUuid(raw.uuid, 'uuid');
  const workload = assertOneOf<WorkloadKind>(raw.workload, WORKLOAD_KINDS, 'workload');

  const rawCandidates = assertArray(raw.candidateWatts, 'candidateWatts', 32);
  const candidateWatts = rawCandidates.map((watts, index) =>
    assertWatts(watts, `candidateWatts[${index}]`),
  );
  if (candidateWatts.length === 0) {
    throw new ValidationError(
      'candidateWatts',
      'Informe ao menos um limite de potência candidato.',
    );
  }

  const maxPerformanceLossPct = assertNumberRange(
    raw.maxPerformanceLossPct,
    'maxPerformanceLossPct',
    0,
    100,
  );

  const baselineRunId =
    raw.baselineRunId === null || raw.baselineRunId === undefined
      ? null
      : assertNonEmptyString(raw.baselineRunId, 'baselineRunId', 64);

  return { uuid, workload, candidateWatts, maxPerformanceLossPct, baselineRunId };
}

/**
 * True when the run belongs to the GPU and the workload being analysed.
 *
 * It says nothing about the quality of the measurement: that is the job of
 * {@link evaluateRun}.
 */
export function matchesScope(
  run: BenchmarkResult,
  uuid: string,
  workload: WorkloadKind,
): boolean {
  if (!run) return false;
  if (run.config.workload !== workload) return false;
  if (!run.config.uuids.includes(uuid)) return false;
  return typeof run.config.wattsPerGpu[uuid] === 'number';
}

/**
 * Decides whether a run can be compared with the other runs, and says why it
 * cannot when it cannot.
 *
 * A run is comparable only when ALL of the following hold:
 *
 *  - it finished (`completed`): an aborted, failed or partial run covers a
 *    different wall clock window than the candidate;
 *  - the driver answered for (almost) the whole run: a measurement that
 *    covered only a part of it does not describe the energy of the workload;
 *  - the power limit the driver REALLY had configured was the requested one:
 *    a run labelled "160 W" that actually executed at 285 W proves nothing
 *    about 160 W.
 */
export function evaluateRun(
  run: BenchmarkResult,
  uuid: string,
  workload: WorkloadKind,
): { eligible: boolean; rejection: RunRejection | null } {
  if (!run) {
    return {
      eligible: false,
      rejection: { code: 'not-completed', message: 'a execução não existe' },
    };
  }

  if (run.status !== 'completed') {
    return { eligible: false, rejection: rejectionForStatus(run) };
  }

  // A workload driven by an adapter that never reported what it produced was
  // interrupted: it never finished, so it can never be a reference nor a
  // candidate, whatever the energy says.
  if (run.config.adapterId !== null && run.throughput === null) {
    return {
      eligible: false,
      rejection: {
        code: 'throughput-missing',
        message:
          'a carga de trabalho não reportou o throughput (o que produziu): ' +
          'a execução não chegou a terminar',
      },
    };
  }

  if (run.config.workload !== workload) {
    return {
      eligible: false,
      rejection: { code: 'out-of-scope', message: 'medida de outro tipo de workload' },
    };
  }

  if (!run.config.uuids.includes(uuid)) {
    return {
      eligible: false,
      rejection: { code: 'out-of-scope', message: 'a GPU não participou desta execução' },
    };
  }

  const target = run.config.wattsPerGpu[uuid];
  if (typeof target !== 'number') {
    return {
      eligible: false,
      rejection: {
        code: 'out-of-scope',
        message: 'o limite de potência da GPU não foi informado',
      },
    };
  }

  const coveragePct = coverageOfRun(run);
  if (coveragePct === null) {
    // The coverage of the run was never established: it describes an unknown
    // part of the workload, so the joules cannot be divided by the whole
    // workload. An unknown coverage is never a complete coverage.
    return {
      eligible: false,
      rejection: {
        code: 'partial-coverage',
        message:
          'a cobertura da execução não foi medida, então a energia não descreve ' +
          'a carga de trabalho inteira',
      },
    };
  }

  if (coveragePct < MINIMUM_COVERAGE_PCT) {
    return {
      eligible: false,
      rejection: {
        code: 'partial-coverage',
        message:
          `apenas ${formatNumber(coveragePct, 1)}% da execução foi medida ` +
          `(mínimo de ${formatNumber(MINIMUM_COVERAGE_PCT, 0)}%)`,
      },
    };
  }

  if (run.limitVerified !== true) {
    const observed = run.observedLimitsW?.[uuid] ?? null;
    const message =
      observed === null
        ? 'o limite de potência real não pôde ser lido no driver'
        : `o limite de potência real observado (${formatNumber(observed, 0)} W) ` +
          `não corresponde ao alvo (${formatNumber(target, 0)} W)`;
    return { eligible: false, rejection: { code: 'limit-unverified', message } };
  }

  return { eligible: true, rejection: null };
}

/** The reason a run that did not finish cannot be compared. */
function rejectionForStatus(run: BenchmarkResult): RunRejection {
  switch (run.status) {
    case 'partial':
      return {
        code: 'partial-coverage',
        message:
          `medição parcial: apenas ${formatNumber(run.coveragePct ?? 0, 1)}% da execução ` +
          'foi medida',
      };
    case 'aborted':
      return { code: 'not-completed', message: 'execução interrompida antes do fim' };
    case 'failed':
      return { code: 'not-completed', message: 'execução falhou' };
    case 'running':
      return { code: 'not-completed', message: 'execução ainda em andamento' };
    default:
      return { code: 'not-completed', message: `execução com status "${run.status}"` };
  }
}

/** The reason a run was rejected, in a single sentence. */
export function rejectionMessage(run: BenchmarkResult, uuid: string): string {
  const evaluation = evaluateRun(run, uuid, run.config.workload);
  return evaluation.rejection?.message ?? 'medição não comparável';
}

/**
 * Finds the run measured at a given power limit, by the given adapter.
 *
 * Two runs measured by different adapters are not comparable, so the adapter
 * is part of the lookup and never optional.
 */
function findRunAtWatts(
  runs: BenchmarkResult[],
  uuid: string,
  watts: number,
  adapterId: string | null,
): BenchmarkResult | null {
  const matches = runs.filter(
    (run) => run.config.wattsPerGpu[uuid] === watts && run.config.adapterId === adapterId,
  );
  if (matches.length === 0) return null;
  return matches.reduce((best, current) =>
    current.startedAt > best.startedAt ? current : best,
  );
}

/**
 * Finds the newest run measured at a given limit that CANNOT be compared.
 *
 * It is used to explain why a limit has no usable measurement: an aborted,
 * partial or unverified run is never hidden, it is reported.
 */
function findRejectedRunAtWatts(
  runs: BenchmarkResult[],
  uuid: string,
  watts: number,
  adapterId: string | null,
): BenchmarkResult | null {
  const matches = runs.filter(
    (run) =>
      run.config.wattsPerGpu[uuid] === watts &&
      run.config.adapterId === adapterId &&
      !evaluateRun(run, uuid, run.config.workload).eligible,
  );
  if (matches.length === 0) return null;
  return matches.reduce((best, current) =>
    current.startedAt > best.startedAt ? current : best,
  );
}

/**
 * Finds a run measured at a given power limit by ANOTHER adapter.
 *
 * It is used to explain that a limit was measured, but not with an adapter
 * that can be compared with the reference.
 */
function findForeignAdapterAtWatts(
  runs: BenchmarkResult[],
  uuid: string,
  watts: number,
  adapterId: string | null,
): string | null {
  const match = runs.find(
    (run) =>
      run.config.wattsPerGpu[uuid] === watts && run.config.adapterId !== adapterId,
  );
  return match ? match.config.adapterId : null;
}

/** Energy measured for one GPU, in joules. */
function joulesOf(run: BenchmarkResult, uuid: string): number | null {
  const energy = run.energy;
  if (!energy) return null;
  const perGpu = energy.perGpu?.[uuid];
  if (perGpu && Number.isFinite(perGpu.joules)) return perGpu.joules;
  // The total of the run is the sum of the SELECTED GPUs: it says nothing
  // about this GPU in particular, so it is never used as a substitute.
  return null;
}

/** Power limit used by a run for one GPU. */
function wattsOf(run: BenchmarkResult, uuid: string): number | null {
  const watts = run.config.wattsPerGpu[uuid];
  return typeof watts === 'number' ? watts : null;
}

/**
 * The performance metric of a run.
 *
 * Only a real RATE is comparable: the rate of work produced per second.
 * The amount of work is not a rate: a run that produced more tokens is not
 * necessarily faster, so a count can never be used to rank a candidate.
 *
 * A run without a measured rate returns null: it cannot be compared.
 */
export function throughputMetric(throughput: ThroughputResult | null): number | null {
  if (!throughput) return null;

  const perSecond = throughput.perSecond;
  if (typeof perSecond === 'number' && Number.isFinite(perSecond) && perSecond > 0) {
    return perSecond;
  }

  return null;
}

/** Percentage difference between two values, or null when it cannot be computed. */
function percentageDelta(value: number | null, baseline: number | null): number | null {
  if (value === null || baseline === null) return null;
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) return null;
  if (baseline === 0) return null;
  return ((value - baseline) / baseline) * 100;
}

/** Formats a number for the user, in Brazilian Portuguese. */
function formatNumber(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Describes the energy difference against the reference run. */
function formatEnergyDelta(deltaPct: number | null): string {
  if (deltaPct === null) return 'energia desconhecida contra a referência';
  if (deltaPct < 0) return `${formatNumber(Math.abs(deltaPct))}% menos energia que a referência`;
  if (deltaPct > 0) return `${formatNumber(deltaPct)}% mais energia que a referência`;
  return 'a mesma energia da referência';
}

/** Describes the performance difference against the reference run. */
function formatPerformance(deltaPct: number | null): string {
  if (deltaPct === null) return 'desempenho desconhecido';
  if (deltaPct < 0) return `perda de ${formatNumber(Math.abs(deltaPct))}% de desempenho`;
  return `ganho de ${formatNumber(deltaPct)}% de desempenho`;
}
