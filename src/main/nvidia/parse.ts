/**
 * Pure parsers for the text `nvidia-smi` produces.
 *
 * Everything in this file is side-effect free: no process is spawned, no file
 * is read. That keeps the parsing rules unit testable against captured real
 * output and makes the behaviour of the driver adapter easy to reason about.
 *
 * House rules inherited from `src/shared/types.ts`:
 *  - a value the driver does not expose becomes `null`, never a fake `0`;
 *  - GPUs are identified by UUID, the driver index is only a hint;
 *  - malformed input raises a controlled {@link NvidiaParseError} instead of
 *    letting `undefined` leak into the rest of the app.
 */

import { isValidGpuUuid } from '../../shared/validation';
import type {
  ClockInfo,
  GpuCapabilities,
  GpuDevice,
  MemoryInfo,
  PowerInfo,
  ThrottleInfo,
} from '../../shared/types';

/* ------------------------------------------------------------------ errors */

/** Raised when the driver output cannot be interpreted. */
export class NvidiaParseError extends Error {
  readonly code = 'NVIDIA_PARSE_FAILED';
  /** Raw payload that could not be parsed, truncated for readability. */
  readonly payload: string;

  constructor(message: string, payload = '') {
    super(message);
    this.name = 'NvidiaParseError';
    this.payload = payload.length > 400 ? `${payload.slice(0, 400)}...` : payload;
  }
}

/* ----------------------------------------------------------------- fields */

/**
 * Fields requested by the single per-tick query. The order is part of the
 * contract with {@link parseGpuCsv}, so it must never change silently.
 */
export const GPU_QUERY_FIELDS: readonly string[] = [
  'index',
  'name',
  'uuid',
  'pci.bus_id',
  'driver_version',
  'vbios_version',
  'memory.total',
  'memory.used',
  'utilization.gpu',
  'utilization.memory',
  'temperature.gpu',
  'power.draw',
  'power.limit',
  'power.default_limit',
  'power.min_limit',
  'power.max_limit',
  'enforced.power.limit',
  'clocks.current.sm',
  'clocks.current.memory',
  'clocks.max.sm',
  'clocks.max.memory',
  'fan.speed',
  'persistence_mode',
  'compute_mode',
];

/**
 * Throttle flags queried in a separate, optional call. Not every driver
 * supports them, hence they are never part of the mandatory tick query.
 */
export const THROTTLE_QUERY_FIELDS: readonly string[] = [
  'clocks_event_reasons.gpu_idle',
  'clocks_event_reasons.applications_clocks_setting',
  'clocks_event_reasons.sw_power_cap',
  'clocks_event_reasons.hw_slowdown',
  'clocks_event_reasons.hw_thermal_slowdown',
  'clocks_event_reasons.sw_thermal_slowdown',
  'clocks_event_reasons.hw_power_brake_slowdown',
  'clocks_event_reasons.sync_boost',
];

/** Human readable label for every throttle reason, in query-field order. */
export const THROTTLE_REASON_LABELS: readonly string[] = [
  'Idle',
  'Applications Clocks Setting',
  'SW Power Cap',
  'HW Slowdown',
  'HW Thermal Slowdown',
  'SW Thermal Slowdown',
  'HW Power Brake Slowdown',
  'Sync Boost',
];

/** NVML bit positions of each throttle reason. */
export const THROTTLE_REASON_BITS: Readonly<Record<string, number>> = {
  Idle: 0x0000000000000001,
  'Applications Clocks Setting': 0x0000000000000002,
  'SW Power Cap': 0x0000000000000004,
  'HW Slowdown': 0x0000000000000008,
  'HW Thermal Slowdown': 0x0000000000000010,
  'SW Thermal Slowdown': 0x0000000000000020,
  'HW Power Brake Slowdown': 0x0000000000000040,
  'Sync Boost': 0x0000000000000080,
  'Display Clock Setting': 0x0000000000000100,
};

/* ------------------------------------------------------------- primitives */

/** Tokens the driver uses to say "this measurement does not exist". */
const MISSING_TOKENS: ReadonlySet<string> = new Set([
  '',
  'n/a',
  'na',
  'none',
  'not supported',
  'not available',
  'not supported yet',
  '-',
  '--',
]);

/**
 * True when the raw cell means "no value". Covers `N/A`, `[N/A]`,
 * `Not Supported`, `[Not Supported]`, `-` and the empty string.
 */
export function isMissingValue(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return true;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') return true;
  const stripped = trimmed.replace(/^\[/, '').replace(/\]$/, '').trim();
  return MISSING_TOKENS.has(stripped);
}

/** Parses a float, returning `null` for missing or malformed values. */
export function parseNullableNumber(raw: string | null | undefined): number | null {
  if (isMissingValue(raw)) return null;
  const value = Number(String(raw).trim().replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  return value;
}

/** Parses an integer, returning `null` for missing or malformed values. */
export function parseNullableInt(raw: string | null | undefined): number | null {
  const value = parseNullableNumber(raw);
  if (value === null) return null;
  return Math.round(value);
}

/**
 * Parses a number that the domain type declares as non-nullable. Unknown
 * values collapse to `0` instead of poisoning the whole snapshot.
 */
export function parseNumberOrZero(raw: string | null | undefined): number {
  return parseNullableNumber(raw) ?? 0;
}

/** Parses a free-form string, returning `null` when the driver reports none. */
export function parseNullableString(raw: string | null | undefined): string | null {
  if (isMissingValue(raw)) return null;
  const trimmed = String(raw).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Normalises a PCI bus id so that `00000000:01:00.0` and `0:1:0.0` compare
 * equal. The driver is inconsistent about leading zeros between queries.
 */
export function normalizeBusId(raw: string | null | undefined): string | null {
  if (isMissingValue(raw)) return null;
  const trimmed = String(raw).trim().toLowerCase();
  if (trimmed === '') return null;
  const match = /^([0-9a-f]+):([0-9a-f]+):([0-9a-f]+)\.([0-9]+)$/.exec(trimmed);
  if (!match) return trimmed;
  const strip = (value: string): string => value.replace(/^0+(?=.)/, '');
  return `${strip(match[1])}:${strip(match[2])}:${strip(match[3])}.${strip(match[4])}`;
}

/* ---------------------------------------------------------------- throttle */

/** Throttle information for one device, as read from the driver. */
export interface ThrottleReading {
  /** Driver index, when the source reported one. */
  index: number | null;
  /** PCI bus id, when the source reported one. */
  busId: string | null;
  throttle: ThrottleInfo;
}

/** True when a throttle flag cell means the reason is currently active. */
export function isThrottleFlagActive(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === '') return false;
  if (value.includes('not active')) return false;
  return value.includes('active');
}

/** Builds the NVML style bitmask that matches the given reasons. */
export function buildThrottleMask(reasons: readonly string[]): string {
  let mask = 0;
  for (const reason of reasons) {
    if (Object.prototype.hasOwnProperty.call(THROTTLE_REASON_BITS, reason)) {
      mask |= THROTTLE_REASON_BITS[reason];
    }
  }
  return `0x${mask.toString(16).padStart(16, '0')}`;
}

/** Decodes an NVML bitmask into human readable reasons. */
export function parseThrottleBitmask(raw: string | null | undefined): ThrottleInfo {
  if (raw === null || raw === undefined) {
    return { active: false, reasons: [], raw: null };
  }
  const trimmed = raw.trim();
  if (trimmed === '' || isMissingValue(trimmed)) {
    return { active: false, reasons: [], raw: null };
  }
  const numeric = trimmed.startsWith('0x') || trimmed.startsWith('0X')
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number.parseInt(trimmed, 10);
  if (!Number.isFinite(numeric)) {
    return { active: false, reasons: [], raw: trimmed };
  }
  const reasons: string[] = [];
  for (const [label, bit] of Object.entries(THROTTLE_REASON_BITS)) {
    if ((numeric & bit) === bit) reasons.push(label);
  }
  return { active: reasons.length > 0, reasons, raw: trimmed };
}

/**
 * Parses the `clocks_event_reasons` query output.
 *
 * Layout: `index, flag, flag, ...` where every flag is `Active` or
 * `Not Active`.
 */
export function parseThrottleQueryCsv(csv: string): ThrottleReading[] {
  const rows = splitRows(csv);
  const readings: ThrottleReading[] = [];
  for (const row of rows) {
    const cells = row.split(',').map((cell) => cell.trim());
    if (cells.length < 2) {
      throw new NvidiaParseError('Linha de throttle reasons incompleta.', row);
    }
    const index = parseNullableInt(cells[0]);
    const reasons: string[] = [];
    for (let i = 1; i < cells.length; i += 1) {
      const label = THROTTLE_REASON_LABELS[i - 1];
      if (label === undefined) continue;
      if (isThrottleFlagActive(cells[i])) reasons.push(label);
    }
    readings.push({
      index,
      busId: null,
      throttle: { active: reasons.length > 0, reasons, raw: buildThrottleMask(reasons) },
    });
  }
  return readings;
}

/**
 * Parses `nvidia-smi -q -d PERFORMANCE`, the fallback used when the driver
 * does not support the `clocks_event_reasons` query fields.
 */
export function parseThrottlePerformanceText(text: string): ThrottleReading[] {
  const readings: ThrottleReading[] = [];
  let current: { busId: string } | null = null;
  let reasons: string[] = [];
  let inReasons = false;
  let reasonsIndent = -1;

  const flush = (): void => {
    if (current === null) return;
    readings.push({
      index: null,
      busId: current.busId,
      throttle: { active: reasons.length > 0, reasons, raw: buildThrottleMask(reasons) },
    });
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const indent = line.length - line.trimStart().length;

    const gpuHeader = /^GPU\s+(\S+)$/.exec(trimmed);
    if (gpuHeader) {
      flush();
      current = { busId: gpuHeader[1] };
      reasons = [];
      inReasons = false;
      reasonsIndent = -1;
      continue;
    }

    // The counters block shares the prefix, so it must be checked first.
    if (trimmed.startsWith('Clocks Event Reasons Counters')) {
      inReasons = false;
      continue;
    }
    if (trimmed === 'Clocks Event Reasons') {
      inReasons = true;
      reasonsIndent = indent;
      continue;
    }

    if (!inReasons || current === null) continue;
    if (indent <= reasonsIndent) {
      inReasons = false;
      continue;
    }
    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;
    const label = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (label === '') continue;
    if (isThrottleFlagActive(value) && !reasons.includes(label)) {
      reasons.push(label);
    }
  }

  flush();
  return readings;
}

/** Picks the throttle information that belongs to a device. */
export function matchThrottleReading(
  readings: readonly ThrottleReading[],
  busId: string | null,
  index: number,
): ThrottleInfo | null {
  const normalizedBus = normalizeBusId(busId);
  for (const reading of readings) {
    if (normalizedBus && reading.busId) {
      if (normalizeBusId(reading.busId) === normalizedBus) return reading.throttle;
    }
  }
  for (const reading of readings) {
    if (reading.index !== null && reading.index === index) return reading.throttle;
  }
  return null;
}

/* --------------------------------------------------------------------- cuda */

/**
 * Extracts the CUDA version from the `nvidia-smi` banner (or from the
 * `-q` output, which repeats it). Returns `null` when the banner is absent.
 */
export function parseCudaVersion(text: string): string | null {
  const match = /CUDA\s+Version\s*:\s*([0-9]+(?:\.[0-9]+)*)/i.exec(text);
  if (!match) return null;
  const version = match[1];
  return version === '' ? null : version;
}

/* --------------------------------------------------------------------- gpus */

/** Everything the parser needs besides the raw CSV row. */
export interface GpuParseContext {
  /** Epoch ms used as `lastSeenAt` for every device of this tick. */
  at: number;
  /** CUDA version reported by the driver banner, when known. */
  cudaVersion?: string | null;
  /** Throttle information collected by a separate call. */
  throttle?: readonly ThrottleReading[];
}

/** Splits a CSV payload into non-empty, trimmed rows. */
export function splitRows(csv: string): string[] {
  return csv
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row !== '');
}

/**
 * Parses one CSV row of the GPU query into a {@link GpuDevice}.
 *
 * The device name is the only free-form field and may contain commas, so the
 * surplus cells are folded back into the name.
 */
export function parseGpuRow(row: string, context: GpuParseContext): GpuDevice {
  const cells = row.split(',');
  const expected = GPU_QUERY_FIELDS.length;
  if (cells.length < expected) {
    throw new NvidiaParseError(
      `Linha de GPU com ${cells.length} campos, esperado ${expected}.`,
      row,
    );
  }

  const surplus = cells.length - expected;
  const name = cells
    .slice(1, 2 + surplus)
    .map((cell) => cell.trim())
    .join(', ');
  const rest = cells.slice(2 + surplus).map((cell) => cell.trim());

  const rawUuid = rest[0] ?? '';
  if (!isValidGpuUuid(rawUuid)) {
    throw new NvidiaParseError(`UUID de GPU inválido: "${rawUuid}".`, row);
  }

  const index = parseNullableInt(cells[0]?.trim() ?? '');
  if (index === null) {
    throw new NvidiaParseError(`Índice de GPU inválido: "${cells[0] ?? ''}".`, row);
  }

  const totalMiB = parseNumberOrZero(rest[4]);
  const usedMiB = parseNumberOrZero(rest[5]);
  const memory: MemoryInfo = {
    totalMiB,
    usedMiB,
    freeMiB: Math.max(0, totalMiB - usedMiB),
  };

  const power: PowerInfo = {
    drawW: parseNullableNumber(rest[9]),
    limitW: parseNullableNumber(rest[10]),
    defaultLimitW: parseNullableNumber(rest[11]),
    minLimitW: parseNullableNumber(rest[12]),
    maxLimitW: parseNullableNumber(rest[13]),
    enforcedLimitW: parseNullableNumber(rest[14]),
  };

  const clocks: ClockInfo = {
    smMHz: parseNullableInt(rest[15]),
    memMHz: parseNullableInt(rest[16]),
    maxSmMHz: parseNullableInt(rest[17]),
    maxMemMHz: parseNullableInt(rest[18]),
  };

  const persistenceMode = parseNullableString(rest[20]);
  const fanSpeedPercent = parseNullableInt(rest[19]);

  const capabilities: GpuCapabilities = {
    powerLimitAdjustable:
      power.minLimitW !== null && power.maxLimitW !== null && power.minLimitW !== power.maxLimitW,
    fanControl: fanSpeedPercent !== null,
    clockControl: clocks.maxSmMHz !== null,
    persistenceMode: persistenceMode !== null,
  };

  const throttle =
    matchThrottleReading(context.throttle ?? [], rest[1] ?? null, index) ??
    ({ active: false, reasons: [], raw: null } satisfies ThrottleInfo);

  return {
    uuid: rawUuid,
    index,
    name: name === '' ? 'NVIDIA GPU' : name,
    pciBusId: parseNullableString(rest[1]),
    driverVersion: parseNullableString(rest[2]),
    vbiosVersion: parseNullableString(rest[3]),
    cudaVersion: context.cudaVersion ?? null,
    memory,
    utilizationGpuPercent: parseNumberOrZero(rest[6]),
    utilizationMemoryPercent: parseNumberOrZero(rest[7]),
    temperatureC: parseNullableInt(rest[8]),
    power,
    clocks,
    fanSpeedPercent,
    throttling: throttle,
    capabilities,
    computeMode: parseNullableString(rest[21]),
    persistenceMode,
    present: true,
    lastSeenAt: context.at,
  };
}

/** Parses the whole CSV payload of the GPU query. */
export function parseGpuCsv(csv: string, context: GpuParseContext): GpuDevice[] {
  const rows = splitRows(csv);
  const devices: GpuDevice[] = [];
  for (const row of rows) {
    devices.push(parseGpuRow(row, context));
  }
  return devices;
}

/* ---------------------------------------------------------------- processes */

/** One GPU process row, before the friendly name detection. */
export interface GpuProcessRow {
  pid: number;
  processName: string;
  gpuUuid: string | null;
  /** Driver index, when the source reported one. */
  gpuIndex: number | null;
  usedMemoryMiB: number | null;
  gpuUtilizationPercent: number | null;
  type: 'compute' | 'graphics';
}

/** True when the cell looks like a GPU UUID. */
export function looksLikeGpuUuid(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && isValidGpuUuid(raw.trim());
}

/**
 * Parses `--query-compute-apps` output.
 *
 * The process name is free-form and may contain commas, so the numeric and
 * uuid columns are read from the end of the row.
 */
export function parseComputeAppsCsv(csv: string): GpuProcessRow[] {
  const rows = splitRows(csv);
  const processes: GpuProcessRow[] = [];
  for (const row of rows) {
    // The raw cells are kept: the process name is free-form and may contain
    // commas, so it is rejoined exactly as the driver printed it.
    const cells = row.split(',');
    const pid = parseNullableInt(cells[0]);
    if (pid === null) continue;

    const lastCell = cells[cells.length - 1]?.trim() ?? '';
    const hasUuid = cells.length >= 4 && looksLikeGpuUuid(lastCell);
    const memoryCell = hasUuid
      ? (cells[cells.length - 2]?.trim() ?? '')
      : (cells[cells.length - 1]?.trim() ?? '');
    const nameEnd = cells.length - (hasUuid ? 2 : 1);
    const processName = cells.slice(1, Math.max(1, nameEnd)).join(',').trim();

    processes.push({
      pid,
      processName,
      gpuUuid: hasUuid ? lastCell : null,
      gpuIndex: null,
      usedMemoryMiB: parseNullableInt(memoryCell),
      gpuUtilizationPercent: null,
      type: 'compute',
    });
  }
  return processes;
}

/**
 * Parses `--query-accounted-apps` output. This query does not expose the
 * process name on Linux, so the name is resolved later from `/proc`.
 */
export function parseAccountedAppsCsv(csv: string): GpuProcessRow[] {
  const rows = splitRows(csv);
  const processes: GpuProcessRow[] = [];
  for (const row of rows) {
    const cells = row.split(',').map((cell) => cell.trim());
    const pid = parseNullableInt(cells[0]);
    if (pid === null) continue;
    const gpuUuid = cells.length >= 4 && looksLikeGpuUuid(cells[1]) ? cells[1] : null;
    processes.push({
      pid,
      processName: '',
      gpuUuid,
      gpuIndex: null,
      usedMemoryMiB: parseNullableInt(cells[3]),
      gpuUtilizationPercent: parseNullableInt(cells[2]),
      type: 'graphics',
    });
  }
  return processes;
}

/**
 * Parses `nvidia-smi pmon -c 1` output, the fallback used when the driver
 * refuses the `--query-accounted-apps` fields.
 */
export function parsePmonOutput(text: string): GpuProcessRow[] {
  const processes: GpuProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const cells = trimmed.split(/\s+/);
    if (cells.length < 3) continue;
    const gpuIndex = parseNullableInt(cells[0]);
    const pid = parseNullableInt(cells[1]);
    if (gpuIndex === null || pid === null) continue;
    const typeCell = cells[2];
    const type: 'compute' | 'graphics' = typeCell === 'C' ? 'compute' : 'graphics';
    const processName = cells.slice(9).join(' ').trim();
    processes.push({
      pid,
      processName,
      gpuUuid: null,
      gpuIndex,
      usedMemoryMiB: null,
      gpuUtilizationPercent: null,
      type,
    });
  }
  return processes;
}
