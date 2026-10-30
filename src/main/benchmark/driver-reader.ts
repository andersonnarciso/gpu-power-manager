/**
 * High frequency driver reader.
 *
 * The benchmark needs a resolution that the telemetry cache cannot provide:
 * the UI polls the driver once per second, so a workload that finishes in
 * 800 ms would be measured with a single sample and the app would claim that
 * it consumed exactly zero energy.
 *
 * This reader therefore talks to the driver directly, with one
 * `nvidia-smi --query-gpu=uuid,power.draw,temperature.gpu,power.limit` per
 * tick:
 *
 *  - the command is always an argv array, never a shell string;
 *  - only four fields are requested, so the payload stays tiny;
 *  - the query is injectable, so the tests never need a GPU.
 *
 * The reader never changes anything in the driver: it only reads. The power
 * limit is observed exactly as the hardware has it configured, which is what
 * makes it possible to tell whether a run really happened at the limit the
 * user asked for.
 */

import { isValidGpuUuid } from '../../shared/validation';
import { parseNullableNumber, splitRows } from '../nvidia/parse';
import type { PowerReader, PowerReading } from './power-sampler';

/**
 * Nominal sampling period of the benchmark, in milliseconds.
 *
 * 5 Hz is fast enough to resolve a workload of a few hundred milliseconds and
 * slow enough to keep the number of driver processes per second reasonable.
 */
export const BENCHMARK_SAMPLE_INTERVAL_MS = 200;

/** Fields of the single per tick query. The order is part of the contract. */
export const DRIVER_POWER_QUERY_FIELDS: readonly string[] = [
  'uuid',
  'power.draw',
  'temperature.gpu',
  'power.limit',
];

/** Builds the argv of the query. Never a shell string. */
export function driverPowerQueryArgs(): string[] {
  return [
    `--query-gpu=${DRIVER_POWER_QUERY_FIELDS.join(',')}`,
    '--format=csv,noheader,nounits',
  ];
}

/**
 * Parses the CSV of the query.
 *
 * A GPU whose power, temperature or limit the driver does not expose keeps a
 * `null` reading: it is unknown, never zero.
 */
export function parseDriverPowerCsv(csv: string): PowerReading[] {
  const readings: PowerReading[] = [];

  for (const row of splitRows(csv ?? '')) {
    const cells = row.split(',').map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const uuid = cells[0];
    if (!isValidGpuUuid(uuid)) continue;
    readings.push({
      uuid,
      watts: parseNullableNumber(cells[1]),
      temperatureC: parseNullableNumber(cells[2]),
      limitW: cells.length > 3 ? parseNullableNumber(cells[3]) : null,
    });
  }

  return readings;
}

export interface DriverPowerReaderOptions {
  /** Runs the query and returns its stdout. */
  query: () => Promise<string>;
}

/** Builds a reader that queries the driver on every tick. */
export function createDriverPowerReader(options: DriverPowerReaderOptions): PowerReader {
  return async () => parseDriverPowerCsv(await options.query());
}
