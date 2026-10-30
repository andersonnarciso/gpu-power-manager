/**
 * Range resolution and validation of power limits.
 *
 * The rule enforced by this module: a watt value outside the range the driver
 * reports is REJECTED, never silently clamped. Clamping would hide a mistake
 * from the user and would make the "applied" value differ from the "requested"
 * one.
 */

import type { PowerLimitBounds } from '../../shared/contracts';
import { ErrorCode, type AppError, type GpuUuid } from '../../shared/types';
import type { BackendPowerLimits } from './backend';

/** Human readable range, e.g. `150–180 W`. */
export function formatRange(minWatts: number, maxWatts: number): string {
  return `${minWatts}–${maxWatts} W`;
}

/** Outcome of the range check. */
export type TargetResolution =
  | { ok: true; watts: number }
  | { ok: false; error: AppError };

/**
 * Builds the shared bounds object out of the raw driver values.
 *
 * `adjustable` is false when the driver does not expose a settable range, in
 * which case no change is possible at all.
 */
export function toPowerLimitBounds(
  uuid: GpuUuid,
  limits: BackendPowerLimits,
  adjustable?: boolean,
): PowerLimitBounds {
  const hasRange = limits.min !== null && limits.max !== null;
  const isAdjustable = adjustable ?? (hasRange && limits.min !== limits.max);
  return {
    uuid,
    minWatts: limits.min,
    maxWatts: limits.max,
    defaultWatts: limits.defaultLimit,
    currentWatts: limits.current,
    adjustable: isAdjustable,
  };
}

/**
 * Decides whether a requested watt value may be applied.
 *
 * When the value is refused the returned error names the range the GPU
 * actually supports, so the user knows what to pick.
 */
export function resolveTargetWatts(requested: number, bounds: PowerLimitBounds): TargetResolution {
  const { minWatts, maxWatts } = bounds;
  if (minWatts === null || maxWatts === null) {
    return {
      ok: false,
      error: {
        code: ErrorCode.UnsupportedByDriver,
        message:
          'O driver desta GPU não informa a faixa de limite de potência suportada, portanto a alteração não pode ser feita com segurança.',
        detail: 'Sem a faixa do driver seria necessário adivinhar um valor, o que é proibido.',
      },
    };
  }
  if (requested < minWatts || requested > maxWatts) {
    return {
      ok: false,
      error: {
        code: ErrorCode.ValidationFailed,
        message: `O limite de ${requested} W está fora da faixa suportada por esta GPU (${formatRange(minWatts, maxWatts)}).`,
        detail: `Valores aceitos: ${minWatts}–${maxWatts} W.`,
      },
    };
  }
  return { ok: true, watts: requested };
}

/**
 * Resolves the target of a reset, which is the factory default reported by
 * the driver.
 */
export function resolveDefaultWatts(bounds: PowerLimitBounds): TargetResolution {
  if (bounds.defaultWatts === null) {
    return {
      ok: false,
      error: {
        code: ErrorCode.UnsupportedByDriver,
        message: 'O driver desta GPU não informa o limite de potência padrão, portanto ele não pode ser restaurado.',
      },
    };
  }
  return resolveTargetWatts(bounds.defaultWatts, bounds);
}
