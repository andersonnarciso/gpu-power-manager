/**
 * Benchmark measurement metadata and comparability rules.
 *
 * The renderer never decides on its own whether a number is trustworthy. It
 * reads the evidence the engine publishes about the measurement itself (the
 * window that was really measured, the coverage of the run, the power limit
 * that was really in effect) and refuses to publish a figure that the
 * evidence does not support.
 *
 * Two rules drive everything here:
 *
 *  - a measurement that did not happen stays `null`: it is rendered as "not
 *    measured", never as a zero;
 *  - two runs are only comparable when they measured the same thing: same
 *    adapter, same workload, same GPUs and a complete measurement.
 */

import {
  MINIMUM_COVERAGE_PCT,
  coverageOfRun,
  isFullyMeasured as sharedIsFullyMeasured,
  measuredMsOfRun,
  scopeEnergy,
  scopeOfRun,
} from '@shared/energy';
import type { BenchmarkResult, EnergyPerGpu, EnergySummary, GpuUuid } from '@shared/types';

/**
 * Minimum share of the run window that must have been measured for a run to
 * be comparable with another one.
 *
 * It is the very threshold the engine uses to publish a run as `completed`
 * instead of `partial`: the renderer never applies a threshold of its own.
 */
export const MIN_COVERAGE_PCT = MINIMUM_COVERAGE_PCT;

/**
 * Evidence about the measurement itself.
 *
 * The engine publishes these fields next to the result. They are optional:
 * a field that the engine did not report is unknown, never zero.
 */
export interface MeasurementEvidence {
  /** Window really measured, milliseconds. */
  measuredMs?: number | null;
  /** Share of the run window that was measured, percent. */
  coveragePct?: number | null;
  /** True when the power limit in effect was confirmed by the driver. */
  limitVerified?: boolean | null;
  /** Power limit really in effect per GPU, watts. */
  observedLimitsW?: Record<string, number | null>;
}

/** A benchmark result carrying the optional measurement evidence. */
export type BenchmarkResultWithEvidence = BenchmarkResult & MeasurementEvidence;

/** An energy summary carrying the optional measurement evidence. */
export type EnergySummaryWithEvidence = EnergySummary & MeasurementEvidence;

/** The energy of a single GPU carrying the optional measurement evidence. */
export type EnergyPerGpuWithEvidence = EnergyPerGpu & MeasurementEvidence;

/** Evidence with every unknown field normalised to `null`. */
export interface NormalisedEvidence {
  /** Window really measured, milliseconds. `null` when not reported. */
  measuredMs: number | null;
  /** Coverage of the run, percent. `null` when not reported. */
  coveragePct: number | null;
  /** Whether the limit was confirmed. `null` when not reported. */
  limitVerified: boolean | null;
  /** Power limit really in effect per GPU. `null` when not reported. */
  observedLimitsW: Record<string, number | null> | null;
}

/**
 * Reads the measurement evidence of any value that may carry it.
 *
 * A missing field is `null`: it was not measured, it is not zero.
 */
export function evidenceOf(value: object | null | undefined): NormalisedEvidence {
  if (!value) {
    return { measuredMs: null, coveragePct: null, limitVerified: null, observedLimitsW: null };
  }
  const source = value as Partial<MeasurementEvidence>;
  return {
    measuredMs:
      typeof source.measuredMs === 'number' && Number.isFinite(source.measuredMs)
        ? source.measuredMs
        : null,
    coveragePct:
      typeof source.coveragePct === 'number' && Number.isFinite(source.coveragePct)
        ? source.coveragePct
        : null,
    limitVerified: typeof source.limitVerified === 'boolean' ? source.limitVerified : null,
    observedLimitsW: source.observedLimitsW ?? null,
  };
}

/** The GPUs a run was configured for. */
export function runScope(run: BenchmarkResult): GpuUuid[] {
  return scopeOfRun(run);
}

/**
 * Restricts an energy summary to the GPUs the run was configured for.
 *
 * The live tile and the results table must talk about the same scope, so
 * both go through this function: a run that measured one GPU never shows the
 * energy of the whole machine, and a run that measured three GPUs never
 * shows the energy of one of them.
 *
 * The rule itself lives in the shared module, so the renderer, the engine and
 * the optimiser can never disagree about the coverage of the same run.
 */
export function scopedEnergy(
  summary: EnergySummary | null,
  uuids: readonly GpuUuid[],
  durationMs?: number | null,
): EnergySummary | null {
  return scopeEnergy(summary, uuids, durationMs);
}

/** Window really measured for a run, milliseconds. */
export function runMeasuredMs(run: BenchmarkResult): number | null {
  return measuredMsOfRun(run);
}

/** Coverage of a run, percent. `null` when the engine did not report it. */
export function runCoveragePct(run: BenchmarkResult): number | null {
  return coverageOfRun(run);
}

/**
 * True when the energy of a summary was really measured.
 *
 * Zero joules is not a measurement, it is the absence of one, and a window
 * that was never measured cannot prove anything.
 */
export function isEnergyMeasured(summary: EnergySummary | null): boolean {
  if (!summary) return false;
  if (!Number.isFinite(summary.joulesTotal) || summary.joulesTotal <= 0) return false;
  const measuredMs = summary.measuredMs ?? null;
  if (measuredMs === null || measuredMs <= 0) return false;
  return true;
}

/** The measured energy of a summary, in joules. `null` when not measured. */
export function measuredJoules(summary: EnergySummary | null): number | null {
  if (!isEnergyMeasured(summary)) return null;
  return summary?.joulesTotal ?? null;
}

/**
 * True when the run carries a complete, resolved measurement.
 *
 * The run must have a positive energy, a measured window and a coverage at
 * or above the threshold the engine uses. A run whose coverage is unknown
 * describes an unknown part of the workload, so it is never complete.
 *
 * The rule itself lives in the shared module: the engine, the optimiser and
 * the renderer must never disagree about the same run.
 */
export function isFullyMeasured(run: BenchmarkResult): boolean {
  return sharedIsFullyMeasured(run);
}

/** How the power limit of a run relates to what the driver really had. */
export type LimitStatus = 'verified' | 'not-applied' | 'unknown';

/** The power limit status of a run. */
export function limitStatusOf(run: BenchmarkResult): LimitStatus {
  const verified = evidenceOf(run).limitVerified;
  if (verified === true) return 'verified';
  if (verified === false) return 'not-applied';
  return 'unknown';
}

/**
 * True when the run may be offered as a baseline or as a candidate.
 *
 * An aborted run is never comparable: its energy covers a different window
 * than the candidate. A run whose limit was known not to be in effect is
 * never comparable either: its label would describe a limit that was not
 * there.
 *
 * The panel offers exactly the runs the optimiser accepts. The optimiser also
 * refuses a run whose power limit was not confirmed by the driver and a run
 * that never reported what it produced; offering them here would only lead to
 * an error toast instead of a filtered list.
 */
export function isComparableRun(run: BenchmarkResult): boolean {
  if (!run || run.status !== 'completed') return false;
  if (!isFullyMeasured(run)) return false;
  if (limitStatusOf(run) !== 'verified') return false;
  if (run.config.adapterId !== null && run.throughput === null) return false;
  return true;
}

/** True when two runs measured the same thing and may be compared. */
export function arePeerRuns(a: BenchmarkResult, b: BenchmarkResult): boolean {
  if (a.config.adapterId !== b.config.adapterId) return false;
  if (a.config.workload !== b.config.workload) return false;
  const scopeA = [...runScope(a)].sort();
  const scopeB = [...runScope(b)].sort();
  if (scopeA.length !== scopeB.length) return false;
  return scopeA.every((uuid, index) => uuid === scopeB[index]);
}

/** The runs that may be offered as a baseline or as a candidate. */
export function comparableRuns(runs: readonly BenchmarkResult[]): BenchmarkResult[] {
  return runs.filter((run) => isComparableRun(run));
}

/**
 * The runs that may be offered by a comparison panel.
 *
 * On top of the comparability of the run itself, a run is only offered when
 * there is at least one other run it can be compared with: the same adapter,
 * the same workload and the same GPUs. A run that stands alone would open a
 * comparison that can never be made.
 */
export function comparablePairRuns(runs: readonly BenchmarkResult[]): BenchmarkResult[] {
  const comparable = comparableRuns(runs);
  return comparable.filter((run) =>
    comparable.some((other) => other.id !== run.id && arePeerRuns(run, other)),
  );
}
