/**
 * Resolution of the profile strategies against the live driver limits.
 *
 * A `ProfileEntry` never carries a hardcoded watt value for the built-in
 * profiles: it carries a *strategy* that is resolved against the limits the
 * driver reports for that specific GPU.
 *
 * Rules:
 *  - `default`: the factory default limit of the GPU.
 *  - `min`: the lowest limit the driver accepts.
 *  - `ratio`: a point inside the allowed range, `min + ratio * (max - min)`,
 *    clamped to `[min, max]`. `ratio = 0.7` therefore means "70% of the way
 *    through the allowed range".
 *  - `fixed`: the exact watt value of the entry. A value outside the allowed
 *    range is **rejected**, never clamped.
 *
 * The effective maximum is the smallest of "the maximum the driver accepts"
 * and "the factory default". The application never raises the power limit
 * above the factory default of a card.
 */

import type { ProfileStrategy } from '../../shared/types';

export interface PowerLimitRange {
  minWatts: number;
  maxWatts: number;
  defaultWatts: number | null;
}

export interface StrategyTarget {
  strategy: ProfileStrategy;
  ratio?: number | undefined;
  watts: number | null;
}

export type StrategyResolution =
  | { ok: true; watts: number }
  | { ok: false; reason: string };

/** The highest watt value the application is allowed to apply. */
export function effectiveMaxWatts(range: PowerLimitRange): number {
  if (range.defaultWatts !== null && range.defaultWatts < range.maxWatts) {
    return range.defaultWatts;
  }
  return range.maxWatts;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Resolves a strategy into a concrete watt value. */
export function resolveStrategyWatts(
  target: StrategyTarget,
  range: PowerLimitRange,
): StrategyResolution {
  const max = effectiveMaxWatts(range);
  const min = range.minWatts;

  switch (target.strategy) {
    case 'default': {
      if (range.defaultWatts === null) {
        return {
          ok: false,
          reason: 'O driver não informou o limite padrão de fábrica desta GPU.',
        };
      }
      return { ok: true, watts: clamp(Math.round(range.defaultWatts), min, max) };
    }
    case 'min': {
      return { ok: true, watts: min };
    }
    case 'ratio': {
      const ratio = target.ratio;
      if (ratio === undefined || ratio === null || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
        return { ok: false, reason: 'A proporção do perfil deve estar entre 0 e 1.' };
      }
      const raw = min + ratio * (max - min);
      return { ok: true, watts: clamp(Math.round(raw), min, max) };
    }
    case 'fixed': {
      const watts = target.watts;
      if (watts === null || !Number.isInteger(watts)) {
        return { ok: false, reason: 'O limite fixo do perfil não foi informado.' };
      }
      if (watts < min || watts > max) {
        return {
          ok: false,
          reason: `O limite fixo de ${watts} W está fora da faixa aceita (${min}–${max} W).`,
        };
      }
      return { ok: true, watts };
    }
    default: {
      return { ok: false, reason: 'Estratégia de perfil desconhecida.' };
    }
  }
}
