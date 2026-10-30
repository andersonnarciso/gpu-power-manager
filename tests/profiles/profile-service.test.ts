import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PowerLimitBounds } from '../../src/shared/contracts';
import { ErrorCode, type AppError, type PowerProfile } from '../../src/shared/types';
import { ProfileStore } from '../../src/main/profiles/profile-store';
import {
  ProfileServiceImpl,
  type PowerLimitApplier,
  type PowerLimitApplyOutcome,
} from '../../src/main/profiles/profile-service';

const GPU_4070 = 'GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1';
const GPU_5060 = 'GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646';

function createBounds(): PowerLimitBounds[] {
  return [
    {
      uuid: GPU_4070,
      minWatts: 100,
      maxWatts: 285,
      defaultWatts: 285,
      currentWatts: 285,
      adjustable: true,
    },
    {
      uuid: GPU_5060,
      minWatts: 150,
      maxWatts: 180,
      defaultWatts: 180,
      currentWatts: 180,
      adjustable: true,
    },
  ];
}

class FakeApplier implements PowerLimitApplier {
  readonly applied: Array<{ uuid: string; watts: number }> = [];
  readonly reset: string[] = [];
  readonly failing = new Set<string>();

  async apply(uuid: string, watts: number): Promise<PowerLimitApplyOutcome> {
    this.applied.push({ uuid, watts });
    if (this.failing.has(uuid)) {
      return {
        ok: false,
        error: {
          code: ErrorCode.CommandFailed,
          message: `O driver recusou o limite de ${watts} W.`,
        },
      };
    }
    return { ok: true, appliedWatts: watts };
  }

  async resetToDefault(uuid: string): Promise<PowerLimitApplyOutcome> {
    this.reset.push(uuid);
    return { ok: true, appliedWatts: null };
  }
}

let workspace: string;
let store: ProfileStore;
let applier: FakeApplier;
let service: ProfileServiceImpl;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gpupm-service-'));
  store = new ProfileStore({
    filePath: path.join(workspace, 'profiles.json'),
    now: () => 1_700_000_000_000,
  });
  applier = new FakeApplier();
  service = new ProfileServiceImpl(
    store,
    applier,
    { getBounds: async () => createBounds() },
    { now: () => 1_700_000_000_000 },
  );
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function customProfile(overrides: Partial<PowerProfile> = {}): PowerProfile {
  return {
    id: 'custom-1',
    name: 'Meu perfil',
    kind: 'custom',
    description: 'perfil de teste',
    builtin: false,
    entries: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** Writes the store file directly, simulating a profile stored in the past. */
async function writeProfilesDirectly(profiles: unknown[]): Promise<void> {
  await fs.writeFile(
    path.join(workspace, 'profiles.json'),
    JSON.stringify({ version: 1, updatedAt: 1, profiles }, null, 2),
    'utf8',
  );
}

/** A service that reads the store again (the cache is per instance). */
function createService(bounds: PowerLimitBounds[] = createBounds()): ProfileServiceImpl {
  return new ProfileServiceImpl(
    store,
    applier,
    { getBounds: async () => bounds },
    { now: () => 1_700_000_000_000 },
  );
}

describe('ProfileServiceImpl', () => {
  it('lists the built-in profiles first', async () => {
    const profiles = await service.list();
    expect(profiles.map((profile) => profile.id)).toEqual([
      'builtin-original',
      'builtin-economico',
      'builtin-balanced',
      'builtin-performance',
      'builtin-custom',
    ]);
  });

  it('applies the factory default with the "Original" profile', async () => {
    const results = await service.activate('builtin-original');

    expect(results.every((result) => result.ok)).toBe(true);
    expect(applier.applied).toEqual([
      { uuid: GPU_4070, watts: 285 },
      { uuid: GPU_5060, watts: 180 },
    ]);
  });

  it('applies the lowest accepted limit with the "Econômico" profile', async () => {
    await service.activate('builtin-economico');
    expect(applier.applied).toEqual([
      { uuid: GPU_4070, watts: 100 },
      { uuid: GPU_5060, watts: 150 },
    ]);
  });

  it('applies 70% of the allowed range with the "Balanced" profile', async () => {
    await service.activate('builtin-balanced');
    expect(applier.applied).toEqual([
      { uuid: GPU_4070, watts: 230 },
      { uuid: GPU_5060, watts: 171 },
    ]);
  });

  it('never exceeds the factory default with the "Performance" profile', async () => {
    const results = await service.activate('builtin-performance');

    expect(results.every((result) => result.ok)).toBe(true);
    for (const result of results) {
      const bounds = createBounds().find((item) => item.uuid === result.uuid);
      expect(result.requestedWatts).toBe(bounds?.defaultWatts);
      expect(result.requestedWatts).toBeLessThanOrEqual(bounds?.maxWatts ?? 0);
    }
  });

  it('rejects a fixed value outside the allowed range', async () => {
    // The profile was stored when the driver accepted a wider range.
    await writeProfilesDirectly([
      {
        id: 'custom-1',
        name: 'Meu perfil',
        kind: 'custom',
        description: '',
        builtin: false,
        entries: [{ uuid: GPU_4070, watts: 400, strategy: 'fixed' }],
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const results = await createService().activate('custom-1');

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error?.detail).toContain('fora da faixa');
    expect(applier.applied).toEqual([]);
  });

  it('reports a GPU that is no longer present without aborting the batch', async () => {
    await writeProfilesDirectly([
      {
        id: 'custom-1',
        name: 'Meu perfil',
        kind: 'custom',
        description: '',
        builtin: false,
        entries: [
          { uuid: GPU_4070, watts: 200, strategy: 'fixed' },
          { uuid: GPU_5060, watts: 160, strategy: 'fixed' },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const serviceWithoutFirstGpu = new ProfileServiceImpl(
      store,
      applier,
      {
        getBounds: async () => createBounds().filter((bounds) => bounds.uuid !== GPU_4070),
      },
      { now: () => 1_700_000_000_000 },
    );

    const results = await serviceWithoutFirstGpu.activate('custom-1');
    const failed = results.filter((result) => !result.ok);

    expect(failed).toHaveLength(1);
    expect(failed[0].error?.code).toBe(ErrorCode.GpuNotFound);
    expect(failed[0].uuid).toBe(GPU_4070);
    expect(applier.applied).toEqual([{ uuid: GPU_5060, watts: 160 }]);
  });

  it('reports a per-GPU failure without aborting the batch', async () => {
    applier.failing.add(GPU_4070);

    const results = await service.activate('builtin-original');

    expect(results).toHaveLength(2);
    const failed = results.find((result) => result.uuid === GPU_4070);
    const succeeded = results.find((result) => result.uuid === GPU_5060);
    expect(failed?.ok).toBe(false);
    expect(failed?.error?.message).toContain('recusou');
    expect(succeeded?.ok).toBe(true);
    expect(succeeded?.appliedWatts).toBe(180);
  });

  it('throws a readable error when the profile does not exist', async () => {
    await expect(service.activate('nope')).rejects.toThrow(/não foi encontrado/);
  });

  it('refuses to delete a built-in profile', async () => {
    const result = await service.remove('builtin-original');

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('integrado');
    expect((await service.list()).some((profile) => profile.id === 'builtin-original')).toBe(true);
  });

  it('deletes a custom profile', async () => {
    await service.save(customProfile());

    const result = await service.remove('custom-1');

    expect(result.ok).toBe(true);
    expect((await service.list()).some((profile) => profile.id === 'custom-1')).toBe(false);
  });

  it('reports a missing profile when it is removed', async () => {
    const result = await service.remove('does-not-exist');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.ProfileNotFound);
  });

  it('rejects a profile without a name', async () => {
    await expect(service.save(customProfile({ name: '   ' }))).rejects.toThrow(/não pode/i);
  });

  it('rejects a profile with an invalid gpu uuid', async () => {
    await expect(
      service.save(
        customProfile({ entries: [{ uuid: 'GPU-nao-valido', watts: 100, strategy: 'fixed' }] }),
      ),
    ).rejects.toThrow(/inválido/i);
  });

  it('rejects a fixed value outside the allowed range when saving', async () => {
    await expect(
      service.save(
        customProfile({ entries: [{ uuid: GPU_4070, watts: 400, strategy: 'fixed' }] }),
      ),
    ).rejects.toThrow(/fora da faixa/i);
  });

  it('keeps the builtin flag and the creation date when a built-in profile is edited', async () => {
    const before = await service.get('builtin-balanced');

    const saved = await service.save({
      ...(before as PowerProfile),
      name: 'Equilibrado',
      entries: [{ uuid: GPU_4070, watts: 210, strategy: 'fixed' }],
    });

    expect(saved.builtin).toBe(true);
    expect(saved.createdAt).toBe(before?.createdAt);
    expect(saved.name).toBe('Equilibrado');
    expect(saved.entries).toEqual([{ uuid: GPU_4070, watts: 210, strategy: 'fixed' }]);
  });

  it('uses the explicit entry of a built-in profile and the strategy for the other GPUs', async () => {
    const before = await service.get('builtin-balanced');
    await service.save({
      ...(before as PowerProfile),
      entries: [{ uuid: GPU_4070, watts: 210, strategy: 'fixed' }],
    });

    await service.activate('builtin-balanced');

    expect(applier.applied).toEqual([
      { uuid: GPU_4070, watts: 210 },
      { uuid: GPU_5060, watts: 171 },
    ]);
  });

  it('restores the factory default on every GPU', async () => {
    const results = await service.resetDefaults();

    expect(applier.reset).toEqual([GPU_4070, GPU_5060]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[0].requestedWatts).toBe(285);
  });

  it('keeps the error of a failed apply on the result', async () => {
    applier.failing.add(GPU_5060);
    const results = await service.activate('builtin-original');
    const error: AppError | undefined = results.find((r) => r.uuid === GPU_5060)?.error;
    expect(error?.code).toBe(ErrorCode.CommandFailed);
  });
});
