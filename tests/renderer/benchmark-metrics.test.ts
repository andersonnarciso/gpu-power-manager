/**
 * The rules that decide whether a measurement may be published and compared.
 */

import { describe, expect, it } from 'vitest';
import {
  arePeerRuns,
  comparablePairRuns,
  comparableRuns,
  evidenceOf,
  isComparableRun,
  isEnergyMeasured,
  isFullyMeasured,
  limitStatusOf,
  measuredJoules,
  runCoveragePct,
  runMeasuredMs,
  runScope,
  scopedEnergy,
} from '@renderer/lib/benchmark-metrics';
import { createRun, GPU_UUID, OTHER_GPU_UUID } from './helpers/dom';

describe('benchmark metrics', () => {
  it('reads the evidence of a run and never turns a missing field into a zero', () => {
    const evidence = evidenceOf(null);
    expect(evidence.measuredMs).toBeNull();
    expect(evidence.coveragePct).toBeNull();
    expect(evidence.limitVerified).toBeNull();
    expect(evidence.observedLimitsW).toBeNull();

    const run = createRun({ id: 'a', name: 'A' });
    expect(evidenceOf(run).measuredMs).toBe(30_000);
    expect(evidenceOf(run).coveragePct).toBe(100);
    expect(evidenceOf(run).limitVerified).toBe(true);
  });

  it('scopes the energy of a run to the GPUs it covered', () => {
    const run = createRun({ id: 'a', name: 'A', joules: 1200 });
    const scoped = scopedEnergy(run.energy, runScope(run));
    expect(scoped?.joulesTotal).toBe(1200);
    expect(scoped?.coveragePct).toBe(100);

    // A summary that carries another GPU is restricted to the selected one.
    const polluted = {
      ...(run.energy as NonNullable<typeof run.energy>),
      joulesTotal: 2000,
      perGpu: {
        ...(run.energy as NonNullable<typeof run.energy>).perGpu,
        [OTHER_GPU_UUID]: {
          joules: 800,
          wattHours: 800 / 3600,
          avgPowerW: 80,
          peakPowerW: 90,
          measuredMs: 30_000,
          coveragePct: 100,
        },
      },
    };
    const restricted = scopedEnergy(polluted, [GPU_UUID], 30_000);
    expect(restricted?.joulesTotal).toBe(1200);
    expect(restricted?.perGpu[OTHER_GPU_UUID]).toBeUndefined();
  });

  it('never publishes an energy that was not measured', () => {
    const run = createRun({ id: 'a', name: 'A', joules: 0, measuredMs: 0 });
    expect(isEnergyMeasured(run.energy)).toBe(false);
    expect(measuredJoules(run.energy)).toBeNull();

    const measured = createRun({ id: 'b', name: 'B', joules: 1200 });
    expect(isEnergyMeasured(measured.energy)).toBe(true);
    expect(measuredJoules(measured.energy)).toBe(1200);
  });

  it('requires a measured window and a coverage at or above the threshold', () => {
    const complete = createRun({ id: 'a', name: 'A', joules: 1200 });
    expect(isFullyMeasured(complete)).toBe(true);
    expect(runMeasuredMs(complete)).toBe(30_000);
    expect(runCoveragePct(complete)).toBe(100);

    const noWindow = createRun({ id: 'b', name: 'B', joules: 1200, measuredMs: 0 });
    expect(isFullyMeasured(noWindow)).toBe(false);

    const lowCoverage = createRun({ id: 'c', name: 'C', joules: 1200, coveragePct: 10 });
    expect(isFullyMeasured(lowCoverage)).toBe(false);
  });

  it('never offers an aborted run, an unverified limit or a run with no throughput', () => {
    const aborted = createRun({ id: 'a', name: 'A', status: 'aborted', joules: 1200 });
    expect(isComparableRun(aborted)).toBe(false);

    const notApplied = createRun({
      id: 'b',
      name: 'B',
      limitVerified: false,
      observedLimitW: 285,
      joules: 1200,
    });
    expect(isComparableRun(notApplied)).toBe(false);
    expect(limitStatusOf(notApplied)).toBe('not-applied');

    // The optimiser refuses a run whose limit was not confirmed
    // (`run.limitVerified !== true`). The panel must offer exactly the runs
    // the optimiser accepts, otherwise a selection ends in an error toast
    // instead of a filtered list.
    const unknown = createRun({ id: 'c', name: 'C', limitVerified: null, joules: 1200 });
    expect(limitStatusOf(unknown)).toBe('unknown');
    expect(isComparableRun(unknown)).toBe(false);

    // A run whose workload never reported what it produced is refused too.
    const noThroughput = createRun({
      id: 'd',
      name: 'D',
      adapterId: 'ollama',
      throughput: null,
      joules: 1200,
    });
    expect(isComparableRun(noThroughput)).toBe(false);

    // A manual run has no adapter, so "no throughput" is expected and stays
    // comparable when its limit was confirmed.
    const manual = createRun({
      id: 'e',
      name: 'E',
      adapterId: null,
      workload: 'manual',
      throughput: null,
      joules: 1200,
    });
    expect(isComparableRun(manual)).toBe(true);
  });

  it('only compares runs of the same adapter, workload and GPUs', () => {
    const base = createRun({ id: 'a', name: 'A', adapterId: 'ollama' });
    const same = createRun({ id: 'b', name: 'B', adapterId: 'ollama', watts: 180 });
    const otherAdapter = createRun({ id: 'c', name: 'C', adapterId: 'llama-server' });
    const otherWorkload = createRun({
      id: 'd',
      name: 'D',
      adapterId: 'ollama',
      workload: 'image-generation',
    });
    const otherGpus = createRun({
      id: 'e',
      name: 'E',
      adapterId: 'ollama',
      uuids: [OTHER_GPU_UUID],
    });

    expect(arePeerRuns(base, same)).toBe(true);
    expect(arePeerRuns(base, otherAdapter)).toBe(false);
    expect(arePeerRuns(base, otherWorkload)).toBe(false);
    expect(arePeerRuns(base, otherGpus)).toBe(false);
  });

  it('only offers the runs that have a peer to be compared with', () => {
    const runs = [
      createRun({ id: 'a', name: 'A', adapterId: 'ollama', joules: 1200 }),
      createRun({ id: 'b', name: 'B', adapterId: 'ollama', joules: 900, watts: 180 }),
      createRun({ id: 'c', name: 'C', adapterId: 'llama-server', joules: 800 }),
      createRun({ id: 'd', name: 'D', adapterId: 'ollama', status: 'aborted' }),
    ];

    expect(comparableRuns(runs).map((run) => run.id)).toEqual(['a', 'b', 'c']);
    expect(comparablePairRuns(runs).map((run) => run.id)).toEqual(['a', 'b']);
  });
});
