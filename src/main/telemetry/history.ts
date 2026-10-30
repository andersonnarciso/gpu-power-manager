/**
 * Bounded telemetry history.
 *
 * The renderer draws charts from this buffer, so it must not grow without
 * limits: it keeps at most `maxSamples` entries and only the last
 * `retentionMinutes` of data.
 *
 * {@link downsample} reduces a series to a fixed number of points while
 * keeping the first and the last sample, so the chart always shows the whole
 * window and both extremes.
 */

import type { TelemetrySample } from '../../shared/types';

/** Fixed size ring buffer. */
class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.items = new Array<T | undefined>(Math.max(1, capacity));
  }

  get size(): number {
    return this.count;
  }

  push(item: T): void {
    if (this.items.length === 0) return;
    const tail = (this.head + this.count) % this.items.length;
    this.items[tail] = item;
    if (this.count === this.items.length) {
      this.head = (this.head + 1) % this.items.length;
    } else {
      this.count += 1;
    }
  }

  /** Oldest first. */
  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i += 1) {
      const item = this.items[(this.head + i) % this.items.length];
      if (item !== undefined) result.push(item);
    }
    return result;
  }

  /** Oldest first, limited to the last `count` items. */
  tail(count: number): T[] {
    const all = this.toArray();
    return count <= 0 ? [] : all.slice(Math.max(0, all.length - count));
  }

  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}

export interface TelemetryHistoryOptions {
  /** Hard cap on the number of kept samples. */
  maxSamples?: number;
  /** How long the data is kept, in minutes. */
  retentionMinutes?: number;
  /** Injectable clock. */
  now?: () => number;
}

const DEFAULT_MAX_SAMPLES = 7200; // 2 hours at 1 Hz
const DEFAULT_RETENTION_MINUTES = 60;

export class TelemetryHistory {
  private readonly buffer: RingBuffer<TelemetrySample>;
  private readonly now: () => number;
  private retentionMinutes: number;

  constructor(options: TelemetryHistoryOptions = {}) {
    this.buffer = new RingBuffer<TelemetrySample>(options.maxSamples ?? DEFAULT_MAX_SAMPLES);
    this.now = options.now ?? Date.now;
    this.retentionMinutes = Math.max(0, options.retentionMinutes ?? DEFAULT_RETENTION_MINUTES);
  }

  /** Adds a sample and drops whatever fell out of the retention window. */
  push(sample: TelemetrySample): void {
    this.buffer.push(sample);
    this.prune();
  }

  /** Every retained sample, oldest first. */
  list(): TelemetrySample[] {
    return this.buffer.toArray();
  }

  /** The last `count` samples, oldest first. */
  tail(count: number): TelemetrySample[] {
    return this.buffer.tail(count);
  }

  /** The most recent sample, or `null` when the buffer is empty. */
  latest(): TelemetrySample | null {
    const all = this.buffer.toArray();
    return all.length > 0 ? (all[all.length - 1] as TelemetrySample) : null;
  }

  /** Number of retained samples. */
  size(): number {
    return this.buffer.size;
  }

  /** Drops everything. */
  clear(): void {
    this.buffer.clear();
  }

  /** Retention window, in minutes. */
  getRetentionMinutes(): number {
    return this.retentionMinutes;
  }

  /** Changes the retention window and prunes immediately. */
  setRetentionMinutes(minutes: number): void {
    this.retentionMinutes = Math.max(0, minutes);
    this.prune();
  }

  /** Removes the samples that are older than the retention window. */
  prune(): void {
    if (this.retentionMinutes <= 0) return;
    const cutoff = this.now() - this.retentionMinutes * 60_000;
    const kept = this.buffer.toArray().filter((sample) => sample.at >= cutoff);
    if (kept.length === this.buffer.size) return;
    this.buffer.clear();
    for (const sample of kept) this.buffer.push(sample);
  }
}

/**
 * Reduces a series to at most `maxPoints` entries.
 *
 * The first and the last element are always preserved. When `valueOf` is
 * provided the largest-triangle-three-buckets algorithm is used, which keeps
 * the peaks and the valleys of the series; otherwise the series is reduced
 * with an even bucketing.
 */
export function downsample<T>(
  samples: readonly T[],
  maxPoints: number,
  valueOf?: (sample: T) => number,
): T[] {
  const length = samples.length;
  if (maxPoints <= 0) return [];
  if (length === 0) return [];
  if (length <= maxPoints) return [...samples];
  if (maxPoints === 1) return [samples[0] as T];
  if (maxPoints === 2) return [samples[0] as T, samples[length - 1] as T];

  if (valueOf === undefined) {
    return downsampleEvenly(samples, maxPoints);
  }
  return downsampleLargestTriangle(samples, maxPoints, valueOf);
}

/** Even bucketing: keeps the first, the last and one point per bucket. */
function downsampleEvenly<T>(samples: readonly T[], maxPoints: number): T[] {
  const length = samples.length;
  const interior = maxPoints - 2;
  const bucketSize = (length - 2) / interior;
  const result: T[] = [samples[0] as T];
  for (let i = 0; i < interior; i += 1) {
    const start = 1 + Math.floor(i * bucketSize);
    const end = Math.min(1 + Math.floor((i + 1) * bucketSize), length - 1);
    const middle = Math.min(start, end - 1);
    result.push(samples[Math.max(1, middle)] as T);
  }
  result.push(samples[length - 1] as T);
  return result;
}

/**
 * Largest-triangle-three-buckets. Keeps the shape of the series, which
 * matters a lot for a power chart: a short spike must stay visible.
 */
function downsampleLargestTriangle<T>(
  samples: readonly T[],
  maxPoints: number,
  valueOf: (sample: T) => number,
): T[] {
  const length = samples.length;
  const interior = maxPoints - 2;
  const bucketSize = (length - 2) / interior;
  const result: T[] = [samples[0] as T];

  let anchor = 0;
  for (let i = 0; i < interior; i += 1) {
    const rangeStart = Math.floor((i + 1) * bucketSize) + 1;
    const rangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, length);

    let averageX = 0;
    let averageY = 0;
    let averageCount = 0;
    for (let j = rangeStart; j < rangeEnd; j += 1) {
      averageX += j;
      averageY += valueOf(samples[j] as T);
      averageCount += 1;
    }
    if (averageCount > 0) {
      averageX /= averageCount;
      averageY /= averageCount;
    }

    const areaStart = Math.floor(i * bucketSize) + 1;
    const areaEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, length - 1);

    let bestArea = -1;
    let bestIndex = areaStart;
    for (let j = areaStart; j < areaEnd; j += 1) {
      const area = Math.abs(
        (anchor - averageX) * (valueOf(samples[j] as T) - valueOf(samples[anchor] as T)) -
          (anchor - j) * (averageY - valueOf(samples[anchor] as T)),
      );
      if (area > bestArea) {
        bestArea = area;
        bestIndex = j;
      }
    }

    result.push(samples[bestIndex] as T);
    anchor = bestIndex;
  }

  result.push(samples[length - 1] as T);
  return result;
}
