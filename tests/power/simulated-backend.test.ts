// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { SIMULATED_GPUS, SimulatedPowerState } from '../../src/shared/simulation';
import { ErrorCode } from '../../src/shared/types';
import { SimulatedPowerBackend } from '../../src/main/power/simulated-backend';
import { AppErrorException } from '../../src/main/privileged/errors';

const GPU_4070 = SIMULATED_GPUS[0].uuid;
const GPU_5060 = SIMULATED_GPUS[1].uuid;

describe('SimulatedPowerBackend', () => {
  it('is always marked as simulated', () => {
    expect(new SimulatedPowerBackend().isSimulated()).toBe(true);
  });

  it('reports the same range as the real hardware of the reference machine', async () => {
    const backend = new SimulatedPowerBackend();
    const bounds = await backend.bounds(GPU_5060);
    expect(bounds).toEqual({ min: 150, max: 180, defaultLimit: 180, current: 180 });
    const bounds4070 = await backend.bounds(GPU_4070);
    expect(bounds4070).toEqual({ min: 100, max: 285, defaultLimit: 285, current: 285 });
  });

  it('knows which GPUs exist', async () => {
    const backend = new SimulatedPowerBackend();
    expect(await backend.exists(GPU_5060)).toBe(true);
    expect(await backend.exists('GPU-00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('applies a value inside the range', async () => {
    const backend = new SimulatedPowerBackend(new SimulatedPowerState());
    await backend.apply(GPU_5060, 160);
    const bounds = await backend.bounds(GPU_5060);
    expect(bounds.current).toBe(160);
  });

  it('refuses a value above the range instead of clamping it', async () => {
    const backend = new SimulatedPowerBackend(new SimulatedPowerState());
    await expect(backend.apply(GPU_5060, 300)).rejects.toMatchObject({
      appError: { code: ErrorCode.ValidationFailed },
    });
    const bounds = await backend.bounds(GPU_5060);
    expect(bounds.current).toBe(180);
  });

  it('refuses a value below the range instead of clamping it', async () => {
    const backend = new SimulatedPowerBackend(new SimulatedPowerState());
    await expect(backend.apply(GPU_5060, 100)).rejects.toMatchObject({
      appError: { code: ErrorCode.ValidationFailed },
    });
    const bounds = await backend.bounds(GPU_5060);
    expect(bounds.current).toBe(180);
  });

  it('names the allowed range in the error message', async () => {
    const backend = new SimulatedPowerBackend(new SimulatedPowerState());
    await expect(backend.apply(GPU_5060, 300)).rejects.toMatchObject({
      appError: { message: expect.stringContaining('150–180 W') },
    });
  });

  it('refuses a non integer value', async () => {
    const backend = new SimulatedPowerBackend(new SimulatedPowerState());
    await expect(backend.apply(GPU_5060, 160.5)).rejects.toMatchObject({
      appError: { code: ErrorCode.ValidationFailed },
    });
  });

  it('fails for an unknown GPU', async () => {
    const backend = new SimulatedPowerBackend(new SimulatedPowerState());
    await expect(backend.apply('GPU-00000000-0000-0000-0000-000000000000', 180)).rejects.toBeInstanceOf(
      AppErrorException,
    );
    await expect(backend.bounds('GPU-00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
      appError: { code: ErrorCode.GpuNotFound },
    });
  });

  it('restores the factory default on reset', async () => {
    const backend = new SimulatedPowerBackend(new SimulatedPowerState());
    await backend.apply(GPU_5060, 150);
    expect((await backend.bounds(GPU_5060)).current).toBe(150);
    await backend.reset(GPU_5060);
    expect((await backend.bounds(GPU_5060)).current).toBe(180);
  });

  it('restores the default of every GPU on reset', async () => {
    const backend = new SimulatedPowerBackend(new SimulatedPowerState());
    await backend.apply(GPU_4070, 120);
    await backend.apply(GPU_5060, 150);
    await backend.reset(GPU_4070);
    await backend.reset(GPU_5060);
    expect((await backend.bounds(GPU_4070)).current).toBe(285);
    expect((await backend.bounds(GPU_5060)).current).toBe(180);
  });
});
