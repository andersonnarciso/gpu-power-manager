/**
 * Series helpers for the live charts.
 *
 * The renderer can hold up to one hour of one-second samples. Charts never
 * render that many points: the series is downsampled with the
 * Largest-Triangle-Three-Buckets algorithm, which keeps the visual shape and
 * the peaks of the original signal.
 */

export interface ChartPoint {
  /** Epoch ms on the X axis. */
  at: number;
  /** Value on the Y axis. Null values are skipped. */
  value: number;
}

/**
 * Downsample a series to at most `threshold` points, preserving extremes.
 */
export function downsample(points: ChartPoint[], threshold: number): ChartPoint[] {
  if (threshold <= 0 || points.length <= threshold) return points;

  const sampled: ChartPoint[] = [];
  const every = (points.length - 2) / (threshold - 2);

  let a = 0;
  sampled.push(points[0]);

  for (let i = 0; i < threshold - 2; i += 1) {
    const rangeStart = Math.floor((i + 1) * every) + 1;
    const rangeEnd = Math.min(Math.floor((i + 2) * every) + 1, points.length);

    let avgX = 0;
    let avgY = 0;
    let avgCount = 0;
    for (let j = rangeStart; j < rangeEnd; j += 1) {
      const point = points[j];
      if (!point) continue;
      avgX += point.at;
      avgY += point.value;
      avgCount += 1;
    }
    avgX = avgCount > 0 ? avgX / avgCount : 0;
    avgY = avgCount > 0 ? avgY / avgCount : 0;

    const rangeFrom = Math.floor(i * every) + 1;
    const rangeTo = Math.floor((i + 1) * every) + 1;

    const pointA = points[a];
    let maxArea = -1;
    let maxIndex = rangeFrom;
    for (let j = rangeFrom; j < Math.min(rangeTo, points.length); j += 1) {
      const point = points[j];
      if (!point || !pointA) continue;
      const area = Math.abs(
        (pointA.at - avgX) * (point.value - pointA.value) -
          (pointA.at - point.at) * (avgY - pointA.value),
      );
      if (area > maxArea) {
        maxArea = area;
        maxIndex = j;
      }
    }

    const chosen = points[maxIndex];
    if (chosen) sampled.push(chosen);
    a = maxIndex;
  }

  const last = points[points.length - 1];
  if (last) sampled.push(last);
  return sampled;
}

/** Highest and lowest value of a series. */
export function seriesExtremes(points: ChartPoint[]): { min: number; max: number } {
  if (points.length === 0) return { min: 0, max: 0 };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.value < min) min = point.value;
    if (point.value > max) max = point.value;
  }
  return { min, max };
}

/** Arithmetic mean of a series. */
export function seriesAverage(points: ChartPoint[]): number | null {
  if (points.length === 0) return null;
  let sum = 0;
  for (const point of points) sum += point.value;
  return sum / points.length;
}

/** Build a "nice" axis domain around the data, snapped to round steps. */
export function niceDomain(points: ChartPoint[], padding = 0.15): [number, number] {
  const { min, max } = seriesExtremes(points);
  if (min === max) return [min - 1, max + 1];
  const span = max - min;
  const lower = Math.max(0, min - span * padding);
  const upper = max + span * padding;
  const step = niceStep((upper - lower) / 4);
  return [Math.floor(lower / step) * step, Math.ceil(upper / step) * step];
}

/** Round a raw axis step to 1, 2, 5 or 10 times a power of ten. */
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalised = raw / magnitude;
  const factor = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return factor * magnitude;
}
