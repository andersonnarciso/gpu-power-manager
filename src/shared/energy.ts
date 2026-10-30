/**
 * Energy mathematics.
 *
 * This module is the credibility core of the application: every number the user
 * sees about "how much energy did that workload cost" comes from here.
 *
 * Rules that are never broken:
 *  - Energy is the integral of the MEASURED power over time. A power LIMIT is
 *    never multiplied by a duration: the board may draw less than its limit.
 *  - A measurement that was not taken stays `null`. Nothing is estimated to
 *    fill a hole.
 *  - A gap in the series breaks the series: integrating across a gap would
 *    fabricate energy out of thin air.
 *
 * The module is pure: no I/O, no clock, no globals. That makes it trivially
 * testable and safe to use from both the main and the renderer process.
 */

import type {
  BenchmarkMeasurement,
  BenchmarkResult,
  EnergyPerGpu,
  EnergySummary,
  EfficiencyResult,
  GpuUuid,
  ThroughputResult,
  ThroughputUnit,
} from './types';

/** One measured power reading of a single GPU. */
export interface EnergySample {
  /** Epoch milliseconds of the reading. */
  at: number;
  /** Measured board power draw in watts. */
  powerW: number;
}

/** Result of integrating a power series over time. */
export interface IntegratedEnergy {
  /** Energy consumed, joules. */
  joules: number;
  /** Energy consumed, watt-hours. */
  wattHours: number;
  /** Average measured power over the integrated time, watts. */
  avgPowerW: number;
  /** Highest measured power, watts. */
  peakPowerW: number;
  /**
   * Time actually integrated, in milliseconds.
   *
   * It is the difference between "the board drew nothing" and "nothing was
   * measured at all". A caller that integrates a window shorter than its own
   * sampling resolution must not publish the resulting joules.
   */
  measuredMs: number;
}

export interface IntegrateEnergyOptions {
  /**
   * Expected interval between two consecutive samples, in milliseconds.
   *
   * When provided it is authoritative: the caller knows its own sampling
   * period. When omitted it is derived from the series itself, using the
   * smallest observed positive delta (the nominal sampling period).
   */
  expectedIntervalMs?: number | null;
  /**
   * A gap larger than `expectedInterval * maxGapFactor` breaks the series.
   * Defaults to 2.5.
   */
  maxGapFactor?: number | null;
  /**
   * Absolute maximum gap, in milliseconds. When set it replaces the factor
   * based rule.
   */
  maxGapMs?: number | null;
}

const DEFAULT_MAX_GAP_FACTOR = 2.5;
const SECONDS_PER_HOUR = 3600;
const MILLIS_PER_SECOND = 1000;

/**
 * Minimum fraction of the run that must have been measured, in percent.
 *
 * A run whose driver only answered part of the time does NOT describe the
 * energy of the whole workload: the unmeasured window would silently be
 * rendered as zero joules. Below this threshold the measurement is published
 * as partial and is never ranked as if it were complete.
 */
export const MINIMUM_COVERAGE_PCT = 80;

/** A sample is usable when it carries a real timestamp and a sane power. */
function isUsableSample(sample: EnergySample): boolean {
  return (
    typeof sample === 'object' &&
    sample !== null &&
    Number.isFinite(sample.at) &&
    Number.isFinite(sample.powerW) &&
    sample.powerW >= 0
  );
}

function resolveExpectedInterval(
  explicit: number | null | undefined,
  positiveDeltas: readonly number[],
): number | null {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  if (positiveDeltas.length === 0) {
    return null;
  }
  // The nominal sampling period is the smallest observed delta: every other
  // delta is at least one period long.
  return positiveDeltas.reduce((min, d) => (d < min ? d : min), positiveDeltas[0]);
}

function resolveMaxGap(options: IntegrateEnergyOptions, expectedIntervalMs: number | null): number {
  if (
    typeof options.maxGapMs === 'number' &&
    Number.isFinite(options.maxGapMs) &&
    options.maxGapMs > 0
  ) {
    return options.maxGapMs;
  }
  const factor =
    typeof options.maxGapFactor === 'number' &&
    Number.isFinite(options.maxGapFactor) &&
    options.maxGapFactor > 0
      ? options.maxGapFactor
      : DEFAULT_MAX_GAP_FACTOR;
  if (expectedIntervalMs === null) {
    return Number.POSITIVE_INFINITY;
  }
  return expectedIntervalMs * factor;
}

/**
 * Integrates a measured power series over time using the trapezoidal rule.
 *
 * The series is sorted defensively, invalid samples (NaN, negative power,
 * invalid timestamps) are ignored and the series is split whenever two
 * consecutive samples are further apart than the expected sampling interval
 * allows. Energy is never integrated across such a gap.
 */
export function integrateEnergy(
  samples: readonly EnergySample[],
  options: IntegrateEnergyOptions = {},
): IntegratedEnergy {
  const usable = (Array.isArray(samples) ? samples : [])
    .filter(isUsableSample)
    .slice()
    .sort((a, b) => a.at - b.at);

  if (usable.length === 0) {
    return { joules: 0, wattHours: 0, avgPowerW: 0, peakPowerW: 0, measuredMs: 0 };
  }

  const peakPowerW = usable.reduce((max, s) => (s.powerW > max ? s.powerW : max), 0);

  if (usable.length === 1) {
    // A single reading has no duration: zero energy, but the reading itself
    // is still reported as average and peak power.
    return {
      joules: 0,
      wattHours: 0,
      avgPowerW: usable[0].powerW,
      peakPowerW,
      measuredMs: 0,
    };
  }

  const deltas: number[] = [];
  for (let i = 1; i < usable.length; i += 1) {
    const dt = usable[i].at - usable[i - 1].at;
    if (dt > 0) deltas.push(dt);
  }

  const expectedIntervalMs = resolveExpectedInterval(options.expectedIntervalMs, deltas);
  const maxGapMs = resolveMaxGap(options, expectedIntervalMs);

  let joules = 0;
  let measuredMs = 0;
  for (let i = 1; i < usable.length; i += 1) {
    const dt = usable[i].at - usable[i - 1].at;
    if (dt <= 0) continue;
    if (dt > maxGapMs) {
      // Broken series: the gap is not measured, so it is not integrated.
      continue;
    }
    joules += 0.5 * (usable[i - 1].powerW + usable[i].powerW) * (dt / MILLIS_PER_SECOND);
    measuredMs += dt;
  }

  const avgPowerW =
    measuredMs > 0 ? joules / (measuredMs / MILLIS_PER_SECOND) : average(usable.map((s) => s.powerW));

  return {
    joules,
    wattHours: joules / SECONDS_PER_HOUR,
    avgPowerW,
    peakPowerW,
    measuredMs,
  };
}

/** Extra information the summary carries about the measurement itself. */
export interface SumEnergiesOptions {
  /**
   * Nominal sampling period of the measurement, in milliseconds.
   *
   * It is the resolution of the measurement and travels with the summary so
   * that any caller can tell whether the measured window was long enough to
   * resolve the energy.
   */
  sampleIntervalMs?: number | null;
  /**
   * Duration of the run, in milliseconds.
   *
   * It is the denominator of the coverage: without it the coverage is unknown
   * and stays null.
   */
  durationMs?: number | null;
  /**
   * GPUs the measurement was supposed to cover.
   *
   * A selected GPU that reported nothing at all was NOT covered, so it drags
   * the window of the summary down to zero. When it is omitted, the GPUs of
   * the map itself are used.
   */
  uuids?: readonly GpuUuid[];
}

/**
 * Sums the energy of every participating GPU into a single summary.
 *
 * The temperature of the summary is the average of the per GPU averages (every
 * GPU weighs the same) and the maximum of the per GPU maxima. A GPU that never
 * reported a temperature does not drag the summary to zero: it simply does not
 * contribute to it.
 *
 * The window of the summary is the window covered for EVERY GPU, not the
 * longest one: a GPU that was only measured during part of the run makes the
 * whole measurement incomplete, and the coverage must say so.
 */
export function sumEnergies(
  perGpu: Record<string, EnergyPerGpu>,
  options: SumEnergiesOptions = {},
): EnergySummary {
  const copy: Record<string, EnergyPerGpu> = {};
  let joulesTotal = 0;
  let wattHoursTotal = 0;
  let maxTemperatureC: number | null = null;
  const averageTemperatures: number[] = [];
  const durationMs = options.durationMs ?? null;

  for (const [uuid, entry] of Object.entries(perGpu ?? {})) {
    if (!entry) continue;
    joulesTotal += entry.joules;
    wattHoursTotal += entry.wattHours;
    const coveredMs =
      typeof entry.measuredMs === 'number' && Number.isFinite(entry.measuredMs)
        ? entry.measuredMs
        : null;
    copy[uuid] = {
      joules: entry.joules,
      wattHours: entry.wattHours,
      avgPowerW: entry.avgPowerW,
      peakPowerW: entry.peakPowerW,
      measuredMs: coveredMs,
      coveragePct: coveragePercent(coveredMs, durationMs),
      avgTemperatureC: entry.avgTemperatureC ?? null,
      maxTemperatureC: entry.maxTemperatureC ?? null,
    };

    if (typeof entry.avgTemperatureC === 'number' && Number.isFinite(entry.avgTemperatureC)) {
      averageTemperatures.push(entry.avgTemperatureC);
    }
    if (typeof entry.maxTemperatureC === 'number' && Number.isFinite(entry.maxTemperatureC)) {
      maxTemperatureC =
        maxTemperatureC === null ? entry.maxTemperatureC : Math.max(maxTemperatureC, entry.maxTemperatureC);
    }
  }

  // The window of the summary is the window covered for EVERY selected GPU.
  const scope =
    options.uuids && options.uuids.length > 0 ? options.uuids : Object.keys(perGpu ?? {});
  let measuredMs: number | null = null;
  for (const uuid of scope) {
    const entry = perGpu?.[uuid];
    const covered =
      entry && typeof entry.measuredMs === 'number' && Number.isFinite(entry.measuredMs)
        ? entry.measuredMs
        : 0; // this GPU was not measured at all
    measuredMs = measuredMs === null ? covered : Math.min(measuredMs, covered);
  }

  return {
    joulesTotal,
    wattHoursTotal,
    perGpu: copy,
    measuredMs,
    coveragePct: coveragePercent(measuredMs, durationMs),
    sampleIntervalMs: options.sampleIntervalMs ?? null,
    avgTemperatureC:
      averageTemperatures.length > 0 ? roundTo(average(averageTemperatures), 2) : null,
    maxTemperatureC,
  };
}

/**
 * Fraction of the run that was really measured, in percent.
 *
 * Null whenever it cannot be computed: an unknown window or an unknown
 * duration is never reported as zero percent.
 */
export function coveragePercent(
  coveredMs: number | null | undefined,
  durationMs: number | null | undefined,
): number | null {
  if (typeof coveredMs !== 'number' || !Number.isFinite(coveredMs)) return null;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return roundTo((coveredMs / durationMs) * 100, 2);
}

/** Extra information the caller knows about the measurement. */
export interface EfficiencyOptions {
  /**
   * Sampling resolution of the measurement, in milliseconds.
   *
   * Defaults to the resolution carried by the summary. A measured window
   * shorter than one sampling period cannot resolve any energy, so the result
   * is `null` instead of a made up number.
   */
  sampleIntervalMs?: number | null;
  /**
   * Minimum fraction of the run that must have been measured, in percent.
   *
   * Defaults to {@link MINIMUM_COVERAGE_PCT}. A measurement that covered less
   * than that only describes the part of the workload that was measured, so
   * its joules cannot be divided by the whole workload.
   */
  minimumCoveragePct?: number | null;
}

/**
 * Normalises the energy by the amount of work that was produced.
 *
 * The result is `null` whenever the figure cannot be derived from real
 * measurements:
 *
 *  - the workload did not report what it produced (manual measurement, or a
 *    workload whose output cannot be counted);
 *  - no energy was measured at all (`joulesTotal <= 0`): zero joules is not a
 *    measurement, it is the absence of one;
 *  - the measured window was shorter than the sampling resolution, so the
 *    energy of the workload was never really resolved;
 *  - the driver only answered part of the time, so the joules describe the
 *    measured window and not the whole workload;
 *  - the coverage of the measurement is UNKNOWN: the run describes an unknown
 *    part of the workload, so there is no evidence that the joules cover it.
 */
export function efficiency(
  energy: EnergySummary,
  throughput: ThroughputResult | null,
  options: EfficiencyOptions = {},
): EfficiencyResult {
  const unit: ThroughputUnit = throughput ? throughput.unit : 'unknown';
  const count = throughput ? throughput.count : 0;

  if (!throughput || throughput.count <= 0 || throughput.unit === 'unknown') {
    return { joulesPerUnit: null, wattHoursPerUnit: null, unit, count };
  }

  const unresolved: EfficiencyResult = {
    joulesPerUnit: null,
    wattHoursPerUnit: null,
    unit,
    count,
  };

  if (!energy) return unresolved;

  // The energy must have been really measured: zero joules is not a number.
  if (!Number.isFinite(energy.joulesTotal) || energy.joulesTotal <= 0) return unresolved;

  // A window that was never measured cannot prove anything.
  const measuredMs = energy.measuredMs;
  if (typeof measuredMs !== 'number' || !Number.isFinite(measuredMs) || measuredMs <= 0) {
    return unresolved;
  }

  const sampleIntervalMs = options.sampleIntervalMs ?? energy.sampleIntervalMs ?? null;
  if (
    typeof sampleIntervalMs === 'number' &&
    Number.isFinite(sampleIntervalMs) &&
    sampleIntervalMs > 0 &&
    measuredMs < sampleIntervalMs
  ) {
    // The workload finished before a single sampling period elapsed: the
    // energy is below the resolution of the measurement.
    return unresolved;
  }

  // The joules only describe the window that was really measured. When that
  // window is a small part of the run, dividing them by the whole workload
  // would invent an efficiency that was never observed.
  //
  // An UNKNOWN coverage is not a complete coverage: it describes an unknown
  // part of the workload, so the joules cannot be divided by the whole
  // workload either. The coverage must be known AND sufficient.
  const minimumCoveragePct = options.minimumCoveragePct ?? MINIMUM_COVERAGE_PCT;
  const coveragePct = energy.coveragePct;
  if (
    typeof coveragePct !== 'number' ||
    !Number.isFinite(coveragePct) ||
    coveragePct < minimumCoveragePct
  ) {
    return unresolved;
  }

  return {
    joulesPerUnit: energy.joulesTotal / throughput.count,
    wattHoursPerUnit: energy.wattHoursTotal / throughput.count,
    unit: throughput.unit,
    count: throughput.count,
  };
}

/** Arithmetic mean of the finite values. An empty list averages to zero. */
export function average(values: readonly number[]): number {
  const usable = (Array.isArray(values) ? values : []).filter(
    (v) => typeof v === 'number' && Number.isFinite(v),
  );
  if (usable.length === 0) return 0;
  let total = 0;
  for (const value of usable) total += value;
  return total / usable.length;
}

/** Rounds to a fixed number of decimals, avoiding floating point noise. */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Options of the integration of the samples of a benchmark run. */
export interface EnergyFromMeasurementsOptions extends IntegrateEnergyOptions {
  /**
   * GPUs the user selected for this measurement.
   *
   * It is REQUIRED on purpose: the energy of a run is the energy of the GPUs
   * that took part in it. A GPU that merely happened to be visible in the
   * samples must never be added to the total, otherwise one run produces
   * three different numbers on screen (the total, the selected GPU and the
   * idle GPU next to it).
   */
  uuids: readonly GpuUuid[];
  /**
   * Duration of the run, in milliseconds.
   *
   * It is the denominator of the coverage: the joules only describe the
   * measured window, and the coverage tells how much of the run that was.
   */
  durationMs?: number | null;
}

/**
 * Integrates the samples of a benchmark run, per GPU, and sums them.
 *
 * Only the selected GPUs are integrated: the total is the energy of the
 * workload the user measured, not the energy of every GPU the driver happened
 * to report.
 *
 * A GPU that never reported a power reading simply does not appear in the
 * result: its energy is unknown, not zero. The temperature is read from the
 * very same measurements: a GPU that never reported one gets `null`, never 0 °C.
 */
export function energyFromMeasurements(
  measurements: readonly BenchmarkMeasurement[],
  options: EnergyFromMeasurementsOptions,
): EnergySummary {
  const selected = new Set<string>(
    Array.isArray(options.uuids) ? options.uuids : ([] as readonly GpuUuid[]),
  );
  const byGpu = new Map<string, EnergySample[]>();
  const temperatures = new Map<string, number[]>();

  for (const measurement of Array.isArray(measurements) ? measurements : []) {
    if (!measurement || typeof measurement !== 'object') continue;
    const power = measurement.powerW;
    if (power && typeof power === 'object') {
      for (const [uuid, watts] of Object.entries(power)) {
        // The scope of the measurement: only the selected GPUs count.
        if (!selected.has(uuid)) continue;
        if (typeof watts !== 'number' || !Number.isFinite(watts) || watts < 0) continue;
        const list = byGpu.get(uuid);
        if (list) {
          list.push({ at: measurement.at, powerW: watts });
        } else {
          byGpu.set(uuid, [{ at: measurement.at, powerW: watts }]);
        }
      }
    }

    const temperature = measurement.temperatureC;
    if (!temperature || typeof temperature !== 'object') continue;
    for (const [uuid, celsius] of Object.entries(temperature)) {
      if (!selected.has(uuid)) continue;
      if (typeof celsius !== 'number' || !Number.isFinite(celsius)) continue;
      const list = temperatures.get(uuid);
      if (list) {
        list.push(celsius);
      } else {
        temperatures.set(uuid, [celsius]);
      }
    }
  }

  const perGpu: Record<string, EnergyPerGpu> = {};
  for (const [uuid, samples] of byGpu) {
    const integrated = integrateEnergy(samples, options);
    const measured = temperatures.get(uuid) ?? [];
    perGpu[uuid] = {
      joules: roundTo(integrated.joules, 4),
      wattHours: roundTo(integrated.wattHours, 8),
      avgPowerW: roundTo(integrated.avgPowerW, 4),
      peakPowerW: roundTo(integrated.peakPowerW, 4),
      measuredMs: integrated.measuredMs,
      avgTemperatureC: measured.length > 0 ? roundTo(average(measured), 2) : null,
      maxTemperatureC: measured.length > 0 ? roundTo(Math.max(...measured), 2) : null,
    };
  }

  return sumEnergies(perGpu, {
    sampleIntervalMs: options.expectedIntervalMs ?? null,
    durationMs: options.durationMs ?? null,
    uuids: selected.size > 0 ? [...selected] : undefined,
  });
}

/* ------------------------------------------------------- rules about a run */

/**
 * The GPUs a run was configured for.
 *
 * The energy of a run is the energy of the GPUs that took part in it: a GPU
 * that merely happened to be visible in the samples must never be added.
 */
export function scopeOfRun(run: BenchmarkResult | null | undefined): GpuUuid[] {
  if (!run) return [];
  const uuids = run.config?.uuids;
  return Array.isArray(uuids) ? [...uuids] : [];
}

/**
 * Restricts an energy summary to the GPUs a run was configured for.
 *
 * A summary the engine already scoped is returned untouched. A summary that
 * still carries other GPUs is restricted here.
 *
 * The coverage NEVER disappears while re-scoping: the joules of the summary
 * only describe the measured window, and that window is a fraction of the
 * run. When the duration of the run is known the coverage is recomputed
 * against it; when it is not, the coverage the engine published is carried
 * over. The engine, the optimiser and the renderer therefore always talk about
 * the same coverage of the same run.
 */
export function scopeEnergy(
  summary: EnergySummary | null | undefined,
  uuids: readonly GpuUuid[],
  durationMs?: number | null,
): EnergySummary | null {
  if (!summary) return null;
  if (!Array.isArray(uuids) || uuids.length === 0) return null;

  const present = uuids.filter((uuid) => summary.perGpu?.[uuid]);
  if (present.length === 0) return null;

  const carried = Object.keys(summary.perGpu ?? {});
  if (present.length === uuids.length && carried.length === present.length) {
    // The engine already scoped the summary to the selected GPUs.
    return summary;
  }

  const picked: Record<string, EnergyPerGpu> = {};
  for (const uuid of present) picked[uuid] = summary.perGpu[uuid];

  const scoped = sumEnergies(picked, {
    sampleIntervalMs: summary.sampleIntervalMs ?? null,
    durationMs: durationMs ?? impliedDurationMs(summary),
    uuids: present,
  });

  // The coverage the engine published is the evidence of the measurement: it
  // travels with the summary when it cannot be recomputed.
  const published = summary.coveragePct;
  if (
    scoped.coveragePct === null &&
    typeof published === 'number' &&
    Number.isFinite(published)
  ) {
    scoped.coveragePct = published;
  }

  return scoped;
}

/**
 * Duration of the run a summary describes, in milliseconds.
 *
 * It can be recovered from the coverage the engine published: the coverage is
 * the measured window divided by the duration of the run. It stays `null` when
 * the coverage is unknown, so nothing is ever invented.
 */
function impliedDurationMs(summary: EnergySummary): number | null {
  const coverage = summary.coveragePct;
  const measuredMs = summary.measuredMs;
  if (typeof coverage !== 'number' || !Number.isFinite(coverage) || coverage <= 0) return null;
  if (typeof measuredMs !== 'number' || !Number.isFinite(measuredMs) || measuredMs <= 0) return null;
  return measuredMs / (coverage / 100);
}

/**
 * Window really measured for a run, milliseconds.
 *
 * `null` when the engine did not report it: a missing window is unknown, never
 * zero.
 */
export function measuredMsOfRun(run: BenchmarkResult | null | undefined): number | null {
  if (!run) return null;
  const fromRun = run.measuredMs;
  if (typeof fromRun === 'number' && Number.isFinite(fromRun)) return fromRun;
  const summary = run.energy;
  if (!summary) return null;
  const fromSummary = summary.measuredMs;
  if (typeof fromSummary === 'number' && Number.isFinite(fromSummary)) return fromSummary;
  const values: number[] = [];
  for (const uuid of scopeOfRun(run)) {
    const measured = summary.perGpu?.[uuid]?.measuredMs;
    if (typeof measured === 'number' && Number.isFinite(measured)) values.push(measured);
  }
  if (values.length === 0) return null;
  return Math.min(...values);
}

/**
 * Coverage of a run, percent.
 *
 * `null` when the coverage of the run was never established: an unknown
 * coverage is not a coverage of zero, it is the absence of one.
 */
export function coverageOfRun(run: BenchmarkResult | null | undefined): number | null {
  if (!run) return null;
  const published = run.coveragePct;
  if (typeof published === 'number' && Number.isFinite(published)) return published;
  const summary = run.energy;
  if (!summary) return null;
  const fromSummary = summary.coveragePct;
  if (typeof fromSummary === 'number' && Number.isFinite(fromSummary)) return fromSummary;
  const values: number[] = [];
  for (const uuid of scopeOfRun(run)) {
    const coverage = summary.perGpu?.[uuid]?.coveragePct;
    if (typeof coverage === 'number' && Number.isFinite(coverage)) values.push(coverage);
  }
  if (values.length === 0) return null;
  return Math.min(...values);
}

/**
 * True when a run carries a complete, resolved measurement.
 *
 * This is the SINGLE rule shared by the engine, the optimiser and the renderer:
 * a run is fully measured when it has a positive energy, a measured window and
 * a coverage that is KNOWN and at or above {@link MINIMUM_COVERAGE_PCT}.
 *
 * An unknown coverage is never a complete measurement: it describes an unknown
 * part of the workload, so the joules cannot be divided by the whole workload
 * and the run must never be ranked against another one.
 */
export function isFullyMeasured(run: BenchmarkResult | null | undefined): boolean {
  if (!run || !run.energy) return false;

  const scoped = scopeEnergy(run.energy, scopeOfRun(run));
  if (!scoped) return false;
  if (!Number.isFinite(scoped.joulesTotal) || scoped.joulesTotal <= 0) return false;

  const scopedWindow = scoped.measuredMs ?? null;
  if (typeof scopedWindow !== 'number' || !Number.isFinite(scopedWindow) || scopedWindow <= 0) {
    return false;
  }

  const measuredMs = measuredMsOfRun(run);
  if (measuredMs === null || measuredMs <= 0) return false;

  const coverage = coverageOfRun(run);
  if (coverage === null || coverage < MINIMUM_COVERAGE_PCT) return false;

  return true;
}
