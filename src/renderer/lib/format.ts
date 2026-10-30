/**
 * Number and unit formatting.
 *
 * Every measurement is rendered through these helpers so units and precision
 * are consistent across the whole app. Missing measurements are shown as an
 * em dash, never as a zero.
 */

import type { Locale } from '@shared/types';

/** Rendered whenever the driver did not expose a value. */
export const EM_DASH = '—';

const formatterCache = new Map<string, Intl.NumberFormat>();
const dateTimeCache = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: Locale, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  const cached = formatterCache.get(key);
  if (cached) return cached;
  const created = new Intl.NumberFormat(locale, options);
  formatterCache.set(key, created);
  return created;
}

function dateTimeFormatter(locale: Locale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  const cached = dateTimeCache.get(key);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat(locale, options);
  dateTimeCache.set(key, created);
  return created;
}

function isPresent(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Format a raw number with the active locale. */
export function formatNumber(
  locale: Locale,
  value: number | null | undefined,
  options: Intl.NumberFormatOptions = {},
): string {
  if (!isPresent(value)) return EM_DASH;
  return formatter(locale, options).format(value);
}

/** Integer with no decimals: `285`. */
export function formatInt(locale: Locale, value: number | null | undefined): string {
  return formatNumber(locale, value, { maximumFractionDigits: 0 });
}

/** One decimal: `62.4`. */
export function formatDecimal1(locale: Locale, value: number | null | undefined): string {
  return formatNumber(locale, value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Two decimals: `0.34`. */
export function formatDecimal2(locale: Locale, value: number | null | undefined): string {
  return formatNumber(locale, value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Watts: `285 W`. */
export function formatWatts(locale: Locale, value: number | null | undefined): string {
  if (!isPresent(value)) return EM_DASH;
  return `${formatInt(locale, value)} W`;
}

/** Degrees Celsius: `62 °C`. */
export function formatTemperature(locale: Locale, value: number | null | undefined): string {
  if (!isPresent(value)) return EM_DASH;
  return `${formatInt(locale, value)} °C`;
}

/** Megabytes of video memory: `4 208 MiB`. */
export function formatMiB(locale: Locale, value: number | null | undefined): string {
  if (!isPresent(value)) return EM_DASH;
  return `${formatInt(locale, value)} MiB`;
}

/** Percentage: `37 %`. */
export function formatPercent(locale: Locale, value: number | null | undefined): string {
  if (!isPresent(value)) return EM_DASH;
  return `${formatInt(locale, value)} %`;
}

/** Megahertz: `2 310 MHz`. */
export function formatMHz(locale: Locale, value: number | null | undefined): string {
  if (!isPresent(value)) return EM_DASH;
  return `${formatInt(locale, value)} MHz`;
}

/** Joules: `1 240 J`. */
export function formatJoules(locale: Locale, value: number | null | undefined): string {
  if (!isPresent(value)) return EM_DASH;
  return `${formatNumber(locale, value, { maximumFractionDigits: 1 })} J`;
}

/** Watt-hours: `0.34 Wh`. */
export function formatWattHours(locale: Locale, value: number | null | undefined): string {
  if (!isPresent(value)) return EM_DASH;
  return `${formatNumber(locale, value, { minimumFractionDigits: 2, maximumFractionDigits: 3 })} Wh`;
}

/** Signed percentage delta, always with an explicit sign. */
export function formatDeltaPercent(locale: Locale, value: number | null | undefined): string {
  if (!isPresent(value)) return EM_DASH;
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatDecimal1(locale, value)} %`;
}

/** Seconds: `12.4 s`. */
export function formatSeconds(locale: Locale, value: number | null | undefined): string {
  if (!isPresent(value)) return EM_DASH;
  return `${formatNumber(locale, value, { maximumFractionDigits: 1 })} s`;
}

/** Wall clock time: `14:32:05`. */
export function formatClockTime(locale: Locale, timestamp: number | null | undefined): string {
  if (!isPresent(timestamp)) return EM_DASH;
  return dateTimeFormatter(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(timestamp);
}

/** Date and time: `29/10/2026 14:32`. */
export function formatDateTime(locale: Locale, timestamp: number | null | undefined): string {
  if (!isPresent(timestamp)) return EM_DASH;
  return dateTimeFormatter(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(timestamp);
}

/** Energy per unit of work, e.g. `0.42 J/token`. */
export function formatEnergyPerUnit(
  locale: Locale,
  joules: number | null | undefined,
  unitSuffix: string,
): string {
  if (!isPresent(joules)) return EM_DASH;
  return `${formatNumber(locale, joules, { minimumFractionDigits: 2, maximumFractionDigits: 3 })} ${unitSuffix}`;
}
