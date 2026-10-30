/**
 * Contract of the power limit backend.
 *
 * A backend knows how to read the limits of a GPU and how to change them.
 * There are two implementations: the real one, which talks to the NVIDIA
 * driver (and delegates the privileged part to the helper), and the simulated
 * one, which behaves exactly the same so the whole app can be exercised on a
 * machine without an NVIDIA GPU.
 */

import type { GpuUuid } from '../../shared/types';

/** Limits of a single GPU as reported by the driver. */
export interface BackendPowerLimits {
  /** Lowest limit the driver accepts, watts. Null when the driver hides it. */
  min: number | null;
  /** Highest limit the driver accepts, watts. Null when the driver hides it. */
  max: number | null;
  /** Factory default limit, watts. Null when the driver hides it. */
  defaultLimit: number | null;
  /** Limit currently configured, watts. Null when the driver hides it. */
  current: number | null;
}

export interface PowerLimitBackend {
  /** True when the backend simulates the hardware instead of driving it. */
  isSimulated(): boolean;
  /** True when the driver knows the given GPU. */
  exists(uuid: GpuUuid): Promise<boolean>;
  /** Reads the live limits of a GPU. */
  bounds(uuid: GpuUuid): Promise<BackendPowerLimits>;
  /**
   * Applies a new limit.
   *
   * Fails when the value is outside the range supported by the GPU: the
   * value is never silently clamped.
   */
  apply(uuid: GpuUuid, watts: number): Promise<void>;
  /** Restores the factory default limit. */
  reset(uuid: GpuUuid): Promise<void>;
}
