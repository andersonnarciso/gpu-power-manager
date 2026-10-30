/**
 * Profile store: durable storage for the power profiles.
 *
 * The store owns exactly one file: `<userData>/profiles.json`.
 *
 * Guarantees:
 *  - every write is atomic (temporary file + rename), so the file on disk is
 *    never truncated;
 *  - every field of every profile is validated when the file is read. When
 *    anything is unknown or corrupt the built-in defaults are used and a
 *    readable error is reported instead of crashing the app;
 *  - the built-in profiles are seeded on the first load and are NOT rewritten
 *    on the following loads (user edits are preserved).
 */

import {
  ErrorCode,
  type AppError,
  type PowerProfile,
  type ProfileEntry,
  type ProfileKind,
  type ProfileStrategy,
} from '../../shared/types';
import { isValidGpuUuid } from '../../shared/validation';
import { readJsonFile, writeJsonFileAtomic } from './atomic-json';
import { BUILTIN_PROFILE_TEMPLATES } from './builtin-profiles';
import { PROFILES_FILE_NAME, userDataFilePath } from './user-data';

export const PROFILE_STORE_VERSION = 1;

const PROFILE_KINDS: readonly ProfileKind[] = [
  'original',
  'economy',
  'balanced',
  'performance',
  'custom',
];

const PROFILE_STRATEGIES: readonly ProfileStrategy[] = ['default', 'min', 'ratio', 'fixed'];

export interface ProfileStoreOptions {
  /** Full path of `profiles.json`. Defaults to `<userData>/profiles.json`. */
  filePath?: string;
  /** Clock used for `createdAt` / `updatedAt`. Injectable for the tests. */
  now?: () => number;
}

export interface ProfileStoreLoadResult {
  /** The profiles that must be used from now on. */
  profiles: PowerProfile[];
  /** Set when the file was missing, corrupt or unknown. */
  error: AppError | null;
  /** True when the built-in profiles were seeded and the file was written. */
  seeded: boolean;
}

/** Builds the built-in profiles. They never contain watt values. */
export function createBuiltinProfiles(now: number): PowerProfile[] {
  return BUILTIN_PROFILE_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    kind: template.kind,
    description: template.description,
    builtin: true,
    entries: [],
    createdAt: now,
    updatedAt: now,
  }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates and normalises a single entry.
 *
 * `null` is returned when the entry cannot be trusted.
 */
export function validateProfileEntry(raw: unknown): ProfileEntry | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (!isValidGpuUuid(raw.uuid)) {
    return null;
  }

  let watts: number | null = null;
  if (raw.watts !== undefined && raw.watts !== null) {
    if (!isFiniteNumber(raw.watts) || !Number.isInteger(raw.watts) || raw.watts <= 0) {
      return null;
    }
    watts = raw.watts;
  }

  let strategy: ProfileStrategy | undefined;
  if (raw.strategy !== undefined && raw.strategy !== null) {
    if (typeof raw.strategy !== 'string') {
      return null;
    }
    if (!PROFILE_STRATEGIES.includes(raw.strategy as ProfileStrategy)) {
      return null;
    }
    strategy = raw.strategy as ProfileStrategy;
  }

  let ratio: number | undefined;
  if (raw.ratio !== undefined && raw.ratio !== null) {
    if (!isFiniteNumber(raw.ratio) || raw.ratio <= 0 || raw.ratio > 1) {
      return null;
    }
    ratio = raw.ratio;
  }

  if (strategy === 'ratio' && ratio === undefined) {
    return null;
  }
  if (strategy === 'fixed' && watts === null) {
    return null;
  }

  const entry: ProfileEntry = { uuid: raw.uuid, watts };
  if (strategy !== undefined) {
    entry.strategy = strategy;
  } else {
    entry.strategy = watts !== null ? 'fixed' : 'default';
  }
  if (ratio !== undefined) {
    entry.ratio = ratio;
  }
  return entry;
}

/** Validates and normalises a single profile. */
export function validateProfile(raw: unknown): PowerProfile | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.name)) {
    return null;
  }
  if (typeof raw.kind !== 'string' || !PROFILE_KINDS.includes(raw.kind as ProfileKind)) {
    return null;
  }
  if (typeof raw.description !== 'string') {
    return null;
  }
  if (typeof raw.builtin !== 'boolean') {
    return null;
  }
  if (!isFiniteNumber(raw.createdAt) || !isFiniteNumber(raw.updatedAt)) {
    return null;
  }
  if (!Array.isArray(raw.entries)) {
    return null;
  }

  const entries: ProfileEntry[] = [];
  for (const rawEntry of raw.entries) {
    const entry = validateProfileEntry(rawEntry);
    if (entry === null) {
      return null;
    }
    entries.push(entry);
  }

  return {
    id: raw.id,
    name: raw.name,
    kind: raw.kind as ProfileKind,
    description: raw.description,
    builtin: raw.builtin,
    entries,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/**
 * Validates the whole file.
 *
 * Both a bare array and the `{ version, profiles }` envelope are accepted, but
 * every profile must be valid. One broken profile invalidates the file: the
 * caller then falls back to the built-in defaults.
 */
export function validateProfileCollection(raw: unknown): PowerProfile[] | null {
  let list: unknown[];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (isPlainObject(raw) && Array.isArray(raw.profiles)) {
    list = raw.profiles;
  } else {
    return null;
  }

  const profiles: PowerProfile[] = [];
  for (const rawProfile of list) {
    const profile = validateProfile(rawProfile);
    if (profile === null) {
      return null;
    }
    profiles.push(profile);
  }
  return profiles;
}

function corruptFileError(detail: string): AppError {
  return {
    code: ErrorCode.ValidationFailed,
    message:
      'O arquivo de perfis estava corrompido ou desconhecido. Os perfis integrados foram restaurados.',
    detail,
  };
}

/** Durable storage for the power profiles. */
export class ProfileStore {
  private readonly explicitFilePath: string | undefined;
  private readonly now: () => number;
  private resolvedFilePath: string | null = null;

  constructor(options: ProfileStoreOptions = {}) {
    this.explicitFilePath = options.filePath;
    this.now = options.now ?? Date.now;
  }

  /** Absolute path of the store file. */
  get filePath(): string {
    if (this.resolvedFilePath === null) {
      this.resolvedFilePath = this.explicitFilePath ?? userDataFilePath(PROFILES_FILE_NAME);
    }
    return this.resolvedFilePath;
  }

  /**
   * Loads the profiles.
   *
   * Never throws: a missing, corrupt or unknown file resolves to the built-in
   * defaults and an error describing the problem.
   */
  async load(): Promise<ProfileStoreLoadResult> {
    const read = await readJsonFile(this.filePath);

    if (read.kind === 'missing') {
      const seeded = createBuiltinProfiles(this.now());
      await this.persist(seeded);
      return { profiles: seeded, error: null, seeded: true };
    }

    if (read.kind === 'error') {
      const seeded = createBuiltinProfiles(this.now());
      await this.persist(seeded);
      return {
        profiles: seeded,
        error: corruptFileError(`Não foi possível ler o arquivo: ${read.message}`),
        seeded: true,
      };
    }

    const validated = validateProfileCollection(read.value);
    if (validated === null) {
      const seeded = createBuiltinProfiles(this.now());
      await this.persist(seeded);
      return {
        profiles: seeded,
        error: corruptFileError('O conteúdo do arquivo de perfis não corresponde ao formato esperado.'),
        seeded: true,
      };
    }

    // The built-in profiles are added back when they are missing, but an
    // existing built-in profile is never rewritten: user edits are kept.
    const missing = BUILTIN_PROFILE_TEMPLATES.filter(
      (template) => !validated.some((profile) => profile.id === template.id),
    );
    if (missing.length === 0) {
      return { profiles: validated, error: null, seeded: false };
    }

    const now = this.now();
    const restored = missing.map((template) => ({
      id: template.id,
      name: template.name,
      kind: template.kind,
      description: template.description,
      builtin: true,
      entries: [],
      createdAt: now,
      updatedAt: now,
    }));
    const profiles = [...restored, ...validated];
    await this.persist(profiles);
    return { profiles, error: null, seeded: true };
  }

  /** Persists the whole collection atomically. */
  async persist(profiles: PowerProfile[]): Promise<void> {
    const payload = {
      version: PROFILE_STORE_VERSION,
      updatedAt: this.now(),
      profiles,
    };
    await writeJsonFileAtomic(this.filePath, payload);
  }
}
