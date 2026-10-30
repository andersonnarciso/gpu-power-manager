/**
 * Profile service.
 *
 * Implements the `ProfileService` contract of `src/shared/contracts.ts`.
 *
 * The service never talks to the driver itself: the power limit applier and
 * the bounds provider are **injected** by the wiring layer, which keeps this
 * module independent from the GPU/power modules owned by other workers.
 *
 * Activation materialises a profile: every entry strategy is resolved against
 * the limits the driver reports *right now*, and the resulting watt values are
 * applied per GPU. A GPU that fails does not abort the batch: the failure is
 * reported for that GPU only.
 */

import {
  ErrorCode,
  type AppError,
  type OperationResult,
  type PowerLimitChangeResult,
  type PowerProfile,
  type ProfileEntry,
  type ProfileKind,
  type ProfileStrategy,
} from '../../shared/types';
import type { PowerLimitBounds, ProfileService } from '../../shared/contracts';
import {
  ValidationError,
  assertGpuUuid,
  assertNoShellMetacharacters,
  assertNonEmptyString,
  assertWatts,
  toAppError,
} from '../../shared/validation';
import { BUILTIN_PROFILE_TEMPLATES, findBuiltinTemplate } from './builtin-profiles';
import { ProfileStore } from './profile-store';
import { ServiceError } from './service-error';
import { resolveStrategyWatts } from './strategy';

/* ------------------------------------------------------------ collaborators */

export interface PowerLimitApplyOutcome {
  ok: boolean;
  appliedWatts?: number | null;
  error?: AppError;
}

/** Applies a power limit to a GPU. Injected by the wiring layer. */
export interface PowerLimitApplier {
  apply(uuid: string, watts: number): Promise<PowerLimitApplyOutcome>;
  resetToDefault(uuid: string): Promise<PowerLimitApplyOutcome>;
}

/** Reports the limits the driver accepts for every GPU. Injected. */
export interface PowerBoundsProvider {
  getBounds(): Promise<PowerLimitBounds[]>;
}

export interface ProfileServiceOptions {
  /** Clock used for `createdAt` / `updatedAt`. Injectable for the tests. */
  now?: () => number;
}

/* --------------------------------------------------------------- activation */

export interface ActivationTarget {
  uuid: string;
  strategy: ProfileStrategy;
  ratio?: number | undefined;
  watts: number | null;
}

export interface ActivationFailure {
  uuid: string;
  requestedWatts: number | null;
  error: AppError;
}

export interface ActivationPlan {
  targets: ActivationTarget[];
  failures: ActivationFailure[];
}

const PROFILE_KINDS: readonly ProfileKind[] = [
  'original',
  'economy',
  'balanced',
  'performance',
  'custom',
];

const PROFILE_STRATEGIES: readonly ProfileStrategy[] = ['default', 'min', 'ratio', 'fixed'];

function entryToTarget(entry: ProfileEntry): ActivationTarget {
  const strategy: ProfileStrategy =
    entry.strategy ?? (entry.watts !== null && entry.watts !== undefined ? 'fixed' : 'default');
  const target: ActivationTarget = { uuid: entry.uuid, strategy, watts: entry.watts ?? null };
  if (entry.ratio !== undefined) {
    target.ratio = entry.ratio;
  }
  return target;
}

/**
 * Expands a profile into one target per GPU, keeping the *strategy* of every
 * entry (the watt value is resolved later, against the live limits).
 *
 * Built-in profiles (except the user editable `Custom` one) are expanded over
 * every GPU the driver currently reports; an explicit entry of the profile
 * always wins over the built-in strategy.
 */
export function buildProfileTargets(
  profile: PowerProfile,
  bounds: PowerLimitBounds[],
): ActivationTarget[] {
  const template = findBuiltinTemplate(profile.kind);
  const expandsOverEveryGpu =
    profile.builtin && template !== null && template.kind !== 'custom';

  const rawTargets: ActivationTarget[] = [];

  if (expandsOverEveryGpu && template !== null) {
    for (const item of bounds) {
      const explicit = profile.entries.find((entry) => entry.uuid === item.uuid);
      if (explicit) {
        rawTargets.push(entryToTarget(explicit));
      } else {
        const target: ActivationTarget = {
          uuid: item.uuid,
          strategy: template.strategy,
          watts: null,
        };
        if (template.ratio !== undefined) {
          target.ratio = template.ratio;
        }
        rawTargets.push(target);
      }
    }
  } else {
    for (const entry of profile.entries) {
      rawTargets.push(entryToTarget(entry));
    }
  }

  return rawTargets;
}

/**
 * Builds the list of GPU targets for a profile without touching the hardware.
 */
export function buildActivationPlan(
  profile: PowerProfile,
  bounds: PowerLimitBounds[],
): ActivationPlan {
  const boundsByUuid = new Map(bounds.map((item) => [item.uuid, item]));
  const rawTargets = buildProfileTargets(profile, bounds);

  const targets: ActivationTarget[] = [];
  const failures: ActivationFailure[] = [];

  for (const target of rawTargets) {
    const item = boundsByUuid.get(target.uuid);
    if (item === undefined) {
      failures.push({
        uuid: target.uuid,
        requestedWatts: target.watts,
        error: {
          code: ErrorCode.GpuNotFound,
          message: `A GPU ${target.uuid} não está mais presente neste computador.`,
          detail: 'Remova a GPU do perfil ou conecte-a novamente.',
        },
      });
      continue;
    }

    if (item.minWatts === null || item.maxWatts === null) {
      failures.push({
        uuid: target.uuid,
        requestedWatts: target.watts,
        error: {
          code: ErrorCode.UnsupportedByDriver,
          message: `O driver não informou a faixa de potência aceita pela GPU ${target.uuid}.`,
          detail: 'A GPU pode não permitir ajuste de limite de potência.',
        },
      });
      continue;
    }

    const resolution = resolveStrategyWatts(target, {
      minWatts: item.minWatts,
      maxWatts: item.maxWatts,
      defaultWatts: item.defaultWatts,
    });

    if (!resolution.ok) {
      failures.push({
        uuid: target.uuid,
        requestedWatts: target.watts,
        error: {
          code: ErrorCode.ValidationFailed,
          message: `Não foi possível calcular o limite da GPU ${target.uuid}.`,
          detail: resolution.reason,
        },
      });
      continue;
    }

    targets.push({ ...target, watts: resolution.watts });
  }

  return { targets, failures };
}

/* ------------------------------------------------------------------ service */

/** Sorts built-in profiles first (in template order), then user profiles. */
export function sortProfiles(profiles: PowerProfile[]): PowerProfile[] {
  const builtins: PowerProfile[] = [];
  const custom: PowerProfile[] = [];

  for (const profile of profiles) {
    if (profile.builtin) {
      builtins.push(profile);
    } else {
      custom.push(profile);
    }
  }

  builtins.sort((a, b) => {
    const indexA = BUILTIN_PROFILE_TEMPLATES.findIndex((template) => template.id === a.id);
    const indexB = BUILTIN_PROFILE_TEMPLATES.findIndex((template) => template.id === b.id);
    if (indexA === -1 && indexB === -1) return a.id.localeCompare(b.id);
    if (indexA === -1) return 1;
    if (indexB === -1) return -1;
    return indexA - indexB;
  });

  custom.sort((a, b) => {
    const byName = a.name.localeCompare(b.name, 'pt-BR');
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });

  return [...builtins, ...custom];
}

export class ProfileServiceImpl implements ProfileService {
  private readonly store: ProfileStore;
  private readonly applier: PowerLimitApplier;
  private readonly boundsProvider: PowerBoundsProvider;
  private readonly now: () => number;

  private cache: PowerProfile[] | null = null;
  private warning: AppError | null = null;

  constructor(
    store: ProfileStore,
    applier: PowerLimitApplier,
    boundsProvider: PowerBoundsProvider,
    options: ProfileServiceOptions = {},
  ) {
    this.store = store;
    this.applier = applier;
    this.boundsProvider = boundsProvider;
    this.now = options.now ?? Date.now;
  }

  /** The last problem found while loading the store (corrupt file, ...). */
  lastWarning(): AppError | null {
    return this.warning;
  }

  private async ensureLoaded(): Promise<PowerProfile[]> {
    if (this.cache !== null) {
      return this.cache;
    }
    const result = await this.store.load();
    this.warning = result.error;
    this.cache = sortProfiles(result.profiles);
    return this.cache;
  }

  async list(): Promise<PowerProfile[]> {
    const profiles = await this.ensureLoaded();
    return profiles.map((profile) => ({ ...profile, entries: profile.entries.map((e) => ({ ...e })) }));
  }

  async get(id: string): Promise<PowerProfile | null> {
    const profiles = await this.ensureLoaded();
    const found = profiles.find((profile) => profile.id === id);
    return found ? { ...found, entries: found.entries.map((e) => ({ ...e })) } : null;
  }

  /**
   * Validates and stores a profile.
   *
   * Built-in profiles can be edited but never deleted, and their `builtin`
   * flag / creation date are preserved.
   */
  async save(profile: PowerProfile): Promise<PowerProfile> {
    const profiles = await this.ensureLoaded();
    const existing = profiles.find((item) => item.id === profile?.id) ?? null;

    const id = assertNoShellMetacharacters(
      assertNonEmptyString(profile.id, 'id', 128),
      'id',
    );
    const name = assertNonEmptyString(profile.name, 'name', 120);
    const description =
      typeof profile.description === 'string' ? profile.description.slice(0, 500) : '';

    if (typeof profile.kind !== 'string' || !PROFILE_KINDS.includes(profile.kind)) {
      throw new ValidationError('kind', 'Tipo de perfil inválido.');
    }
    const kind: ProfileKind = profile.kind;

    if (!Array.isArray(profile.entries)) {
      throw new ValidationError('entries', 'A lista de GPUs do perfil deve ser uma lista.');
    }
    if (profile.entries.length > 64) {
      throw new ValidationError('entries', 'O perfil não pode ter mais de 64 GPUs.');
    }

    const entries: ProfileEntry[] = [];
    const fixedEntries: ProfileEntry[] = [];
    const seen = new Set<string>();

    for (const rawEntry of profile.entries) {
      const uuid = assertGpuUuid(rawEntry?.uuid, 'entries.uuid');
      if (seen.has(uuid)) {
        throw new ValidationError('entries.uuid', `A GPU ${uuid} aparece duas vezes no perfil.`);
      }
      seen.add(uuid);

      let watts: number | null = null;
      if (rawEntry.watts !== undefined && rawEntry.watts !== null) {
        watts = assertWatts(rawEntry.watts, 'entries.watts');
      }

      let strategy: ProfileStrategy;
      if (rawEntry.strategy === undefined || rawEntry.strategy === null) {
        strategy = watts !== null ? 'fixed' : 'default';
      } else {
        if (
          typeof rawEntry.strategy !== 'string' ||
          !PROFILE_STRATEGIES.includes(rawEntry.strategy as ProfileStrategy)
        ) {
          throw new ValidationError('entries.strategy', 'Estratégia de perfil inválida.');
        }
        strategy = rawEntry.strategy as ProfileStrategy;
      }

      let ratio: number | undefined;
      if (rawEntry.ratio !== undefined && rawEntry.ratio !== null) {
        if (
          typeof rawEntry.ratio !== 'number' ||
          !Number.isFinite(rawEntry.ratio) ||
          rawEntry.ratio <= 0 ||
          rawEntry.ratio > 1
        ) {
          throw new ValidationError('entries.ratio', 'A proporção deve estar entre 0 e 1.');
        }
        ratio = rawEntry.ratio;
      }

      if (strategy === 'ratio' && ratio === undefined) {
        throw new ValidationError('entries.ratio', 'A proporção é obrigatória para a estratégia "ratio".');
      }
      if (strategy === 'fixed' && watts === null) {
        throw new ValidationError('entries.watts', 'O limite em watts é obrigatório para a estratégia "fixed".');
      }

      const entry: ProfileEntry = { uuid, watts };
      entry.strategy = strategy;
      if (ratio !== undefined) {
        entry.ratio = ratio;
      }
      entries.push(entry);

      if (strategy === 'fixed') {
        fixedEntries.push(entry);
      }
    }

    if (fixedEntries.length > 0) {
      await this.assertFixedEntriesWithinBounds(fixedEntries);
    }

    const timestamp = this.now();
    const saved: PowerProfile = {
      id,
      name,
      kind,
      description,
      builtin: existing?.builtin ?? false,
      entries,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    const next = sortProfiles([...profiles.filter((item) => item.id !== saved.id), saved]);
    await this.store.persist(next);
    this.cache = next;

    return { ...saved, entries: saved.entries.map((entry) => ({ ...entry })) };
  }

  /** Rejects fixed watt values that the driver would not accept. */
  private async assertFixedEntriesWithinBounds(entries: ProfileEntry[]): Promise<void> {
    const bounds = await this.boundsProvider.getBounds();
    const boundsByUuid = new Map(bounds.map((item) => [item.uuid, item]));

    for (const entry of entries) {
      const item = boundsByUuid.get(entry.uuid);
      if (item === undefined) {
        throw new ValidationError(
          'entries.uuid',
          `A GPU ${entry.uuid} não foi encontrada neste computador. Não é possível validar o limite.`,
        );
      }
      if (item.minWatts === null || item.maxWatts === null) {
        throw new ValidationError(
          'entries.watts',
          `O driver não informou a faixa de potência aceita pela GPU ${entry.uuid}.`,
        );
      }
      const max =
        item.defaultWatts !== null && item.defaultWatts < item.maxWatts
          ? item.defaultWatts
          : item.maxWatts;
      const watts = entry.watts ?? 0;
      if (watts < item.minWatts || watts > max) {
        throw new ValidationError(
          'entries.watts',
          `O limite de ${watts} W está fora da faixa aceita pela GPU ${entry.uuid} (${item.minWatts}–${max} W).`,
        );
      }
    }
  }

  async remove(id: string): Promise<OperationResult> {
    const profiles = await this.ensureLoaded();
    const profile = profiles.find((item) => item.id === id);

    if (!profile) {
      return {
        ok: false,
        error: {
          code: ErrorCode.ProfileNotFound,
          message: `O perfil "${id}" não foi encontrado.`,
        },
      };
    }

    if (profile.builtin) {
      return {
        ok: false,
        error: {
          code: ErrorCode.ValidationFailed,
          message: `O perfil "${profile.name}" é integrado e não pode ser removido.`,
          detail: 'Você pode editá-lo ou restaurar os padrões.',
        },
      };
    }

    const next = profiles.filter((item) => item.id !== id);
    await this.store.persist(next);
    this.cache = next;

    return { ok: true };
  }

  /** Applies the profile to every GPU it targets. */
  async activate(id: string): Promise<PowerLimitChangeResult[]> {
    const profile = await this.get(id);
    if (!profile) {
      throw ServiceError.notFound(id);
    }

    const bounds = await this.boundsProvider.getBounds();
    const plan = buildActivationPlan(profile, bounds);
    const results: PowerLimitChangeResult[] = [];

    for (const failure of plan.failures) {
      results.push({
        uuid: failure.uuid,
        requestedWatts: failure.requestedWatts ?? 0,
        appliedWatts: null,
        ok: false,
        error: failure.error,
      });
    }

    for (const target of plan.targets) {
      const watts = target.watts ?? 0;
      try {
        const outcome = await this.applier.apply(target.uuid, watts);
        results.push({
          uuid: target.uuid,
          requestedWatts: watts,
          appliedWatts: outcome.appliedWatts ?? null,
          ok: outcome.ok,
          error: outcome.error,
        });
      } catch (error) {
        results.push({
          uuid: target.uuid,
          requestedWatts: watts,
          appliedWatts: null,
          ok: false,
          error: toAppError(error),
        });
      }
    }

    return results;
  }

  /** Restores the factory default limit on every GPU. */
  async resetDefaults(): Promise<PowerLimitChangeResult[]> {
    const bounds = await this.boundsProvider.getBounds();
    const results: PowerLimitChangeResult[] = [];

    for (const item of bounds) {
      try {
        const outcome = await this.applier.resetToDefault(item.uuid);
        results.push({
          uuid: item.uuid,
          requestedWatts: item.defaultWatts ?? 0,
          appliedWatts: outcome.appliedWatts ?? null,
          ok: outcome.ok,
          error: outcome.error,
        });
      } catch (error) {
        results.push({
          uuid: item.uuid,
          requestedWatts: item.defaultWatts ?? 0,
          appliedWatts: null,
          ok: false,
          error: toAppError(error),
        });
      }
    }

    return results;
  }
}
