/**
 * Built-in profile templates.
 *
 * Built-in profiles must never hardcode watt values: the supported range and
 * the set of GPUs differ from machine to machine. A template therefore only
 * describes HOW the limit is derived (`ProfileStrategy`); the concrete watt
 * value is resolved against the live driver limits when the profile is
 * activated.
 *
 * The same strategy resolution is implemented twice on purpose:
 *   - in `profile-service.ts` (TypeScript, used by the app and by the tests),
 *   - in `resources/systemd/gpu-power-manager-apply.py` (Python, used by the
 *     privileged helper that runs at boot, without Electron).
 * Both implementations follow the rules described by `resolveStrategyWatts`.
 */

import type { ProfileKind, ProfileStrategy } from '../../shared/types';

export interface BuiltinProfileTemplate {
  /** Stable id. Never changes, it is persisted in the profile store. */
  id: string;
  /** Display name shown in the UI. */
  name: string;
  kind: ProfileKind;
  description: string;
  /** Strategy used for every GPU that has no explicit entry in the profile. */
  strategy: ProfileStrategy;
  /** Ratio used when `strategy` is `ratio` (0..1). */
  ratio?: number;
}

export const BUILTIN_PROFILE_TEMPLATES: readonly BuiltinProfileTemplate[] = [
  {
    id: 'builtin-original',
    name: 'Original',
    kind: 'original',
    description: 'Restaura o limite padrão de fábrica de cada GPU.',
    strategy: 'default',
  },
  {
    id: 'builtin-economico',
    name: 'Econômico',
    kind: 'economy',
    description: 'Aplica o menor limite de potência que o driver aceita em cada GPU.',
    strategy: 'min',
  },
  {
    id: 'builtin-balanced',
    name: 'Balanced',
    kind: 'balanced',
    description: 'Aplica 70% da faixa de potência permitida em cada GPU.',
    strategy: 'ratio',
    ratio: 0.7,
  },
  {
    id: 'builtin-performance',
    name: 'Performance',
    kind: 'performance',
    description: 'Mantém o limite padrão de fábrica, nunca ultrapassando o limite do driver.',
    strategy: 'default',
  },
  {
    id: 'builtin-custom',
    name: 'Custom',
    kind: 'custom',
    description: 'Perfil vazio: defina um limite fixo por GPU.',
    strategy: 'default',
  },
];

export const BUILTIN_PROFILE_IDS: readonly string[] = BUILTIN_PROFILE_TEMPLATES.map(
  (template) => template.id,
);

/** Returns the template of a built-in kind, or `null` for user defined kinds. */
export function findBuiltinTemplate(kind: ProfileKind): BuiltinProfileTemplate | null {
  return BUILTIN_PROFILE_TEMPLATES.find((template) => template.kind === kind) ?? null;
}
