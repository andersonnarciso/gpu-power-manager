import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PowerSampler,
  powerReaderFromDevices,
  powerReaderFromTelemetry,
} from '../../src/main/benchmark/power-sampler';
import type { GpuDevice } from '../../src/shared/types';

const GPU_A = 'GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1';
const GPU_B = 'GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646';

afterEach(() => {
  vi.useRealTimers();
});

describe('PowerSampler', () => {
  it('records one sample per interval', async () => {
    vi.useFakeTimers();
    const reader = vi.fn(async () => [{ uuid: GPU_A, watts: 100 }]);
    const sampler = new PowerSampler(reader, { intervalMs: 1000 });

    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sampler.samples).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sampler.samples).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sampler.samples).toHaveLength(3);

    sampler.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sampler.samples).toHaveLength(3);
  });

  it('skips a failed tick and keeps sampling', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const reader = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('falha na leitura');
      return [{ uuid: GPU_A, watts: 100 }];
    });

    const sampler = new PowerSampler(reader, { intervalMs: 1000 });
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(sampler.failures).toBe(1);
    expect(sampler.samples).toHaveLength(1);
    expect(sampler.samples[0].powerW[GPU_A]).toBe(100);
  });

  it('leaves a GPU out of the sample when it did not report a reading', async () => {
    vi.useFakeTimers();
    const reader = vi.fn(async () => [
      { uuid: GPU_A, watts: 100 },
      { uuid: GPU_B, watts: null },
    ]);

    const sampler = new PowerSampler(reader, { intervalMs: 1000 });
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);

    const sample = sampler.samples[0];
    expect(sample.powerW[GPU_A]).toBe(100);
    expect('powerW' in sample.powerW && GPU_B in sample.powerW).toBe(false);
    expect(Object.keys(sample.powerW)).toEqual([GPU_A]);
  });

  it('never reports a negative or invalid power', async () => {
    vi.useFakeTimers();
    const reader = vi.fn(async () => [
      { uuid: GPU_A, watts: -10 },
      { uuid: GPU_B, watts: Number.NaN },
    ]);

    const sampler = new PowerSampler(reader, { intervalMs: 1000 });
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(Object.keys(sampler.samples[0].powerW)).toHaveLength(0);
  });

  it('takes one extra reading to close the window of a finished run', async () => {
    vi.useFakeTimers();
    const reader = vi.fn(async () => [{ uuid: GPU_A, watts: 100 }]);
    const sampler = new PowerSampler(reader, { intervalMs: 1000 });

    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sampler.samples).toHaveLength(1);

    sampler.stop();
    await sampler.sampleOnce();

    expect(sampler.samples).toHaveLength(2);
    expect(sampler.samples[1].powerW[GPU_A]).toBe(100);
  });

  it('does not read twice while the periodic tick is in charge', async () => {
    vi.useFakeTimers();
    const reader = vi.fn(async () => [{ uuid: GPU_A, watts: 100 }]);
    const sampler = new PowerSampler(reader, { intervalMs: 1000 });

    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    await sampler.sampleOnce();

    expect(sampler.samples).toHaveLength(1);
  });
});

describe('power readers', () => {
  it('maps the devices of the telemetry engine', async () => {
    const device = {
      uuid: GPU_A,
      power: { drawW: 87.5, limitW: 200 },
      temperatureC: 61,
    } as unknown as GpuDevice;

    const reader = powerReaderFromDevices(() => [device]);
    const readings = await reader();

    expect(readings).toEqual([
      { uuid: GPU_A, watts: 87.5, temperatureC: 61, limitW: 200 },
    ]);
  });

  it('maps a telemetry snapshot', async () => {
    const reader = powerReaderFromTelemetry(() => ({
      at: 1000,
      gpus: [{ uuid: GPU_A, power: { drawW: 42 }, temperatureC: 55 } as unknown as GpuDevice],
    }));

    const readings = await reader();
    expect(readings).toEqual([
      { uuid: GPU_A, watts: 42, temperatureC: 55, limitW: null },
    ]);
  });

  it('reports a null power when the driver does not expose it', async () => {
    const reader = powerReaderFromDevices(() => [
      { uuid: GPU_A, power: { drawW: null } } as unknown as GpuDevice,
    ]);

    const readings = await reader();
    expect(readings).toEqual([
      { uuid: GPU_A, watts: null, temperatureC: null, limitW: null },
    ]);
  });

  it('reports a null temperature when the driver does not expose it', async () => {
    const reader = powerReaderFromDevices(() => [
      { uuid: GPU_A, power: { drawW: 10 }, temperatureC: null } as unknown as GpuDevice,
    ]);

    const readings = await reader();
    expect(readings).toEqual([
      { uuid: GPU_A, watts: 10, temperatureC: null, limitW: null },
    ]);
  });
});

describe('the sampler and the power limit', () => {
  it('records the limit the driver really reports', async () => {
    vi.useFakeTimers();
    const reader = vi.fn(async () => [{ uuid: GPU_A, watts: 100, limitW: 285 }]);

    const sampler = new PowerSampler(reader, { intervalMs: 200 });
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    sampler.stop();

    // The limit is observed, never applied: the benchmark never writes to
    // the driver.
    expect(sampler.samples[0].powerLimitW?.[GPU_A]).toBe(285);
  });

  it('leaves the limit out of the sample when nobody reported one', async () => {
    vi.useFakeTimers();
    const reader = vi.fn(async () => [{ uuid: GPU_A, watts: 100, limitW: null }]);

    const sampler = new PowerSampler(reader, { intervalMs: 200 });
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    sampler.stop();

    expect(sampler.samples[0].powerLimitW).toBeUndefined();
  });
});

describe('the sampler and the temperature', () => {
  it('records the temperature of every GPU that reported one', async () => {
    vi.useFakeTimers();
    const reader = vi.fn(async () => [
      { uuid: GPU_A, watts: 100, temperatureC: 62 },
      { uuid: GPU_B, watts: 50, temperatureC: null },
    ]);

    const sampler = new PowerSampler(reader, { intervalMs: 200 });
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    sampler.stop();

    const sample = sampler.samples[0];
    expect(sample.temperatureC?.[GPU_A]).toBe(62);
    // The GPU that did not report a temperature is absent, never zero.
    expect(sample.temperatureC && GPU_B in sample.temperatureC).toBe(false);
  });

  it('leaves the temperature out of the sample when nobody reported one', async () => {
    vi.useFakeTimers();
    const reader = vi.fn(async () => [{ uuid: GPU_A, watts: 100, temperatureC: null }]);

    const sampler = new PowerSampler(reader, { intervalMs: 200 });
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    sampler.stop();

    expect(sampler.samples[0].temperatureC).toBeUndefined();
  });
});
