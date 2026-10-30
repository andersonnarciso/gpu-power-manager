import { describe, expect, it } from 'vitest';
import {
  average,
  efficiency,
  energyFromMeasurements,
  integrateEnergy,
  sumEnergies,
} from '../../src/shared/energy';
import type {
  BenchmarkMeasurement,
  EnergyPerGpu,
  ThroughputResult,
} from '../../src/shared/types';

const GPU_A = 'GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1';
const GPU_B = 'GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646';

describe('integrateEnergy', () => {
  it('integrates a constant 100 W series over 10 s into 1000 J', () => {
    const samples = Array.from({ length: 11 }, (_, index) => ({
      at: index * 1000,
      powerW: 100,
    }));

    const result = integrateEnergy(samples);

    expect(result.joules).toBeCloseTo(1000, 6);
    expect(result.wattHours).toBeCloseTo(1000 / 3600, 9);
    expect(result.wattHours).toBeCloseTo(0.2778, 4);
    expect(result.avgPowerW).toBeCloseTo(100, 6);
    expect(result.peakPowerW).toBeCloseTo(100, 6);
  });

  it('integrates an ascending series with the hand computed trapezoid value', () => {
    // 0 -> 100 W in 1 s, then 100 W -> 200 W in 1 s:
    //   (0 + 100) / 2 * 1 = 50 J, (100 + 200) / 2 * 1 = 150 J  =>  200 J
    const result = integrateEnergy([
      { at: 0, powerW: 0 },
      { at: 1000, powerW: 100 },
      { at: 2000, powerW: 200 },
    ]);

    expect(result.joules).toBeCloseTo(200, 6);
    expect(result.avgPowerW).toBeCloseTo(100, 6);
    expect(result.peakPowerW).toBeCloseTo(200, 6);
  });

  it('returns zeros for an empty series', () => {
    expect(integrateEnergy([])).toEqual({
      joules: 0,
      wattHours: 0,
      avgPowerW: 0,
      peakPowerW: 0,
      measuredMs: 0,
    });
  });

  it('returns zero energy but the measured power for a single sample', () => {
    const result = integrateEnergy([{ at: 1000, powerW: 123.4 }]);

    expect(result.joules).toBe(0);
    expect(result.wattHours).toBe(0);
    expect(result.avgPowerW).toBeCloseTo(123.4, 6);
    expect(result.peakPowerW).toBeCloseTo(123.4, 6);
  });

  it('exposes the window that was really measured', () => {
    const samples = Array.from({ length: 11 }, (_, index) => ({
      at: index * 1000,
      powerW: 100,
    }));

    const result = integrateEnergy(samples, { expectedIntervalMs: 1000 });

    // Ten intervals of one second: the window is measured, so the energy is
    // resolvable. A measurement that was not taken must stay distinguishable.
    expect(result.measuredMs).toBe(10_000);
    expect(result.joules).toBeCloseTo(1000, 6);
  });

  it('reports a zero measured window when nothing was integrated', () => {
    // A single sample has no duration: the energy is unknown, not zero watts.
    const single = integrateEnergy([{ at: 1000, powerW: 123.4 }]);
    expect(single.measuredMs).toBe(0);

    // A gap breaks the series: nothing is integrated across it.
    const broken = integrateEnergy(
      [
        { at: 0, powerW: 100 },
        { at: 61_000, powerW: 100 },
      ],
      { expectedIntervalMs: 1000 },
    );
    expect(broken.measuredMs).toBe(0);
    expect(broken.joules).toBe(0);
  });

  it('ignores NaN and negative power samples', () => {
    const result = integrateEnergy(
      [
        { at: 0, powerW: 100 },
        { at: 1000, powerW: Number.NaN },
        { at: 2000, powerW: -50 },
        { at: 3000, powerW: 100 },
      ],
      { expectedIntervalMs: 1000 },
    );

    // The invalid samples are dropped, so the two valid ones are 3 s apart:
    // that is longer than 2.5 x the expected interval and nothing is integrated.
    expect(result.joules).toBe(0);
    expect(result.peakPowerW).toBeCloseTo(100, 6);
  });

  it('sorts a non monotonic series before integrating it', () => {
    const result = integrateEnergy([
      { at: 2000, powerW: 200 },
      { at: 0, powerW: 0 },
      { at: 1000, powerW: 100 },
    ]);

    expect(result.joules).toBeCloseTo(200, 6);
  });

  it('does not integrate across a gap of 60 s', () => {
    const samples = [
      { at: 0, powerW: 100 },
      { at: 1000, powerW: 100 },
      { at: 61_000, powerW: 100 },
      { at: 62_000, powerW: 100 },
    ];

    // With the expected interval known, only the two measured segments count:
    // 100 J + 100 J = 200 J instead of the 6200 J a naive integration would give.
    const withExpected = integrateEnergy(samples, { expectedIntervalMs: 1000 });
    expect(withExpected.joules).toBeCloseTo(200, 6);

    // The expected interval can also be derived from the series itself.
    const derived = integrateEnergy(samples);
    expect(derived.joules).toBeCloseTo(200, 6);
  });

  it('never integrates more energy than the measured segments allow', () => {
    const samples = [
      { at: 0, powerW: 100 },
      { at: 1000, powerW: 100 },
      { at: 61_000, powerW: 100 },
    ];

    const result = integrateEnergy(samples, { expectedIntervalMs: 1000 });

    // Only the first measured second (100 W for 1 s) is integrated.
    expect(result.joules).toBeCloseTo(100, 6);
    expect(result.joules).toBeLessThan(6200);
  });
});

describe('sumEnergies', () => {
  it('sums the energy of two GPUs', () => {
    const perGpu: Record<string, EnergyPerGpu> = {
      [GPU_A]: { joules: 1000, wattHours: 1000 / 3600, avgPowerW: 100, peakPowerW: 120 },
      [GPU_B]: { joules: 500, wattHours: 500 / 3600, avgPowerW: 50, peakPowerW: 60 },
    };

    const summary = sumEnergies(perGpu);

    expect(summary.joulesTotal).toBeCloseTo(1500, 6);
    expect(summary.wattHoursTotal).toBeCloseTo(1500 / 3600, 9);
    expect(Object.keys(summary.perGpu)).toHaveLength(2);
    expect(summary.perGpu[GPU_A].joules).toBe(1000);
  });

  it('returns zeros for an empty map', () => {
    const summary = sumEnergies({});
    expect(summary.joulesTotal).toBe(0);
    expect(summary.wattHoursTotal).toBe(0);
    expect(summary.perGpu).toEqual({});
  });

  it('keeps the measured window and the resolution of the measurement', () => {
    const summary = sumEnergies(
      {
        [GPU_A]: {
          joules: 1000,
          wattHours: 1000 / 3600,
          avgPowerW: 100,
          peakPowerW: 120,
          measuredMs: 10_000,
        },
      },
      { sampleIntervalMs: 200 },
    );

    expect(summary.measuredMs).toBe(10_000);
    expect(summary.sampleIntervalMs).toBe(200);
  });

  it('reports no temperature when none was measured', () => {
    const summary = sumEnergies({
      [GPU_A]: { joules: 10, wattHours: 0, avgPowerW: 10, peakPowerW: 10 },
    });

    expect(summary.avgTemperatureC).toBeNull();
    expect(summary.maxTemperatureC).toBeNull();
  });
});

describe('efficiency', () => {
  // The duration of the run is known, so the coverage of the measurement is
  // known too: the whole run was measured.
  const energy = sumEnergies(
    {
      [GPU_A]: {
        joules: 1000,
        wattHours: 1000 / 3600,
        avgPowerW: 100,
        peakPowerW: 120,
        measuredMs: 10_000,
      },
    },
    { sampleIntervalMs: 200, durationMs: 10_000 },
  );

  it('reports joules and watt-hours per token', () => {
    const throughput: ThroughputResult = {
      unit: 'token',
      count: 500,
      label: 'tokens gerados',
      source: 'teste',
    };

    const result = efficiency(energy, throughput);

    expect(result.joulesPerUnit).toBeCloseTo(2, 9);
    expect(result.wattHoursPerUnit).toBeCloseTo(2 / 3600, 12);
    expect(result.unit).toBe('token');
    expect(result.count).toBe(500);
  });

  it('reports watt-hours per image', () => {
    const throughput: ThroughputResult = {
      unit: 'image',
      count: 4,
      label: 'imagens',
      source: 'teste',
    };

    const result = efficiency(energy, throughput);

    expect(result.wattHoursPerUnit).toBeCloseTo(1000 / 3600 / 4, 12);
    expect(result.unit).toBe('image');
  });

  it('returns nulls when there is no throughput', () => {
    const result = efficiency(energy, null);

    expect(result.joulesPerUnit).toBeNull();
    expect(result.wattHoursPerUnit).toBeNull();
    expect(result.unit).toBe('unknown');
    expect(result.count).toBe(0);
  });

  it('returns nulls when the workload did not report what it produced', () => {
    const throughput: ThroughputResult = {
      unit: 'unknown',
      count: 0,
      label: 'tarefa manual',
      source: 'manual',
    };

    const result = efficiency(energy, throughput);

    expect(result.joulesPerUnit).toBeNull();
    expect(result.wattHoursPerUnit).toBeNull();
  });

  it('returns null, never zero, when no energy was measured', () => {
    const throughput: ThroughputResult = {
      unit: 'token',
      count: 32,
      label: 'tokens gerados',
      source: 'teste',
    };

    const measuredZero = sumEnergies({
      [GPU_A]: {
        joules: 0,
        wattHours: 0,
        avgPowerW: 0,
        peakPowerW: 0,
        measuredMs: 800,
      },
    });

    const result = efficiency(measuredZero, throughput);

    // Zero joules is the absence of a measurement, never a measurement.
    expect(result.joulesPerUnit).toBeNull();
    expect(result.wattHoursPerUnit).toBeNull();
    expect(result.unit).toBe('token');
    expect(result.count).toBe(32);
  });

  it('returns null when the measured window is shorter than the resolution', () => {
    const throughput: ThroughputResult = {
      unit: 'token',
      count: 128,
      label: 'tokens gerados',
      source: 'teste',
    };

    // The workload finished before a single sampling period elapsed.
    const tooShort = sumEnergies(
      {
        [GPU_A]: {
          joules: 12,
          wattHours: 12 / 3600,
          avgPowerW: 90,
          peakPowerW: 90,
          measuredMs: 150,
        },
      },
      { sampleIntervalMs: 200 },
    );

    const result = efficiency(tooShort, throughput);

    expect(result.joulesPerUnit).toBeNull();
    expect(result.wattHoursPerUnit).toBeNull();
  });

  it('returns null when the measured window is unknown', () => {
    const throughput: ThroughputResult = {
      unit: 'token',
      count: 128,
      label: 'tokens gerados',
      source: 'teste',
    };

    const unknown = sumEnergies({
      [GPU_A]: { joules: 12, wattHours: 12 / 3600, avgPowerW: 90, peakPowerW: 90 },
    });

    const result = efficiency(unknown, throughput);

    expect(result.joulesPerUnit).toBeNull();
    expect(result.wattHoursPerUnit).toBeNull();
  });

  it('reports the figure when the window really resolves the energy', () => {
    const throughput: ThroughputResult = {
      unit: 'token',
      count: 128,
      label: 'tokens gerados',
      source: 'teste',
    };

    const resolved = sumEnergies(
      {
        [GPU_A]: {
          joules: 12.8,
          wattHours: 12.8 / 3600,
          avgPowerW: 90,
          peakPowerW: 90,
          measuredMs: 800,
        },
      },
      { sampleIntervalMs: 200, durationMs: 800 },
    );

    const result = efficiency(resolved, throughput);

    expect(result.joulesPerUnit).toBeCloseTo(0.1, 9);
    expect(result.wattHoursPerUnit).toBeCloseTo(0.1 / 3600, 12);
  });

  it('returns null when the coverage of the measurement is unknown', () => {
    const throughput: ThroughputResult = {
      unit: 'token',
      count: 128,
      label: 'tokens gerados',
      source: 'teste',
    };

    // The duration of the run was never established, so the coverage is
    // unknown: the joules describe an unknown part of the workload and must
    // never be divided by the whole workload.
    const unknownCoverage = sumEnergies({
      [GPU_A]: {
        joules: 12.8,
        wattHours: 12.8 / 3600,
        avgPowerW: 90,
        peakPowerW: 90,
        measuredMs: 800,
      },
    });

    expect(unknownCoverage.coveragePct).toBeNull();

    const result = efficiency(unknownCoverage, throughput);

    expect(result.joulesPerUnit).toBeNull();
    expect(result.wattHoursPerUnit).toBeNull();
    expect(result.unit).toBe('token');
    expect(result.count).toBe(128);
  });

  it('returns null when the measurement covered only a part of the run', () => {
    const throughput: ThroughputResult = {
      unit: 'token',
      count: 128,
      label: 'tokens gerados',
      source: 'teste',
    };

    // The driver only answered during 200 ms of a run of one second: the
    // joules describe the measured window, not the whole workload.
    const partial = sumEnergies(
      {
        [GPU_A]: {
          joules: 20,
          wattHours: 20 / 3600,
          avgPowerW: 100,
          peakPowerW: 100,
          measuredMs: 200,
        },
      },
      { sampleIntervalMs: 200, durationMs: 1000 },
    );

    expect(partial.coveragePct).toBeCloseTo(20, 2);

    const result = efficiency(partial, throughput);

    expect(result.joulesPerUnit).toBeNull();
    expect(result.wattHoursPerUnit).toBeNull();
    expect(result.unit).toBe('token');
    expect(result.count).toBe(128);
  });

  it('accepts a measurement that covered the whole run', () => {
    const throughput: ThroughputResult = {
      unit: 'token',
      count: 128,
      label: 'tokens gerados',
      source: 'teste',
    };

    const complete = sumEnergies(
      {
        [GPU_A]: {
          joules: 100,
          wattHours: 100 / 3600,
          avgPowerW: 100,
          peakPowerW: 100,
          measuredMs: 1000,
        },
      },
      { sampleIntervalMs: 200, durationMs: 1000 },
    );

    const result = efficiency(complete, throughput);

    expect(result.joulesPerUnit).toBeCloseTo(100 / 128, 9);
  });
});

describe('average', () => {
  it('averages the finite values', () => {
    expect(average([10, 20, 30])).toBeCloseTo(20, 9);
    expect(average([10, Number.NaN, 30])).toBeCloseTo(20, 9);
  });

  it('returns zero for an empty list', () => {
    expect(average([])).toBe(0);
  });
});

describe('energyFromMeasurements', () => {
  it('integrates every GPU of the run and sums the result', () => {
    const measurements: BenchmarkMeasurement[] = [
      { at: 0, powerW: { [GPU_A]: 100, [GPU_B]: 50 } },
      { at: 1000, powerW: { [GPU_A]: 100, [GPU_B]: 50 } },
      { at: 2000, powerW: { [GPU_A]: 100, [GPU_B]: 50 } },
    ];

    const summary = energyFromMeasurements(measurements, {
      uuids: [GPU_A, GPU_B],
      expectedIntervalMs: 1000,
    });

    expect(summary.perGpu[GPU_A].joules).toBeCloseTo(200, 4);
    expect(summary.perGpu[GPU_B].joules).toBeCloseTo(100, 4);
    expect(summary.joulesTotal).toBeCloseTo(300, 4);
    expect(summary.wattHoursTotal).toBeCloseTo(300 / 3600, 7);
  });

  it('integrates only the GPUs the user selected', () => {
    // The user selected the 5060 Ti only. The other GPU was merely visible
    // in the samples: its energy is NOT part of this measurement.
    const measurements: BenchmarkMeasurement[] = [
      { at: 0, powerW: { [GPU_A]: 100, [GPU_B]: 50 } },
      { at: 1000, powerW: { [GPU_A]: 100, [GPU_B]: 50 } },
    ];

    const summary = energyFromMeasurements(measurements, {
      uuids: [GPU_A],
      expectedIntervalMs: 1000,
    });

    expect(Object.keys(summary.perGpu)).toEqual([GPU_A]);
    expect(summary.perGpu[GPU_A].joules).toBeCloseTo(100, 4);
    // The total is the sum of the SELECTED GPUs only.
    expect(summary.joulesTotal).toBeCloseTo(100, 4);
  });

  it('ignores a GPU that never reported a power reading', () => {
    const measurements: BenchmarkMeasurement[] = [
      { at: 0, powerW: { [GPU_A]: 100 } },
      { at: 1000, powerW: { [GPU_A]: 100 } },
    ];

    const summary = energyFromMeasurements(measurements, {
      uuids: [GPU_A],
      expectedIntervalMs: 1000,
    });

    expect(Object.keys(summary.perGpu)).toEqual([GPU_A]);
    expect(summary.joulesTotal).toBeCloseTo(100, 4);
  });

  it('exposes the measured window and the resolution of the measurement', () => {
    const measurements: BenchmarkMeasurement[] = [
      { at: 0, powerW: { [GPU_A]: 100 } },
      { at: 200, powerW: { [GPU_A]: 100 } },
      { at: 400, powerW: { [GPU_A]: 100 } },
    ];

    const summary = energyFromMeasurements(measurements, {
      uuids: [GPU_A],
      expectedIntervalMs: 200,
    });

    expect(summary.measuredMs).toBe(400);
    expect(summary.perGpu[GPU_A].measuredMs).toBe(400);
    expect(summary.sampleIntervalMs).toBe(200);
  });

  it('exposes the coverage of the run', () => {
    const measurements: BenchmarkMeasurement[] = [
      { at: 0, powerW: { [GPU_A]: 100 } },
      { at: 200, powerW: { [GPU_A]: 100 } },
      { at: 400, powerW: { [GPU_A]: 100 } },
    ];

    const summary = energyFromMeasurements(measurements, {
      uuids: [GPU_A],
      expectedIntervalMs: 200,
      durationMs: 500,
    });

    // 400 ms of the 500 ms run were really measured.
    expect(summary.measuredMs).toBe(400);
    expect(summary.coveragePct).toBeCloseTo(80, 2);
    expect(summary.perGpu[GPU_A].coveragePct).toBeCloseTo(80, 2);
  });

  it('reports no coverage when the duration of the run is unknown', () => {
    const measurements: BenchmarkMeasurement[] = [
      { at: 0, powerW: { [GPU_A]: 100 } },
      { at: 200, powerW: { [GPU_A]: 100 } },
    ];

    const summary = energyFromMeasurements(measurements, {
      uuids: [GPU_A],
      expectedIntervalMs: 200,
    });

    expect(summary.coveragePct).toBeNull();
    expect(summary.perGpu[GPU_A].coveragePct).toBeNull();
  });

  it('does not report a complete coverage when a selected GPU was never measured', () => {
    // The second GPU was selected but never answered: the measurement of the
    // run is incomplete, and it must say so.
    const measurements: BenchmarkMeasurement[] = [
      { at: 0, powerW: { [GPU_A]: 100 } },
      { at: 1000, powerW: { [GPU_A]: 100 } },
    ];

    const summary = energyFromMeasurements(measurements, {
      uuids: [GPU_A, GPU_B],
      expectedIntervalMs: 1000,
      durationMs: 1000,
    });

    expect(summary.measuredMs).toBe(0);
    expect(summary.coveragePct).toBe(0);
  });

  it('carries the measured temperature of every GPU', () => {
    const measurements: BenchmarkMeasurement[] = [
      {
        at: 0,
        powerW: { [GPU_A]: 100 },
        temperatureC: { [GPU_A]: 60 },
      },
      {
        at: 1000,
        powerW: { [GPU_A]: 100 },
        temperatureC: { [GPU_A]: 70 },
      },
      {
        at: 2000,
        powerW: { [GPU_A]: 100 },
        temperatureC: { [GPU_A]: 65 },
      },
    ];

    const summary = energyFromMeasurements(measurements, {
      uuids: [GPU_A],
      expectedIntervalMs: 1000,
    });

    expect(summary.perGpu[GPU_A].avgTemperatureC).toBeCloseTo(65, 2);
    expect(summary.perGpu[GPU_A].maxTemperatureC).toBeCloseTo(70, 2);
    expect(summary.avgTemperatureC).toBeCloseTo(65, 2);
    expect(summary.maxTemperatureC).toBeCloseTo(70, 2);
  });

  it('reports no temperature, never zero, when none was measured', () => {
    const measurements: BenchmarkMeasurement[] = [
      { at: 0, powerW: { [GPU_A]: 100 } },
      { at: 1000, powerW: { [GPU_A]: 100 } },
    ];

    const summary = energyFromMeasurements(measurements, {
      uuids: [GPU_A],
      expectedIntervalMs: 1000,
    });

    expect(summary.perGpu[GPU_A].avgTemperatureC).toBeNull();
    expect(summary.perGpu[GPU_A].maxTemperatureC).toBeNull();
    expect(summary.avgTemperatureC).toBeNull();
    expect(summary.maxTemperatureC).toBeNull();
  });

  it('keeps the temperature of a GPU that never reported a power reading out', () => {
    const measurements: BenchmarkMeasurement[] = [
      { at: 0, powerW: { [GPU_A]: 100 }, temperatureC: { [GPU_A]: 60, [GPU_B]: 40 } },
      { at: 1000, powerW: { [GPU_A]: 100 }, temperatureC: { [GPU_A]: 62, [GPU_B]: 41 } },
    ];

    const summary = energyFromMeasurements(measurements, {
      uuids: [GPU_A],
      expectedIntervalMs: 1000,
    });

    expect(Object.keys(summary.perGpu)).toEqual([GPU_A]);
    expect(summary.perGpu[GPU_A].avgTemperatureC).toBeCloseTo(61, 2);
  });

  it('scopes the temperature to the selected GPUs', () => {
    const measurements: BenchmarkMeasurement[] = [
      {
        at: 0,
        powerW: { [GPU_A]: 100, [GPU_B]: 50 },
        temperatureC: { [GPU_A]: 60, [GPU_B]: 40 },
      },
      {
        at: 1000,
        powerW: { [GPU_A]: 100, [GPU_B]: 50 },
        temperatureC: { [GPU_A]: 62, [GPU_B]: 41 },
      },
    ];

    const summary = energyFromMeasurements(measurements, {
      uuids: [GPU_A],
      expectedIntervalMs: 1000,
    });

    expect(Object.keys(summary.perGpu)).toEqual([GPU_A]);
    // The temperature of the idle GPU next door is not part of this run.
    expect(summary.avgTemperatureC).toBeCloseTo(61, 2);
    expect(summary.maxTemperatureC).toBeCloseTo(62, 2);
  });
});
