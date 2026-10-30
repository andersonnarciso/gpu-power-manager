/**
 * Profile helpers.
 *
 * Built-in profiles never hardcode watt values: they store a strategy that is
 * resolved against the limits the driver reports for each GPU, at activation
 * time.
 */

import type { GpuDevice, ProfileEntry, ProfileStrategy } from '@shared/types';
import type { PowerLimitBounds } from '@shared/contracts';
import type { TranslationKey } from './i18n';

export interface ProfileTargetInfo {
  uuid: string;
  name: string;
  /** Resolved watts, or null when the GPU is not targeted by the profile. */
  watts: number | null;
  strategy: ProfileStrategy;
  ratio: number | null;
  min: number | null;
  max: number | null;
  defaultWatts: number | null;
}

/** Translation key of a strategy label. */
export function strategyLabelKey(strategy: ProfileStrategy): TranslationKey {
  switch (strategy) {
    case 'default':
      return 'profiles.strategyDefault';
    case 'min':
      return 'profiles.strategyMin';
    case 'ratio':
      return 'profiles.strategyRatio';
    case 'fixed':
      return 'profiles.strategyFixed';
    default:
      return 'profiles.strategyDefault';
  }
}

/** Resolve one entry against the limits reported by the driver. */
export function resolveEntryWatts(
  entry: ProfileEntry,
  min: number | null,
  max: number | null,
  defaultWatts: number | null,
): number | null {
  const strategy: ProfileStrategy =
    entry.strategy ?? (entry.watts !== null && entry.watts !== undefined ? 'fixed' : 'default');

  switch (strategy) {
    case 'default':
      return defaultWatts;
    case 'min':
      return min;
    case 'ratio': {
      if (min === null || max === null) return defaultWatts;
      const ratio = entry.ratio ?? 0.7;
      const raw = min + (max - min) * ratio;
      return Math.round(Math.min(max, Math.max(min, raw)));
    }
    case 'fixed': {
      if (entry.watts === null || entry.watts === undefined) return defaultWatts;
      if (min === null || max === null) return entry.watts;
      return Math.round(Math.min(max, Math.max(min, entry.watts)));
    }
    default:
      return defaultWatts;
  }
}

/** Resolution of a whole profile on this machine. */
export function resolveProfile(
  entries: ProfileEntry[],
  devices: GpuDevice[],
  bounds: Record<string, PowerLimitBounds>,
): ProfileTargetInfo[] {
  return devices.map((device) => {
    const bound = bounds[device.uuid];
    const entry = entries.find((item) => item.uuid === device.uuid);
    const min = bound?.minWatts ?? device.power.minLimitW ?? null;
    const max = bound?.maxWatts ?? device.power.maxLimitW ?? null;
    const defaultWatts = bound?.defaultWatts ?? device.power.defaultLimitW ?? null;

    if (!entry) {
      return {
        uuid: device.uuid,
        name: device.name,
        watts: null,
        strategy: 'default',
        ratio: null,
        min,
        max,
        defaultWatts,
      };
    }

    return {
      uuid: device.uuid,
      name: device.name,
      watts: resolveEntryWatts(entry, min, max, defaultWatts),
      strategy: entry.strategy ?? (entry.watts !== null ? 'fixed' : 'default'),
      ratio: entry.ratio ?? null,
      min,
      max,
      defaultWatts,
    };
  });
}
