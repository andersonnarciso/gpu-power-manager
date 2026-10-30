/**
 * The abstraction that hides "real hardware" from "simulated hardware".
 *
 * The telemetry engine only knows about this interface, so the very same
 * polling code runs against the real NVIDIA driver and against the built-in
 * simulator.
 */

import type { GpuDevice } from '../../shared/types';

export interface GpuSource {
  /**
   * Reads the current state of every GPU. Used for on-demand refreshes
   * (e.g. right after a power limit change).
   */
  list(): Promise<GpuDevice[]>;

  /**
   * Reads the current state, honouring the internal caches of the source.
   * This is what the telemetry tick calls: it must stay cheap, because it
   * runs once per second.
   */
  poll(): Promise<GpuDevice[]>;

  /** True when the source fabricates the data instead of reading hardware. */
  isSimulated(): boolean;

  /**
   * Optional one-time bootstrap, e.g. reading the CUDA version banner.
   * Called once when the service starts, never per tick.
   */
  prime?(): Promise<void>;
}
