/**
 * Service contracts.
 *
 * The main process implements the `*Service` interfaces. The IPC layer
 * translates IPC calls into service calls (and is the ONLY place allowed to
 * do so). The renderer talks exclusively to the `GpuPmApi` shape exposed by
 * the preload bridge.
 *
 * These interfaces are the contract that lets independent pieces of the app
 * be developed and verified separately. Do not change a signature here
 * without updating every implementation and the preload bridge.
 */

import type {
  AppError,
  AppInfo,
  AppSettings,
  BenchmarkResult,
  BenchmarkRunConfig,
  EnergySummary,
  EfficiencyResult,
  GpuDevice,
  GpuProcess,
  GpuUuid,
  OperationResult,
  OptimizerRecommendation,
  OptimizerRequest,
  PersistenceStatus,
  PowerLimitChangeResult,
  PowerLimitRequest,
  PowerProfile,
  TelemetrySample,
  ThroughputResult,
  WorkloadAdapterInfo,
} from './types';

/* ------------------------------------------------------------------ limits */

export interface PowerLimitBounds {
  uuid: GpuUuid;
  minWatts: number | null;
  maxWatts: number | null;
  defaultWatts: number | null;
  currentWatts: number | null;
  adjustable: boolean;
}

/* ---------------------------------------------------------------- services */

export interface GpuService {
  /** All GPUs known to the app, including ones that just disappeared. */
  list(): Promise<GpuDevice[]>;
  /** Last telemetry tick, or an empty snapshot before the first tick. */
  snapshot(): TelemetrySample;
  /** True when the app is talking to the simulator instead of real hardware. */
  isSimulated(): boolean;
  /** Subscribe to telemetry pushes. Returns an unsubscribe function. */
  subscribe(listener: (sample: TelemetrySample) => void): () => void;
}

export interface PowerLimitService {
  bounds(uuid: GpuUuid): Promise<PowerLimitBounds>;
  apply(request: PowerLimitRequest): Promise<PowerLimitChangeResult>;
  applyMany(requests: PowerLimitRequest[]): Promise<PowerLimitChangeResult[]>;
  resetToDefault(uuid: GpuUuid): Promise<PowerLimitChangeResult>;
  resetMany(uuids: GpuUuid[]): Promise<PowerLimitChangeResult[]>;
}

export interface ProfileService {
  list(): Promise<PowerProfile[]>;
  get(id: string): Promise<PowerProfile | null>;
  save(profile: PowerProfile): Promise<PowerProfile>;
  remove(id: string): Promise<OperationResult>;
  /** Apply the profile to every GPU it targets. */
  activate(id: string): Promise<PowerLimitChangeResult[]>;
  /** Restore the factory default limits on every GPU. */
  resetDefaults(): Promise<PowerLimitChangeResult[]>;
}

export interface PersistenceService {
  status(): Promise<PersistenceStatus>;
  /** Install the systemd unit + polkit policy. Requires authorization. */
  install(profileId: string): Promise<OperationResult>;
  uninstall(): Promise<OperationResult>;
  /** Enable or disable the boot-time unit. */
  setEnabled(enabled: boolean): Promise<OperationResult>;
  /** Apply the configured profile right now through the helper. */
  applyNow(): Promise<OperationResult>;
}

export interface BenchmarkService {
  adapters(): Promise<WorkloadAdapterInfo[]>;
  start(config: BenchmarkRunConfig): Promise<BenchmarkResult>;
  stop(runId: string): Promise<BenchmarkResult | null>;
  runs(): Promise<BenchmarkResult[]>;
  run(id: string): Promise<BenchmarkResult | null>;
  /** Live samples of a running benchmark. */
  samples(runId: string): Promise<EnergySummary | null>;
}

export interface OptimizerService {
  recommend(request: OptimizerRequest): Promise<OptimizerRecommendation[]>;
}

export interface ProcessService {
  list(): Promise<GpuProcess[]>;
}

export interface SettingsService {
  get(): AppSettings;
  update(patch: Partial<AppSettings>): AppSettings;
}

export interface AppService {
  info(): Promise<AppInfo>;
}

/* ------------------------------------------------------------- preload API */

/**
 * The surface exposed on `window.gpuPm`. Nothing else is reachable from the
 * renderer: no `require`, no `ipcRenderer`, no `process`.
 */
export interface GpuPmApi {
  app: {
    info(): Promise<AppInfo>;
  };
  gpu: {
    list(): Promise<GpuDevice[]>;
    snapshot(): Promise<TelemetrySample>;
    /** Push subscription for telemetry. Returns an unsubscribe function. */
    onTelemetry(listener: (sample: TelemetrySample) => void): () => void;
    onTelemetryError(listener: (error: AppError) => void): () => void;
  };
  power: {
    bounds(uuid: string): Promise<PowerLimitBounds>;
    apply(uuid: string, watts: number): Promise<PowerLimitChangeResult>;
    applyMany(requests: PowerLimitRequest[]): Promise<PowerLimitChangeResult[]>;
    reset(uuid: string): Promise<PowerLimitChangeResult>;
    resetMany(uuids: string[]): Promise<PowerLimitChangeResult[]>;
  };
  profiles: {
    list(): Promise<PowerProfile[]>;
    save(profile: PowerProfile): Promise<PowerProfile>;
    remove(id: string): Promise<OperationResult>;
    activate(id: string): Promise<PowerLimitChangeResult[]>;
    resetDefaults(): Promise<PowerLimitChangeResult[]>;
  };
  persistence: {
    status(): Promise<PersistenceStatus>;
    install(profileId: string): Promise<OperationResult>;
    uninstall(): Promise<OperationResult>;
    setEnabled(enabled: boolean): Promise<OperationResult>;
    applyNow(): Promise<OperationResult>;
  };
  benchmark: {
    adapters(): Promise<WorkloadAdapterInfo[]>;
    start(config: BenchmarkRunConfig): Promise<BenchmarkResult>;
    stop(runId: string): Promise<BenchmarkResult | null>;
    runs(): Promise<BenchmarkResult[]>;
    run(id: string): Promise<BenchmarkResult | null>;
    samples(runId: string): Promise<EnergySummary | null>;
  };
  optimizer: {
    recommend(request: OptimizerRequest): Promise<OptimizerRecommendation[]>;
  };
  processes: {
    list(): Promise<GpuProcess[]>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
}

/** Re-exported so the renderer can type its bridge shim. */
export type { AppError, AppSettings, GpuDevice, TelemetrySample };
export type { ThroughputResult, EfficiencyResult };
