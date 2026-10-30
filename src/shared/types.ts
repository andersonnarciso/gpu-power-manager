/**
 * Domain types shared between the Electron main process, the preload bridge and
 * the React renderer. This file is the single source of truth for the shape of
 * every value that crosses the IPC boundary.
 *
 * Rules that apply to everything in here:
 *  - GPUs are ALWAYS identified by UUID. The `index` reported by the driver is
 *    only a display hint and is never stable across reboots.
 *  - Any measurement that the driver may not expose is `null`, never a fake 0.
 *  - Power limit values are watts, integers.
 */

/* ------------------------------------------------------------------ errors */

/** Machine readable error codes surfaced to the renderer. */
export const ErrorCode = {
  ValidationFailed: 'VALIDATION_FAILED',
  GpuNotFound: 'GPU_NOT_FOUND',
  UnsupportedByDriver: 'UNSUPPORTED_BY_DRIVER',
  PermissionDenied: 'PERMISSION_DENIED',
  AuthorizationDenied: 'AUTHORIZATION_DENIED',
  AuthorizationUnavailable: 'AUTHORIZATION_UNAVAILABLE',
  PrivilegedHelperMissing: 'PRIVILEGED_HELPER_MISSING',
  DriverUnavailable: 'DRIVER_UNAVAILABLE',
  CommandFailed: 'COMMAND_FAILED',
  Timeout: 'TIMEOUT',
  ProfileNotFound: 'PROFILE_NOT_FOUND',
  ProfileInvalid: 'PROFILE_INVALID',
  PersistenceFailed: 'PERSISTENCE_FAILED',
  BenchmarkFailed: 'BENCHMARK_FAILED',
  AdapterUnavailable: 'ADAPTER_UNAVAILABLE',
  /** The run finished, but the driver only answered part of the time. */
  MeasurementIncomplete: 'MEASUREMENT_INCOMPLETE',
  Unknown: 'UNKNOWN',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Structured, user-comprehensible error. Never a raw stack trace. */
export interface AppError {
  code: ErrorCodeValue | string;
  message: string;
  detail?: string;
  /** Set when the failure was caused by the user cancelling an authorization dialog. */
  cancelled?: boolean;
}

/* -------------------------------------------------------------------- gpus */

export type GpuUuid = string;

export interface MemoryInfo {
  totalMiB: number;
  usedMiB: number;
  freeMiB: number;
}

export interface PowerInfo {
  /** Instantaneous board power draw in watts. */
  drawW: number | null;
  /** Currently configured power limit in watts. */
  limitW: number | null;
  /** Factory default power limit in watts. */
  defaultLimitW: number | null;
  /** Lowest power limit the driver accepts. */
  minLimitW: number | null;
  /** Highest power limit the driver accepts. */
  maxLimitW: number | null;
  /** Power limit actually enforced by the hardware right now. */
  enforcedLimitW: number | null;
}

export interface ClockInfo {
  smMHz: number | null;
  memMHz: number | null;
  maxSmMHz: number | null;
  maxMemMHz: number | null;
}

export interface ThrottleInfo {
  active: boolean;
  /** Human readable throttle reasons, e.g. "SW Power Cap". */
  reasons: string[];
  /** Raw driver bitmask, kept for diagnostics. */
  raw: string | null;
}

export interface GpuCapabilities {
  /** True when the driver exposes a settable power limit. */
  powerLimitAdjustable: boolean;
  /** True when the driver exposes fan speed control. */
  fanControl: boolean;
  /** True when the driver exposes clock controls. */
  clockControl: boolean;
  /** True when persistence mode can be toggled. */
  persistenceMode: boolean;
}

export interface GpuDevice {
  /** Stable identity across reboots. Always present, always the primary key. */
  uuid: GpuUuid;
  /** Driver index. Display hint only. */
  index: number;
  name: string;
  pciBusId: string | null;
  driverVersion: string | null;
  vbiosVersion: string | null;
  /** CUDA version reported by the driver (e.g. "13.2"). */
  cudaVersion: string | null;
  memory: MemoryInfo;
  utilizationGpuPercent: number;
  utilizationMemoryPercent: number;
  temperatureC: number | null;
  power: PowerInfo;
  clocks: ClockInfo;
  fanSpeedPercent: number | null;
  throttling: ThrottleInfo;
  capabilities: GpuCapabilities;
  computeMode: string | null;
  persistenceMode: string | null;
  /** False when the device was seen before but is currently missing. */
  present: boolean;
  /** Epoch ms of the last successful reading for this device. */
  lastSeenAt: number;
}

/** One full telemetry tick across every known GPU. */
export interface TelemetrySample {
  /** Epoch ms. */
  at: number;
  gpus: GpuDevice[];
}

/* ------------------------------------------------------------- power limit */

export interface PowerLimitRequest {
  uuid: GpuUuid;
  watts: number;
}

export interface PowerLimitVerification {
  /** True when the limit was re-read from the driver and matched the request. */
  confirmed: boolean;
  observedLimitW: number | null;
  observedAt: number;
}

export interface PowerLimitChangeResult {
  uuid: GpuUuid;
  requestedWatts: number;
  /** Limit the driver reports after the change. Null when unknown. */
  appliedWatts: number | null;
  ok: boolean;
  error?: AppError;
  verification?: PowerLimitVerification;
}

/* ----------------------------------------------------------------- profiles */

export type ProfileKind = 'original' | 'economy' | 'balanced' | 'performance' | 'custom';

/**
 * How the watts for a profile entry are derived.
 *
 * Built-in profiles must not hardcode watt values: the supported range differs
 * per GPU, and the set of GPUs differs per machine. A strategy is resolved
 * against the live driver limits at activation time.
 */
export type ProfileStrategy =
  /** Factory default power limit of that GPU. */
  | 'default'
  /** Lowest power limit the driver accepts for that GPU. */
  | 'min'
  /** A ratio of the allowed range (0..1), clamped to min/max. */
  | 'ratio'
  /** An explicit watt value (`watts`). */
  | 'fixed';

export interface ProfileEntry {
  uuid: GpuUuid;
  /** Target watts. `null` means "restore the factory default for this GPU". */
  watts: number | null;
  /** Resolution strategy. Defaults to `fixed` when `watts` is set, `default` otherwise. */
  strategy?: ProfileStrategy;
  /** Ratio used when `strategy` is `ratio` (0..1). */
  ratio?: number;
}

export interface PowerProfile {
  id: string;
  name: string;
  kind: ProfileKind;
  description: string;
  /** Built-in profiles cannot be deleted but can be edited/reset. */
  builtin: boolean;
  entries: ProfileEntry[];
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------- persistence */

export interface PersistenceStatus {
  /** systemd unit file present on disk. */
  installed: boolean;
  /** Unit enabled (will run at boot). */
  enabled: boolean;
  /** Unit file path. */
  unitPath: string | null;
  /** Profile applied by the unit at boot. */
  profileId: string | null;
  lastAppliedAt: number | null;
  lastError: string | null;
  /** polkit policy installed. */
  polkitInstalled: boolean;
  /** Privileged helper binary installed. */
  helperInstalled: boolean;
}

/* ---------------------------------------------------------------- benchmark */

export type WorkloadKind =
  | 'llm-inference'
  | 'image-generation'
  | 'video-generation'
  | 'cuda-synthetic'
  | 'manual';

export interface BenchmarkRunConfig {
  name: string;
  workload: WorkloadKind;
  /** Workload adapter id, null for manual/measured runs. */
  adapterId: string | null;
  /** GPUs participating in the measurement. */
  uuids: GpuUuid[];
  /** Target power limit per GPU (uuid -> watts). */
  wattsPerGpu: Record<GpuUuid, number>;
  /** Hard stop for the run, seconds. Null = until the workload finishes. */
  durationLimitSeconds: number | null;
}

export interface BenchmarkMeasurement {
  at: number;
  /** Measured power per GPU uuid, watts. */
  powerW: Record<GpuUuid, number>;
  /**
   * Measured temperature per GPU uuid, degrees Celsius.
   *
   * A GPU that did not report a temperature is simply absent from the map:
   * its temperature is unknown, never zero.
   */
  temperatureC?: Record<GpuUuid, number>;
  /**
   * Power limit the driver reported at the time of the reading, per GPU uuid.
   *
   * It is what the driver REALLY had configured, not what the user asked for.
   * A GPU that did not report a limit is absent from the map.
   */
  powerLimitW?: Record<GpuUuid, number>;
}

export interface EnergyPerGpu {
  joules: number;
  wattHours: number;
  avgPowerW: number;
  peakPowerW: number;
  /**
   * Window actually measured for this GPU, in milliseconds.
   *
   * It tells "no time was measured" apart from "time was measured and the
   * board drew no power at all".
   */
  measuredMs?: number | null;
  /**
   * Fraction of the run that was really measured for this GPU, in percent.
   *
   * Null when the duration of the run is unknown.
   */
  coveragePct?: number | null;
  /** Average measured temperature, °C. Null when no temperature was read. */
  avgTemperatureC?: number | null;
  /** Highest measured temperature, °C. Null when no temperature was read. */
  maxTemperatureC?: number | null;
}

export interface EnergySummary {
  /** Total energy across every participating GPU, joules. */
  joulesTotal: number;
  /** Total energy across every participating GPU, watt-hours. */
  wattHoursTotal: number;
  perGpu: Record<GpuUuid, EnergyPerGpu>;
  /** Window actually measured, in milliseconds. Null when nothing was measured. */
  measuredMs?: number | null;
  /**
   * Fraction of the run that was really measured, in percent.
   *
   * It is the window covered for EVERY participating GPU: a GPU that was only
   * measured during part of the run makes the whole measurement incomplete.
   * Null when the duration of the run is unknown.
   */
  coveragePct?: number | null;
  /**
   * Nominal sampling period of the measurement, in milliseconds.
   *
   * It is the resolution of the measurement: a window shorter than one
   * sampling period cannot resolve any energy.
   */
  sampleIntervalMs?: number | null;
  /** Average measured temperature, °C. Null when no temperature was read. */
  avgTemperatureC?: number | null;
  /** Highest measured temperature, °C. Null when no temperature was read. */
  maxTemperatureC?: number | null;
}

export type ThroughputUnit = 'token' | 'image' | 'video-second' | 'unknown';

export interface ThroughputResult {
  unit: ThroughputUnit;
  /** Amount of work completed (tokens, images, seconds of video). */
  count: number;
  /** Human readable description of the work unit. */
  label: string;
  /** Source of the number, e.g. "ollama /api/generate". */
  source: string;
  /**
   * Measured rate of work, per second.
   *
   * Only a rate makes two runs comparable: a count is the amount of work of a
   * single run and says nothing about how fast it was produced.
   */
  perSecond?: number | null;
}

/**
 * Status of a benchmark run.
 *
 * `partial` means the workload finished, but the driver only answered part of
 * the time: the energy of the run is NOT the energy of the whole workload and
 * such a run must never be ranked as if it were complete.
 */
export type BenchmarkStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'aborted';

export interface BenchmarkResult {
  id: string;
  config: BenchmarkRunConfig;
  startedAt: number;
  endedAt: number | null;
  status: BenchmarkStatus;
  durationSeconds: number | null;
  energy: EnergySummary | null;
  throughput: ThroughputResult | null;
  samples: BenchmarkMeasurement[];
  error?: AppError;
  /**
   * Window really covered by the driver readings of the run, in milliseconds.
   *
   * It is the window covered for EVERY selected GPU. Null when it is unknown.
   */
  measuredMs?: number | null;
  /**
   * Fraction of the run that was really measured, in percent (0..100).
   *
   * Null when the duration of the run is unknown. A run below the minimum
   * acceptable coverage is published as `partial`, never as `completed`.
   */
  coveragePct?: number | null;
  /**
   * True when the power limit the driver REALLY had configured matched the
   * requested target for the whole run.
   *
   * False when the observed limit did not match, and null when the limit could
   * not be observed at all. A run that is not verified is not valid for its
   * label and must never be compared with another limit.
   */
  limitVerified?: boolean | null;
  /**
   * Power limit the driver reported for each selected GPU, in watts.
   *
   * Null for a GPU whose limit could not be read. It is what the hardware had
   * configured, never what the user asked for.
   */
  observedLimitsW?: Record<GpuUuid, number | null>;
}

/** Energy normalised by work completed. */
export interface EfficiencyResult {
  /** Joules per unit of work (per token, per image, per video second). */
  joulesPerUnit: number | null;
  /** Wh per unit of work. */
  wattHoursPerUnit: number | null;
  unit: ThroughputUnit;
  count: number;
}

export interface WorkloadAdapterInfo {
  id: string;
  name: string;
  workload: WorkloadKind;
  /** Where the adapter talks to, e.g. "http://127.0.0.1:8188". */
  endpoint: string | null;
  /** False when the target tool was not detected on this machine. */
  available: boolean;
  detectionHint: string;
}

/* ---------------------------------------------------------------- optimizer */

export interface OptimizerRequest {
  uuid: GpuUuid;
  workload: WorkloadKind;
  /** Power limits to evaluate, watts. */
  candidateWatts: number[];
  /** Maximum acceptable performance loss in percent (0-100). */
  maxPerformanceLossPct: number;
  /** Baseline result the candidates are compared against. */
  baselineRunId: string | null;
}

export interface OptimizerRecommendation {
  uuid: GpuUuid;
  /** Recommended power limit in watts. */
  watts: number;
  baselineWatts: number | null;
  /** Performance delta vs baseline, percent. Negative means slower. */
  performanceDeltaPct: number | null;
  /** Energy delta vs baseline, percent. Negative means cheaper. */
  energyDeltaPct: number | null;
  /** True when the candidate satisfies the performance constraint. */
  meetsConstraint: boolean;
  reason: string;
  /**
   * True when NO candidate qualified and the reference was kept.
   *
   * It is not a recommendation: nothing was proven to be better than the
   * reference, so the interface must not present it as one.
   */
  fallback?: boolean;
}

/* ---------------------------------------------------------------- processes */

export interface GpuProcess {
  pid: number;
  name: string;
  /** UUID of the GPU the process runs on, when resolvable. */
  gpuUuid: GpuUuid | null;
  usedMemoryMiB: number | null;
  type: 'compute' | 'graphics';
  /** Detected application family, e.g. "ComfyUI", "llama.cpp", "Ollama". */
  friendlyApp: string | null;
}

/* ----------------------------------------------------------------- settings */

export type Locale = 'pt-BR' | 'en';
export type ThemeMode = 'dark' | 'light' | 'system';

export interface AppSettings {
  locale: Locale;
  theme: ThemeMode;
  telemetryEnabled: boolean;
  /** Telemetry polling interval in milliseconds. */
  telemetryIntervalMs: number;
  historyWindowMinutes: 1 | 5 | 15 | 60;
  /** How long telemetry history is kept in memory, minutes. */
  historyRetentionMinutes: number;
  /** Force the simulated GPU source, even when real hardware exists. */
  simulateMode: boolean;
  autoApplyProfileOnBoot: boolean;
  reduceMotion: boolean;
  /**
   * Base URL of the Ollama server used by the benchmark.
   *
   * Optional: when it is absent the default of the adapter is used
   * (`http://127.0.0.1:11434`).
   */
  ollamaUrl?: string;
  /**
   * Base URL of the llama.cpp server used by the benchmark.
   *
   * Optional: when it is absent the default of the adapter is used
   * (`http://127.0.0.1:8080`).
   */
  llamaCppUrl?: string;
  /**
   * Base URL of the ComfyUI server used by the benchmark.
   *
   * Optional: when it is absent the default of the adapter is used
   * (`http://127.0.0.1:8188`).
   */
  comfyUiUrl?: string;
  /**
   * Executable of the Unsloth benchmark.
   *
   * Optional: a plain executable name or path, without shell metacharacters.
   */
  unslothCommand?: string;
  /** Arguments of the Unsloth command. Optional. */
  unslothArgs?: string[];
}

/* -------------------------------------------------------------------- misc */

export interface AppInfo {
  version: string;
  electronVersion: string;
  platform: string;
  /** True when the app is running against simulated GPUs. */
  simulated: boolean;
  /** True when an NVIDIA driver was detected. */
  driverAvailable: boolean;
  /** True when the process runs as root (must never happen). */
  runningAsRoot: boolean;
  nvidiaSmiPath: string | null;
}

export interface OperationResult {
  ok: boolean;
  error?: AppError;
}
