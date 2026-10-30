import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

vi.mock('electron', async () => {
  const osModule = await import('node:os');
  const pathModule = await import('node:path');
  return {
    app: {
      getPath: () => pathModule.join(osModule.tmpdir(), 'gpupm-electron-userdata'),
    },
  };
});

import { ProfileStore, createBuiltinProfiles } from '../../src/main/profiles/profile-store';
import { BUILTIN_PROFILE_TEMPLATES } from '../../src/main/profiles/builtin-profiles';

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gpupm-store-'));
  vi.mocked(fs.rename).mockClear();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function storeIn(workspace_: string, now = 1_700_000_000_000): ProfileStore {
  return new ProfileStore({
    filePath: path.join(workspace_, 'profiles.json'),
    now: () => now,
  });
}

describe('ProfileStore', () => {
  it('seeds the built-in profiles on the first load', async () => {
    const store = storeIn(workspace);
    const result = await store.load();

    expect(result.error).toBeNull();
    expect(result.seeded).toBe(true);
    expect(result.profiles).toHaveLength(5);

    expect(result.profiles.map((profile) => profile.name)).toEqual([
      'Original',
      'Econômico',
      'Balanced',
      'Performance',
      'Custom',
    ]);
    expect(result.profiles.map((profile) => profile.kind)).toEqual([
      'original',
      'economy',
      'balanced',
      'performance',
      'custom',
    ]);

    for (const profile of result.profiles) {
      expect(profile.builtin).toBe(true);
      expect(profile.id).toMatch(/^builtin-/);
      expect(profile.createdAt).toBe(1_700_000_000_000);
      expect(profile.updatedAt).toBe(1_700_000_000_000);
      expect(profile.description.length).toBeGreaterThan(0);
    }

    // The built-in profiles must not hardcode watt values.
    for (const profile of result.profiles) {
      expect(profile.entries).toEqual([]);
    }
  });

  it('does not rewrite the file on the following loads', async () => {
    const filePath = path.join(workspace, 'profiles.json');
    const store = storeIn(workspace);

    await store.load();
    const firstContent = await fs.readFile(filePath, 'utf8');
    const firstStat = await fs.stat(filePath);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = storeIn(workspace);
    const result = await second.load();

    expect(result.seeded).toBe(false);
    expect(result.error).toBeNull();
    expect(result.profiles).toHaveLength(5);

    const secondContent = await fs.readFile(filePath, 'utf8');
    const secondStat = await fs.stat(filePath);

    expect(secondContent).toBe(firstContent);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
    expect(vi.mocked(fs.rename).mock.calls.length).toBe(1);
  });

  it('keeps the edits made by the user in a built-in profile', async () => {
    const filePath = path.join(workspace, 'profiles.json');
    const profiles = createBuiltinProfiles(1_700_000_000_000);
    const renamed = profiles.map((profile) =>
      profile.id === 'builtin-balanced' ? { ...profile, name: 'Equilibrado' } : profile,
    );
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: 1, updatedAt: 1, profiles: renamed }, null, 2),
      'utf8',
    );

    const result = await storeIn(workspace).load();

    expect(result.error).toBeNull();
    expect(result.profiles.find((profile) => profile.id === 'builtin-balanced')?.name).toBe(
      'Equilibrado',
    );
  });

  it('falls back to the defaults when the file is corrupt', async () => {
    const filePath = path.join(workspace, 'profiles.json');
    await fs.writeFile(filePath, '{ this is not json', 'utf8');

    const result = await storeIn(workspace).load();

    expect(result.profiles).toHaveLength(5);
    expect(result.profiles.map((profile) => profile.id)).toEqual(
      BUILTIN_PROFILE_TEMPLATES.map((template) => template.id),
    );
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain('corrompido');
  });

  it('falls back to the defaults when a profile has an unknown kind', async () => {
    const filePath = path.join(workspace, 'profiles.json');
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        profiles: [
          {
            id: 'x',
            name: 'X',
            kind: 'turbo',
            description: '',
            builtin: false,
            entries: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      'utf8',
    );

    const result = await storeIn(workspace).load();

    expect(result.profiles).toHaveLength(5);
    expect(result.error).not.toBeNull();
  });

  it('falls back to the defaults when an entry has an invalid uuid', async () => {
    const filePath = path.join(workspace, 'profiles.json');
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        profiles: [
          {
            id: 'x',
            name: 'X',
            kind: 'custom',
            description: '',
            builtin: false,
            entries: [{ uuid: 'not-a-uuid', watts: 100 }],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      'utf8',
    );

    const result = await storeIn(workspace).load();

    expect(result.profiles).toHaveLength(5);
    expect(result.error).not.toBeNull();
  });

  it('restores a built-in profile that was removed from the file', async () => {
    const filePath = path.join(workspace, 'profiles.json');
    const profiles = createBuiltinProfiles(1_700_000_000_000).filter(
      (profile) => profile.id !== 'builtin-custom',
    );
    await fs.writeFile(filePath, JSON.stringify({ version: 1, profiles }), 'utf8');

    const result = await storeIn(workspace).load();

    expect(result.profiles).toHaveLength(5);
    expect(result.profiles.some((profile) => profile.id === 'builtin-custom')).toBe(true);
  });

  it('keeps the previous file intact when the rename fails', async () => {
    const filePath = path.join(workspace, 'profiles.json');
    const store = storeIn(workspace);
    await store.load();

    const before = await fs.readFile(filePath, 'utf8');

    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('rename falhou'));

    await expect(
      store.persist([{ ...createBuiltinProfiles(1)[0], name: 'Alterado' }]),
    ).rejects.toThrow('rename falhou');

    const after = await fs.readFile(filePath, 'utf8');
    expect(after).toBe(before);

    // No debris is left behind.
    const leftovers = (await fs.readdir(workspace)).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('uses app.getPath("userData") when no file path is given', () => {
    const store = new ProfileStore();
    expect(store.filePath).toBe(
      path.join(os.tmpdir(), 'gpupm-electron-userdata', 'profiles.json'),
    );
  });
});
