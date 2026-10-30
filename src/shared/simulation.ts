/**
 * Simulation foundation.
 *
 * The app must be fully usable and testable on a machine without an NVIDIA
 * GPU. Everything needed for that lives here so that the telemetry engine and
 * the power-limit engine can both use it without depending on each other.
 *
 * The simulated hardware intentionally mirrors the reference machine:
 *   GPU 0: NVIDIA GeForce RTX 4070 Ti, 12 GB
 *   GPU 1: NVIDIA GeForce RTX 5060 Ti, 16 GB (power limit 150-180 W)
 */

import type {
  GpuDevice,
  MemoryInfo,
  PowerInfo,
  ClockInfo,
  ThrottleInfo,
  GpuCapabilities,
} from './types';

export interface SimulatedGpuDefinition {
  uuid: string;
  index: number;
  name: string;
  pciBusId: string;
  driverVersion: string;
  vbiosVersion: string;
  totalMemoryMiB: number;
  minLimitW: number;
  defaultLimitW: number;
  maxLimitW: number;
  /** Relative "busyness" of this device, 0 = always idle, 1 = fully loaded. */
  loadFactor: number;
}

export const SIMULATED_DRIVER_VERSION = '595.84';
export const SIMULATED_CUDA_VERSION = '13.2';

/**
 * The simulated devices use **obviously synthetic** UUIDs.
 *
 * They deliberately do NOT reuse the UUIDs of any real GPU: a simulated device
 * must never be indistinguishable from a real one, otherwise simulated
 * telemetry could be mistaken for (or mixed with) real measurements for the
 * same device. The values below still satisfy the NVIDIA UUID format so that
 * every validation path is exercised exactly as it is with real hardware.
 */
export const SIMULATED_GPUS: readonly SimulatedGpuDefinition[] = [
  {
    uuid: 'GPU-00000000-0000-4000-8000-000000000001',
    index: 0,
    name: 'NVIDIA GeForce RTX 4070 Ti (simulado)',
    pciBusId: '00000000:01:00.0',
    driverVersion: SIMULATED_DRIVER_VERSION,
    vbiosVersion: '95.04.3C.C0.1A',
    totalMemoryMiB: 12282,
    minLimitW: 100,
    defaultLimitW: 285,
    maxLimitW: 285,
    loadFactor: 0.55,
  },
  {
    uuid: 'GPU-00000000-0000-4000-8000-000000000002',
    index: 1,
    name: 'NVIDIA GeForce RTX 5060 Ti (simulado)',
    pciBusId: '00000000:06:00.0',
    driverVersion: SIMULATED_DRIVER_VERSION,
    vbiosVersion: '98.06.4E.00.8D',
    totalMemoryMiB: 16311,
    minLimitW: 150,
    defaultLimitW: 180,
    maxLimitW: 180,
    loadFactor: 0.2,
  },
];

/** Mutable power-limit state for the simulated devices. */
export class SimulatedPowerState {
  private readonly limits = new Map<string, number>();

  constructor(definitions: readonly SimulatedGpuDefinition[] = SIMULATED_GPUS) {
    for (const def of definitions) {
      this.limits.set(def.uuid, def.defaultLimitW);
    }
  }

  getLimitW(uuid: string): number | null {
    return this.limits.get(uuid) ?? null;
  }

  /**
   * Applies a new limit. Returns false when the value is outside the
   * supported range, exactly like the real driver does.
   */
  setLimitW(uuid: string, watts: number): boolean {
    const def = SIMULATED_GPUS.find((g) => g.uuid === uuid);
    if (!def) return false;
    if (!Number.isInteger(watts) || watts < def.minLimitW || watts > def.maxLimitW) {
      return false;
    }
    this.limits.set(uuid, watts);
    return true;
  }

  reset(uuid: string): boolean {
    const def = SIMULATED_GPUS.find((g) => g.uuid === uuid);
    if (!def) return false;
    this.limits.set(uuid, def.defaultLimitW);
    return true;
  }

  resetAll(): void {
    for (const def of SIMULATED_GPUS) {
      this.limits.set(def.uuid, def.defaultLimitW);
    }
  }
}

/** Small deterministic PRNG (mulberry32) so simulations and tests repeat. */
export function createRng(seed = 0x9e3779b9): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export interface SimulateOptions {
  /** Epoch ms of the sample. */
  at: number;
  /** Elapsed seconds since the simulation started, drives the workload curve. */
  elapsedSeconds: number;
  rng: () => number;
  state: SimulatedPowerState;
}

/**
 * Produces a realistic-looking telemetry reading for the simulated devices.
 * Power draw is derived from the *current* power limit so that lowering the
 * limit visibly lowers the measured consumption.
 */
export function simulateGpuSnapshot(options: SimulateOptions): GpuDevice[] {
  const { at, elapsedSeconds, rng, state } = options;

  return SIMULATED_GPUS.map((def) => {
    // A slow sine makes the load oscillate instead of looking like noise.
    const wave = Math.sin(elapsedSeconds / 7 + def.index * 1.3);
    const util = Math.max(
      0,
      Math.min(100, Math.round((def.loadFactor * 55 + wave * 22 + (rng() - 0.5) * 8) * 1.0)),
    );

    const limitW = state.getLimitW(def.uuid) ?? def.defaultLimitW;
    const defaultW = def.defaultLimitW;
    const ratio = defaultW > 0 ? limitW / defaultW : 1;

    // Idle board power is a fixed overhead, the rest scales with the limit.
    const idleW = 6.8;
    const activeW = (defaultW - idleW) * ratio;
    const drawW = round1(idleW + activeW * (util / 100) * (0.55 + rng() * 0.12));

    const usedMiB = Math.round(
      def.totalMemoryMiB * (0.04 + (util / 100) * 0.42 + rng() * 0.03),
    );
    const memory: MemoryInfo = {
      totalMiB: def.totalMemoryMiB,
      usedMiB,
      freeMiB: Math.max(0, def.totalMemoryMiB - usedMiB),
    };

    const power: PowerInfo = {
      drawW,
      limitW,
      defaultLimitW: def.defaultLimitW,
      minLimitW: def.minLimitW,
      maxLimitW: def.maxLimitW,
      enforcedLimitW: limitW,
    };

    const smMHz = util > 3 ? Math.round(900 + (util / 100) * 1800 * ratio) : Math.round(210 + rng() * 60);
    const clocks: ClockInfo = {
      smMHz,
      memMHz: util > 3 ? 1401 : 405,
      maxSmMHz: Math.round(2610 * ratio),
      maxMemMHz: 1401,
    };

    const temperatureC = Math.round(34 + (util / 100) * 22 * ratio + rng() * 2);
    const throttling: ThrottleInfo = {
      active: false,
      reasons: [],
      raw: '0x0000000000000001',
    };

    const capabilities: GpuCapabilities = {
      powerLimitAdjustable: def.minLimitW !== def.maxLimitW,
      fanControl: false,
      clockControl: false,
      persistenceMode: true,
    };

    return {
      uuid: def.uuid,
      index: def.index,
      name: def.name,
      pciBusId: def.pciBusId,
      driverVersion: def.driverVersion,
      vbiosVersion: def.vbiosVersion,
      cudaVersion: SIMULATED_CUDA_VERSION,
      memory,
      utilizationGpuPercent: util,
      utilizationMemoryPercent: Math.round(
        def.totalMemoryMiB > 0 ? (usedMiB / def.totalMemoryMiB) * 100 : 0,
      ),
      temperatureC,
      power,
      clocks,
      fanSpeedPercent: null,
      throttling,
      capabilities,
      computeMode: 'Default',
      persistenceMode: 'Disabled',
      present: true,
      lastSeenAt: at,
    } satisfies GpuDevice;
  });
}
