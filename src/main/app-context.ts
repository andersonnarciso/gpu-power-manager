/**
 * Composition root.
 *
 * Every service is built here, once, and handed to the IPC layer. Nothing
 * else in the main process is allowed to instantiate a service, so there is a
 * single place where the dependencies between the domains are visible.
 *
 * The renderer never talks to these objects directly: it goes through the IPC
 * handlers, which validate every payload first.
 */

import { app } from 'electron';
import type {
  AppInfo,
  GpuDevice,
  GpuUuid,
  TelemetrySample,
} from '../shared/types';
import type { PowerLimitBounds } from '../shared/contracts';
import type { GpuSource } from './nvidia/source';
import { NvidiaGpuSource } from './nvidia/nvidia-smi';
import { SimulatedGpuSource } from './nvidia/simulator';
import { TelemetryService } from './telemetry/telemetry-service';
import { TelemetryHistory } from './telemetry/history';
import { createPowerLimitService, createPowerLimitBackend } from './power/power-limit-service';
import type { PowerLimitBackend } from './power/backend';
import { ProfileStore } from './profiles/profile-store';
import { ProfileServiceImpl } from './profiles/profile-service';
import type { PowerLimitApplier, PowerBoundsProvider } from './profiles/profile-service';
import { SystemdManager } from './persistence/systemd-manager';
import { buildPayloadFromProfile } from './persistence/payload-builder';
import { SettingsServiceImpl } from './settings/settings-service';
import { createBenchmarkService } from './benchmark';
import type { BenchmarkServiceImpl } from './benchmark/benchmark-service';
import { powerReaderFromDevices, type PowerReader } from './benchmark/power-sampler';
import {
  BENCHMARK_SAMPLE_INTERVAL_MS,
  createDriverPowerReader,
  driverPowerQueryArgs,
} from './benchmark/driver-reader';
import { createOptimizerService } from './optimizer';
import type { OptimizerServiceImpl } from './optimizer/optimizer-service';
import { GpuProcessService } from './processes/process-service';
import { createLogger } from './nvidia/logger';
import { ErrorCode } from '../shared/types';

const logger = createLogger('app');

/**
 * A GPU source that can be swapped at runtime.
 *
 * The user can switch between the real driver and the simulator from the
 * settings page, without restarting the app.
 */
class SwitchableGpuSource implements GpuSource {
  private current: GpuSource;

  constructor(initial: GpuSource) {
    this.current = initial;
  }

  async list(): Promise<GpuDevice[]> {
    return this.current.list();
  }

  async poll(): Promise<GpuDevice[]> {
    return this.current.poll();
  }

  isSimulated(): boolean {
    return this.current.isSimulated();
  }

  async prime(): Promise<void> {
    await this.current.prime?.();
  }

  async use(source: GpuSource): Promise<void> {
    this.current = source;
    await this.current.prime?.();
  }
}

/** A power backend that can be swapped at runtime, mirroring the GPU source. */
class SwitchablePowerBackend implements PowerLimitBackend {
  private current: PowerLimitBackend;

  constructor(initial: PowerLimitBackend) {
    this.current = initial;
  }

  async bounds(uuid: GpuUuid): ReturnType<PowerLimitBackend['bounds']> {
    return this.current.bounds(uuid);
  }

  async apply(uuid: GpuUuid, watts: number): Promise<void> {
    return this.current.apply(uuid, watts);
  }

  async reset(uuid: GpuUuid): Promise<void> {
    return this.current.reset(uuid);
  }

  async exists(uuid: GpuUuid): Promise<boolean> {
    return this.current.exists(uuid);
  }

  isSimulated(): boolean {
    return this.current.isSimulated();
  }

  use(backend: PowerLimitBackend): void {
    this.current = backend;
  }
}

export interface AppContext {
  readonly settings: SettingsServiceImpl;
  readonly telemetry: TelemetryService;
  readonly power: ReturnType<typeof createPowerLimitService>;
  readonly profiles: ProfileServiceImpl;
  readonly persistence: SystemdManager;
  readonly benchmark: BenchmarkServiceImpl;
  readonly optimizer: OptimizerServiceImpl;
  readonly processes: GpuProcessService;
  /** True when the app talks to the simulator instead of real hardware. */
  isSimulated(): boolean;
  /** Applies the simulation preference, swapping the sources when needed. */
  setSimulated(simulated: boolean): Promise<void>;
  /** Re-reads the telemetry interval after a settings change. */
  applyTelemetryInterval(): void;
  info(): AppInfo;
  dispose(): void;
}

export interface CreateAppContextOptions {
  /** Overrides `app.getPath('userData')`, used by the tests. */
  userDataPath?: string;
  /** Forces the simulator on or off, used by the tests. */
  simulate?: boolean;
}

export function createAppContext(options: CreateAppContextOptions = {}): AppContext {
  const userDataPath = options.userDataPath ?? app.getPath('userData');
  const settings = new SettingsServiceImpl({ filePath: `${userDataPath}/settings.json` });

  const preferred = options.simulate ?? settings.get().simulateMode;
  const realSource = new NvidiaGpuSource({ logger });
  const simulatedSource = new SimulatedGpuSource({ logger });

  const source = new SwitchableGpuSource(preferred ? simulatedSource : realSource);

  const history = new TelemetryHistory({ retentionMinutes: settings.get().historyRetentionMinutes });

  const backend = new SwitchablePowerBackend(
    createPowerLimitBackend({ simulate: preferred }),
  );

  const telemetry = new TelemetryService({
    source,
    intervalMs: settings.get().telemetryIntervalMs,
    history,
    logger,
  });

  /**
   * Throttle reasons change slowly and are not supported by every driver, so
   * they are refreshed on a slow timer instead of on every telemetry tick.
   * The reading is cached by the driver client and merged into the devices on
   * the next tick, which keeps the per-tick cost at exactly one process.
   */
  const throttleRefreshMs = 15_000;
  const throttleTimer = setInterval(() => {
    void realSource.refreshThrottleReasons().catch(() => {
      // The driver may not support the throttle query at all. The devices then
      // simply report "no known reason", which is honest.
    });
  }, throttleRefreshMs);
  throttleTimer.unref?.();

  const power = createPowerLimitService({ backend });

  const applier: PowerLimitApplier = {
    async apply(uuid, watts) {
      const result = await power.apply({ uuid, watts });
      return { ok: result.ok, appliedWatts: result.appliedWatts, error: result.error };
    },
    async resetToDefault(uuid) {
      const result = await power.resetToDefault(uuid);
      return { ok: result.ok, appliedWatts: result.appliedWatts, error: result.error };
    },
  };

  const boundsProvider: PowerBoundsProvider = {
    async getBounds(): Promise<PowerLimitBounds[]> {
      const devices = await telemetry.list();
      const bounds: PowerLimitBounds[] = [];
      for (const device of devices) {
        try {
          bounds.push(await power.bounds(device.uuid));
        } catch {
          // A GPU that disappeared between the listing and the query simply
          // has no bounds right now.
        }
      }
      return bounds;
    },
  };

  const profiles = new ProfileServiceImpl(
    new ProfileStore({ filePath: `${userDataPath}/profiles.json` }),
    applier,
    boundsProvider,
  );

  const persistence = new SystemdManager({
    payloadProvider: {
      async buildPayload(profileId) {
        const profile = await profiles.get(profileId);
        if (!profile) {
          throw new Error(`Perfil "${profileId}" não encontrado.`);
        }
        const bounds = await boundsProvider.getBounds();
        return buildPayloadFromProfile(profile, bounds, Date.now());
      },
    },
  });

  /**
   * The benchmark reads the driver DIRECTLY, at its own rate.
   *
   * The telemetry cache is tuned for the UI (1 Hz) and cannot resolve a
   * workload that finishes in less than a second: a single sample means no
   * duration, and no duration means no energy. The benchmark therefore polls
   * the driver itself, one `nvidia-smi` process per tick, and never depends on
   * the polling rate of the interface.
   */
  const driverReader = createDriverPowerReader({
    query: async () => realSource.getClient().run(driverPowerQueryArgs()),
  });

  const benchmarkReader: PowerReader = async () => {
    if (source.isSimulated()) {
      return powerReaderFromDevices(() => telemetry.list())();
    }
    return driverReader();
  };

  const benchmark = createBenchmarkService({
    powerReader: benchmarkReader,
    userDataPath,
    sampleIntervalMs: BENCHMARK_SAMPLE_INTERVAL_MS,
  });

  const optimizer = createOptimizerService({
    // The optimiser reads the measured runs through the small source
    // interface it declares, which the benchmark service satisfies.
    runs: { list: () => benchmark.runs() },
    powerReader: benchmarkReader,
  });

  const processes = new GpuProcessService({ logger });

  const context: AppContext = {
    settings,
    telemetry,
    power,
    profiles,
    persistence,
    benchmark,
    optimizer,
    processes,

    isSimulated(): boolean {
      return source.isSimulated();
    },

    async setSimulated(simulated: boolean): Promise<void> {
      if (simulated === source.isSimulated()) {
        backend.use(createPowerLimitBackend({ simulate: simulated }));
        return;
      }
      await source.use(simulated ? simulatedSource : realSource);
      backend.use(createPowerLimitBackend({ simulate: simulated }));
      // The device list changed: force an immediate refresh so the UI does not
      // keep showing the previous source until the next tick.
      await telemetry.pollOnce();
    },

    applyTelemetryInterval(): void {
      telemetry.setIntervalMs(settings.get().telemetryIntervalMs);
    },

    info(): AppInfo {
      const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
      let nvidiaSmiPath: string | null = null;
      try {
        nvidiaSmiPath = realSource.getClient().getBinaryPath();
      } catch {
        // The binary is only missing when the driver is not installed.
        nvidiaSmiPath = null;
      }
      return {
        version: app.getVersion(),
        electronVersion: process.versions.electron,
        platform: process.platform,
        simulated: source.isSimulated(),
        driverAvailable: !source.isSimulated(),
        runningAsRoot,
        nvidiaSmiPath,
      };
    },

    dispose(): void {
      clearInterval(throttleTimer);
      telemetry.stop();
    },
  };

  return context;
}

/** Builds a `TelemetrySample` with no devices, used before the first tick. */
export function emptySnapshot(): TelemetrySample {
  return { at: Date.now(), gpus: [] };
}

/** Error used when the app is started with an impossible configuration. */
export const NOT_SUPPORTED_ERROR = {
  code: ErrorCode.UnsupportedByDriver,
  message: 'Recurso não suportado pelo driver atual.',
};
