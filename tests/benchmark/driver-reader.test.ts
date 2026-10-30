import { describe, expect, it, vi } from 'vitest';
import {
  BENCHMARK_SAMPLE_INTERVAL_MS,
  createDriverPowerReader,
  driverPowerQueryArgs,
  parseDriverPowerCsv,
} from '../../src/main/benchmark/driver-reader';

const GPU_A = 'GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1';
const GPU_B = 'GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646';

describe('driverPowerQueryArgs', () => {
  it('asks the driver for the fields the benchmark needs', () => {
    const args = driverPowerQueryArgs();

    expect(args).toEqual([
      '--query-gpu=uuid,power.draw,temperature.gpu,power.limit',
      '--format=csv,noheader,nounits',
    ]);
  });

  it('never builds a shell command string', () => {
    const args = driverPowerQueryArgs();

    for (const arg of args) {
      expect(arg).not.toMatch(/[;&|`$><\n\r\\]/);
      expect(arg).not.toContain(' ');
    }
  });

  it('samples fast enough to resolve a short workload', () => {
    // At least 4 Hz: a workload of a few hundred milliseconds must produce
    // more than one sample.
    expect(BENCHMARK_SAMPLE_INTERVAL_MS).toBeLessThanOrEqual(250);
  });
});

describe('parseDriverPowerCsv', () => {
  it('reads the power, the temperature and the limit of every GPU', () => {
    const csv = [
      `${GPU_A}, 87.5, 61, 285`,
      `${GPU_B}, 42.25, 48, 180`,
    ].join('\n');

    const readings = parseDriverPowerCsv(csv);

    expect(readings).toEqual([
      { uuid: GPU_A, watts: 87.5, temperatureC: 61, limitW: 285 },
      { uuid: GPU_B, watts: 42.25, temperatureC: 48, limitW: 180 },
    ]);
  });

  it('keeps a missing reading as null, never zero', () => {
    const csv = `${GPU_A}, [N/A], [N/A], [N/A]`;

    const readings = parseDriverPowerCsv(csv);

    expect(readings).toEqual([
      { uuid: GPU_A, watts: null, temperatureC: null, limitW: null },
    ]);
  });

  it('keeps a missing limit as null, never zero', () => {
    const csv = `${GPU_A}, 87.5, 61, [N/A]`;

    const readings = parseDriverPowerCsv(csv);

    expect(readings[0].limitW).toBeNull();
  });

  it('ignores a row without a valid uuid', () => {
    const csv = ['not-a-uuid, 10, 20, 30', `${GPU_A}, 10, 20, 30`].join('\n');

    const readings = parseDriverPowerCsv(csv);

    expect(readings).toHaveLength(1);
    expect(readings[0].uuid).toBe(GPU_A);
  });

  it('returns nothing for an empty payload', () => {
    expect(parseDriverPowerCsv('')).toEqual([]);
  });
});

describe('createDriverPowerReader', () => {
  it('queries the driver once per reading', async () => {
    const query = vi.fn(async () => `${GPU_A}, 100, 60, 285`);

    const reader = createDriverPowerReader({ query });
    const readings = await reader();

    expect(query).toHaveBeenCalledTimes(1);
    expect(readings).toEqual([
      { uuid: GPU_A, watts: 100, temperatureC: 60, limitW: 285 },
    ]);
  });
});
