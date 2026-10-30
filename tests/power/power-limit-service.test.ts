// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../../src/shared/types';
import { PowerLimitServiceImpl } from '../../src/main/power/power-limit-service';
import type { BackendPowerLimits, PowerLimitBackend } from '../../src/main/power/backend';
import { AppErrorException } from '../../src/main/privileged/errors';

const GPU_5060 = 'GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646';
const GPU_ZERO = 'GPU-00000000-0000-0000-0000-000000000000';

interface BackendCall {
  method: 'apply' | 'reset';
  uuid: string;
  watts?: number;
}

class FakeBackend implements PowerLimitBackend {
  readonly calls: BackendCall[] = [];
  readonly limits = new Map<string, BackendPowerLimits>();
  /** When true, `apply` pretends the driver ignored the change. */
  ignoreApply = false;
  /** When true, `apply` fails. */
  failApply = false;

  constructor() {
    this.limits.set(GPU_5060, {
      min: 150,
      max: 180,
      defaultLimit: 180,
      current: 180,
    });
  }

  isSimulated(): boolean {
    return true;
  }

  async exists(uuid: string): Promise<boolean> {
    return this.limits.has(uuid);
  }

  async bounds(uuid: string): Promise<BackendPowerLimits> {
    const limits = this.limits.get(uuid);
    if (limits === undefined) {
      throw new AppErrorException({ code: ErrorCode.GpuNotFound, message: `A GPU ${uuid} não existe.` });
    }
    return { ...limits };
  }

  async apply(uuid: string, watts: number): Promise<void> {
    this.calls.push({ method: 'apply', uuid, watts });
    if (this.failApply) {
      throw new AppErrorException({
        code: ErrorCode.CommandFailed,
        message: 'O driver recusou a alteração.',
      });
    }
    if (this.ignoreApply) return;
    const limits = this.limits.get(uuid);
    if (limits !== undefined) limits.current = watts;
  }

  async reset(uuid: string): Promise<void> {
    this.calls.push({ method: 'reset', uuid });
    const limits = this.limits.get(uuid);
    if (limits !== undefined && limits.defaultLimit !== null) limits.current = limits.defaultLimit;
  }
}

function createService(backend: FakeBackend): PowerLimitServiceImpl {
  return new PowerLimitServiceImpl(backend, { now: () => 1_700_000_000_000 });
}

describe('PowerLimitService: uuid validation', () => {
  const invalid = ['GPU-xyz', 'rm -rf /', '../../etc/passwd', '', 'GPU-00000000-0000-0000-0000-00000000000'];
  for (const value of invalid) {
    it(`rejects the uuid ${JSON.stringify(value)}`, async () => {
      const backend = new FakeBackend();
      const service = createService(backend);
      const result = await service.apply({ uuid: value, watts: 180 });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe(ErrorCode.ValidationFailed);
      expect(backend.calls).toHaveLength(0);
    });
  }

  it('accepts the all zero uuid', async () => {
    const backend = new FakeBackend();
    backend.limits.set(GPU_ZERO, { min: 100, max: 285, defaultLimit: 285, current: 285 });
    const service = createService(backend);
    const result = await service.apply({ uuid: GPU_ZERO, watts: 200 });
    expect(result.ok).toBe(true);
    expect(result.verification?.confirmed).toBe(true);
  });
});

describe('PowerLimitService: watts validation', () => {
  const invalid = [0, -5, 1.5, 'abc', 99999];
  for (const value of invalid) {
    it(`rejects the watt value ${JSON.stringify(value)}`, async () => {
      const backend = new FakeBackend();
      const service = createService(backend);
      const result = await service.apply({ uuid: GPU_5060, watts: value as number });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe(ErrorCode.ValidationFailed);
      expect(backend.calls).toHaveLength(0);
    });
  }

  for (const value of [150, 180]) {
    it(`accepts the watt value ${value}`, async () => {
      const backend = new FakeBackend();
      const service = createService(backend);
      const result = await service.apply({ uuid: GPU_5060, watts: value });
      expect(result.ok).toBe(true);
      expect(result.appliedWatts).toBe(value);
      expect(backend.calls).toEqual([{ method: 'apply', uuid: GPU_5060, watts: value }]);
    });
  }
});

describe('PowerLimitService: out of range values', () => {
  it('rejects 300 W on a GPU whose range is 150-180 W', async () => {
    const backend = new FakeBackend();
    const service = createService(backend);
    const result = await service.apply({ uuid: GPU_5060, watts: 300 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.ValidationFailed);
    expect(result.error?.message).toContain('300 W');
    expect(result.error?.message).toContain('150–180 W');
  });

  it('never calls the backend with an out of range value', async () => {
    const backend = new FakeBackend();
    const service = createService(backend);
    await service.apply({ uuid: GPU_5060, watts: 300 });
    await service.apply({ uuid: GPU_5060, watts: 10 });
    expect(backend.calls).toHaveLength(0);
  });

  it('reports a missing GPU', async () => {
    const backend = new FakeBackend();
    const service = createService(backend);
    const result = await service.apply({ uuid: GPU_ZERO, watts: 200 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.GpuNotFound);
    expect(backend.calls).toHaveLength(0);
  });
});

describe('PowerLimitService: verification', () => {
  it('fails when the driver does not report the requested limit afterwards', async () => {
    const backend = new FakeBackend();
    backend.ignoreApply = true;
    const service = createService(backend);
    const result = await service.apply({ uuid: GPU_5060, watts: 160 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.CommandFailed);
    expect(result.verification?.confirmed).toBe(false);
    expect(result.verification?.observedLimitW).toBe(180);
    expect(result.verification?.observedAt).toBe(1_700_000_000_000);
  });

  it('confirms the change when the driver reports the requested limit', async () => {
    const backend = new FakeBackend();
    const service = createService(backend);
    const result = await service.apply({ uuid: GPU_5060, watts: 160 });
    expect(result.ok).toBe(true);
    expect(result.verification?.confirmed).toBe(true);
    expect(result.verification?.observedLimitW).toBe(160);
    expect(result.appliedWatts).toBe(160);
  });

  it('propagates a backend failure as an error result', async () => {
    const backend = new FakeBackend();
    backend.failApply = true;
    const service = createService(backend);
    const result = await service.apply({ uuid: GPU_5060, watts: 160 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.CommandFailed);
    expect(result.error?.message).toBe('O driver recusou a alteração.');
  });
});

describe('PowerLimitService: applyMany', () => {
  it('returns one result per request', async () => {
    const backend = new FakeBackend();
    backend.limits.set(GPU_ZERO, { min: 100, max: 285, defaultLimit: 285, current: 285 });
    const service = createService(backend);
    const results = await service.applyMany([
      { uuid: GPU_5060, watts: 160 },
      { uuid: GPU_5060, watts: 300 },
      { uuid: GPU_ZERO, watts: 200 },
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    expect(results[2]?.ok).toBe(true);
  });

  it('does not abort the batch on the first failure', async () => {
    const backend = new FakeBackend();
    backend.limits.set(GPU_ZERO, { min: 100, max: 285, defaultLimit: 285, current: 285 });
    const service = createService(backend);
    const results = await service.applyMany([
      { uuid: GPU_5060, watts: 300 },
      { uuid: 'not-a-uuid', watts: 160 },
      { uuid: GPU_ZERO, watts: 200 },
    ]);
    expect(results).toHaveLength(3);
    expect(results.every((result) => result.ok === false)).toBe(false);
    expect(results[2]?.ok).toBe(true);
    expect(backend.calls).toContainEqual({ method: 'apply', uuid: GPU_ZERO, watts: 200 });
  });

  it('keeps the order of the requests', async () => {
    const backend = new FakeBackend();
    const service = createService(backend);
    const results = await service.applyMany([
      { uuid: GPU_5060, watts: 150 },
      { uuid: GPU_5060, watts: 160 },
    ]);
    expect(results.map((result) => result.requestedWatts)).toEqual([150, 160]);
  });
});

describe('PowerLimitService: resetToDefault', () => {
  it('restores the factory default and verifies it', async () => {
    const backend = new FakeBackend();
    backend.limits.set(GPU_5060, {
      min: 150,
      max: 180,
      defaultLimit: 180,
      current: 150,
    });
    const service = createService(backend);
    const result = await service.resetToDefault(GPU_5060);
    expect(result.ok).toBe(true);
    expect(result.appliedWatts).toBe(180);
    expect(result.verification?.confirmed).toBe(true);
    expect(backend.calls).toEqual([{ method: 'reset', uuid: GPU_5060 }]);
  });

  it('fails when the driver does not report a default limit', async () => {
    const backend = new FakeBackend();
    backend.limits.set(GPU_5060, { min: 150, max: 180, defaultLimit: null, current: 160 });
    const service = createService(backend);
    const result = await service.resetToDefault(GPU_5060);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.UnsupportedByDriver);
  });

  it('rejects an invalid uuid', async () => {
    const backend = new FakeBackend();
    const service = createService(backend);
    const result = await service.resetToDefault('nope');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.ValidationFailed);
  });
});

describe('PowerLimitService: resetMany', () => {
  it('returns one result per uuid', async () => {
    const backend = new FakeBackend();
    const service = createService(backend);
    const results = await service.resetMany([GPU_5060, 'broken-uuid']);
    expect(results).toHaveLength(2);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
  });
});

describe('PowerLimitService: bounds', () => {
  it('returns the live bounds of the GPU', async () => {
    const backend = new FakeBackend();
    const service = createService(backend);
    const bounds = await service.bounds(GPU_5060);
    expect(bounds).toEqual({
      uuid: GPU_5060,
      minWatts: 150,
      maxWatts: 180,
      defaultWatts: 180,
      currentWatts: 180,
      adjustable: true,
    });
  });

  it('fails for an unknown GPU', async () => {
    const backend = new FakeBackend();
    const service = createService(backend);
    await expect(service.bounds(GPU_ZERO)).rejects.toMatchObject({
      appError: { code: ErrorCode.GpuNotFound },
    });
  });
});
