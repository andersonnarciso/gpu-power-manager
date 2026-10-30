/**
 * Simulated GPU source.
 *
 * Built on top of `src/shared/simulation.ts` so the app stays fully usable on
 * a machine without an NVIDIA GPU (and so the tests never need one).
 *
 * Besides the usual "the numbers move around" behaviour, the simulator can
 * make a device disappear from the bus. That is what makes the
 * "GPU desconectado" path of the telemetry engine testable.
 */

import {
  SIMULATED_GPUS,
  SimulatedPowerState,
  createRng,
  simulateGpuSnapshot,
  type SimulatedGpuDefinition,
} from '../../shared/simulation';
import type { GpuDevice } from '../../shared/types';
import { nullLogger, type Logger } from './logger';
import type { GpuSource } from './source';

export type { GpuSource } from './source';

export interface SimulatedSourceOptions {
  /** Devices to simulate. Defaults to the two reference GPUs. */
  definitions?: readonly SimulatedGpuDefinition[];
  /** Seed of the deterministic PRNG. */
  seed?: number;
  /** Mutable power limit state, shared with the power limit service. */
  state?: SimulatedPowerState;
  /** Injectable clock, used for `lastSeenAt`. */
  now?: () => number;
  /** Seconds each poll represents. Drives the workload curve. */
  tickSeconds?: number;
  /** Injectable logger. */
  logger?: Logger;
}

export class SimulatedGpuSource implements GpuSource {
  private readonly definitions: readonly SimulatedGpuDefinition[];
  private readonly state: SimulatedPowerState;
  private readonly rng: () => number;
  private readonly now: () => number;
  private readonly tickSeconds: number;
  private readonly logger: Logger;

  /** UUIDs that are currently plugged in. */
  private readonly connected = new Set<string>();
  /** Pending "unplug after N polls" counters. */
  private readonly pendingDisconnect = new Map<string, number>();

  private tick = 0;

  constructor(options: SimulatedSourceOptions = {}) {
    this.definitions = options.definitions ?? SIMULATED_GPUS;
    this.state = options.state ?? new SimulatedPowerState(this.definitions);
    this.rng = createRng(options.seed);
    this.now = options.now ?? Date.now;
    this.tickSeconds = options.tickSeconds ?? 1;
    this.logger = options.logger ?? nullLogger;
    for (const definition of this.definitions) {
      this.connected.add(definition.uuid);
    }
  }

  /** The mutable power state, so the power limit service can drive it. */
  getPowerState(): SimulatedPowerState {
    return this.state;
  }

  async list(): Promise<GpuDevice[]> {
    return this.poll();
  }

  async poll(): Promise<GpuDevice[]> {
    this.applyPendingDisconnects();

    const at = this.now();
    const elapsedSeconds = this.tick * this.tickSeconds;
    this.tick += 1;

    const devices = simulateGpuSnapshot({
      at,
      elapsedSeconds,
      rng: this.rng,
      state: this.state,
    });

    return devices
      .filter((device) => this.connected.has(device.uuid))
      .map((device) => ({ ...device, present: true }));
  }

  isSimulated(): boolean {
    return true;
  }

  async prime(): Promise<void> {
    // Nothing to bootstrap: the simulator has no driver to talk to.
  }

  /** Simulates the device being unplugged. */
  disconnect(uuid: string): void {
    if (!this.connected.delete(uuid)) {
      this.logger.debug('Desconexão simulada de uma GPU desconhecida.', uuid);
    }
  }

  /** Simulates the device being plugged back in. */
  connect(uuid: string): void {
    this.connected.add(uuid);
    this.pendingDisconnect.delete(uuid);
  }

  /** Simulates the device being unplugged after the given number of polls. */
  disconnectAfterPolls(uuid: string, polls: number): void {
    if (polls <= 0) {
      this.disconnect(uuid);
      return;
    }
    this.pendingDisconnect.set(uuid, polls);
  }

  /** True when the device is currently simulated as connected. */
  isConnected(uuid: string): boolean {
    return this.connected.has(uuid);
  }

  private applyPendingDisconnects(): void {
    for (const [uuid, remaining] of [...this.pendingDisconnect.entries()]) {
      const left = remaining - 1;
      if (left <= 0) {
        this.pendingDisconnect.delete(uuid);
        this.connected.delete(uuid);
        continue;
      }
      this.pendingDisconnect.set(uuid, left);
    }
  }
}
