/**
 * Workload adapter contract.
 *
 * An adapter knows how to run ONE kind of workload and how to report how much
 * work was produced. It knows nothing about power, energy or power limits:
 * the benchmark engine measures that around the adapter.
 *
 * An adapter must never invent a number. When the workload cannot report what
 * it produced, it either fails with a precise error or reports
 * `unit: 'unknown'`.
 */

import type {
  GpuUuid,
  ThroughputResult,
  WorkloadAdapterInfo,
  WorkloadKind,
} from '../../../shared/types';

/** Result of probing the machine for the tool the adapter drives. */
export interface AdapterDetection {
  /** True when the tool was found and can be used. */
  available: boolean;
  /** Where the adapter talks to, e.g. "http://127.0.0.1:8188". */
  endpoint: string | null;
  /** Human readable hint, in Brazilian Portuguese. */
  hint: string;
}

/** Everything an adapter needs to run a workload. */
export interface WorkloadRunContext {
  /** UUIDs of the GPUs taking part in the measurement. */
  uuids: GpuUuid[];
  /** Aborted when the user stops the run or the duration limit is reached. */
  signal: AbortSignal;
  /** Hard limit for the workload, in seconds. Null means "no limit". */
  durationLimitSeconds: number | null;
}

/**
 * Throughput result enriched with the measured rate.
 *
 * The shared `ThroughputResult` only carries the amount of work; the rate is
 * what makes two runs comparable, so adapters report it here.
 */
export interface AdapterThroughputResult extends ThroughputResult {
  /** Work per second, when the source reports or allows one. */
  perSecond: number | null;
}

export interface WorkloadAdapter {
  /** Stable id, used in the run configuration. */
  readonly id: string;
  /** Human readable name, in Brazilian Portuguese. */
  readonly name: string;
  /** The workload family this adapter drives. */
  readonly workload: WorkloadKind;
  /** Probes the machine. Never throws: failures become `available: false`. */
  detect(): Promise<AdapterDetection>;
  /** Runs the workload and reports what was produced. */
  run(ctx: WorkloadRunContext): Promise<ThroughputResult>;
}

/**
 * Error raised by an adapter. The message is written for the user, in
 * Brazilian Portuguese, and never leaks a stack trace.
 */
export class AdapterError extends Error {
  readonly code: string;
  /** HTTP status, when the failure came from a server. */
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.status = status;
  }
}

/** Maps an adapter and its detection result to the shared info shape. */
export function toAdapterInfo(
  adapter: WorkloadAdapter,
  detection: AdapterDetection,
): WorkloadAdapterInfo {
  return {
    id: adapter.id,
    name: adapter.name,
    workload: adapter.workload,
    endpoint: detection.endpoint,
    available: detection.available,
    detectionHint: detection.hint,
  };
}

/** Reads a finite number from an unknown payload. */
export function readNumber(payload: unknown, key: string): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/** Reads a nested object from an unknown payload. */
export function readObject(payload: unknown, key: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
