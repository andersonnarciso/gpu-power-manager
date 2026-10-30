/**
 * Helpers shared by the renderer suites.
 *
 * The renderer never talks to Node: every test drives the pages through a
 * stubbed bridge, so the suite never needs a GPU.
 */

/* --------------------------------------------------------------- jsdom gaps */

/**
 * jsdom implements neither the pointer capture API nor `PointerEvent`, and
 * Radix UI needs both to open a select. The polyfills below are the ones the
 * Radix documentation recommends for the test environment.
 */
class FakePointerEvent extends window.MouseEvent {
  pointerType: string;

  constructor(type: string, params: PointerEventInit = {}) {
    super(type, params);
    this.pointerType = params.pointerType ?? 'mouse';
  }
}

Object.assign(Element.prototype, {
  hasPointerCapture: () => false,
  setPointerCapture: () => undefined,
  releasePointerCapture: () => undefined,
  scrollIntoView: () => undefined,
});

Object.defineProperty(window, 'PointerEvent', {
  writable: true,
  configurable: true,
  value: FakePointerEvent,
});

/** jsdom has no ResizeObserver, which Radix UI needs to measure its widgets. */
class FakeResizeObserver {
  observe(): void {
    /* nothing to observe in jsdom */
  }

  unobserve(): void {
    /* nothing to observe in jsdom */
  }

  disconnect(): void {
    /* nothing to observe in jsdom */
  }
}

Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  configurable: true,
  value: FakeResizeObserver,
});

/* ------------------------------------------------------------------- stubs */

import type { GpuPmApi } from '@shared/contracts';
import type {
  BenchmarkResult,
  GpuDevice,
  OptimizerRecommendation,
  OptimizerRequest,
  WorkloadAdapterInfo,
} from '@shared/types';

/** Everything the stubbed bridge answers with. */
export interface StubState {
  runs: BenchmarkResult[];
  adapters: WorkloadAdapterInfo[];
  recommendations: OptimizerRecommendation[];
  /** Limits applied through the bridge, in order. */
  applied: { uuid: string; watts: number }[];
  /** Runs started through the bridge, in order. */
  started: unknown[];
  /** Requests sent to the optimiser, in order. */
  requests: OptimizerRequest[];
}

/** A fresh state for the stubbed bridge. */
export function createStubState(): StubState {
  return {
    runs: [],
    adapters: [],
    recommendations: [],
    applied: [],
    started: [],
    requests: [],
  };
}

/** A bridge that answers with the given state and never touches the hardware. */
export function createStubBridge(state: StubState): GpuPmApi {
  return {
    app: { info: async () => ({}) as never },
    gpu: {
      list: async () => [],
      snapshot: async () => ({ at: Date.now(), gpus: [] }),
      onTelemetry: () => () => undefined,
      onTelemetryError: () => () => undefined,
    },
    power: {
      bounds: async () => ({
        uuid: '',
        minWatts: null,
        maxWatts: null,
        defaultWatts: null,
        currentWatts: null,
        adjustable: false,
      }),
      apply: async (uuid: string, watts: number) => {
        state.applied.push({ uuid, watts });
        return {
          uuid,
          requestedWatts: watts,
          appliedWatts: watts,
          ok: true,
          verification: { confirmed: true, observedLimitW: watts, observedAt: Date.now() },
        };
      },
      applyMany: async () => [],
      reset: async () => ({ uuid: '', requestedWatts: 0, appliedWatts: null, ok: true }),
      resetMany: async () => [],
    },
    profiles: {
      list: async () => [],
      save: async () => ({}) as never,
      remove: async () => ({ ok: true }),
      activate: async () => [],
      resetDefaults: async () => [],
    },
    persistence: {
      status: async () => ({}) as never,
      install: async () => ({ ok: true }),
      uninstall: async () => ({ ok: true }),
      setEnabled: async () => ({ ok: true }),
      applyNow: async () => ({ ok: true }),
    },
    benchmark: {
      adapters: async () => state.adapters,
      start: async (config) => {
        state.started.push(config);
        return {} as never;
      },
      stop: async () => null,
      runs: async () => state.runs,
      run: async (id: string) => state.runs.find((run) => run.id === id) ?? null,
      samples: async () => null,
    },
    optimizer: {
      recommend: async (request: OptimizerRequest) => {
        state.requests.push(request);
        return state.recommendations;
      },
    },
    processes: { list: async () => [] },
    settings: {
      get: async () => ({}) as never,
      update: async () => ({}) as never,
    },
  };
}

/** The GPU used by the suites. */
export const GPU_UUID = 'GPU-test-0001';
export const OTHER_GPU_UUID = 'GPU-test-0002';

/** A device with the driver limits the suites rely on. */
export function createDevice(overrides: Partial<GpuDevice> = {}): GpuDevice {
  return {
    uuid: GPU_UUID,
    index: 0,
    name: 'NVIDIA GeForce RTX 5060 Ti',
    pciBusId: '0000:01:00.0',
    driverVersion: '595.84',
    vbiosVersion: '1.0',
    cudaVersion: '13.2',
    memory: { totalMiB: 8192, usedMiB: 1024, freeMiB: 7168 },
    utilizationGpuPercent: 40,
    utilizationMemoryPercent: 20,
    temperatureC: 45,
    power: {
      drawW: 120,
      limitW: 285,
      defaultLimitW: 285,
      minLimitW: 150,
      maxLimitW: 180,
      enforcedLimitW: 285,
    },
    clocks: { smMHz: 1800, memMHz: 1401, maxSmMHz: 2610, maxMemMHz: 1401 },
    fanSpeedPercent: 45,
    throttling: { active: false, reasons: [], raw: null },
    capabilities: {
      powerLimitAdjustable: true,
      fanControl: true,
      clockControl: true,
      persistenceMode: true,
    },
    computeMode: 'Default',
    persistenceMode: 'Enabled',
    present: true,
    lastSeenAt: Date.now(),
    ...overrides,
  };
}

/** Options of a benchmark run used by the suites. */
export interface RunOptions {
  id: string;
  name: string;
  adapterId?: string | null;
  workload?: BenchmarkResult['config']['workload'];
  uuids?: string[];
  watts?: number;
  status?: BenchmarkResult['status'];
  joules?: number;
  measuredMs?: number | null;
  coveragePct?: number | null;
  limitVerified?: boolean | null;
  observedLimitW?: number | null;
  throughput?: { unit: 'token' | 'image'; count: number } | null;
  avgTemperatureC?: number | null;
  maxTemperatureC?: number | null;
}

/** A benchmark run with the evidence the renderer relies on. */
export function createRun(options: RunOptions): BenchmarkResult {
  const uuids = options.uuids ?? [GPU_UUID];
  const joules = options.joules ?? 0;
  const measuredMs = options.measuredMs === undefined ? 30_000 : options.measuredMs;
  const coveragePct = options.coveragePct === undefined ? 100 : options.coveragePct;
  const watts = options.watts ?? 200;
  const observed = options.observedLimitW === undefined ? watts : options.observedLimitW;

  const perGpu = {
    [uuids[0]]: {
      joules,
      wattHours: joules / 3600,
      avgPowerW: joules > 0 ? 120 : 0,
      peakPowerW: 180,
      measuredMs,
      coveragePct,
      avgTemperatureC: options.avgTemperatureC === undefined ? 42.3 : options.avgTemperatureC,
      maxTemperatureC: options.maxTemperatureC === undefined ? 52 : options.maxTemperatureC,
    },
  };

  return {
    id: options.id,
    config: {
      name: options.name,
      workload: options.workload ?? 'llm-inference',
      adapterId: options.adapterId === undefined ? 'ollama' : options.adapterId,
      uuids,
      wattsPerGpu: { [uuids[0]]: watts },
      durationLimitSeconds: null,
    },
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_030_000,
    status: options.status ?? 'completed',
    durationSeconds: 30,
    energy: {
      joulesTotal: joules,
      wattHoursTotal: joules / 3600,
      perGpu,
      measuredMs,
      coveragePct,
      sampleIntervalMs: 1000,
      avgTemperatureC:
        options.avgTemperatureC === undefined ? 42.3 : options.avgTemperatureC,
      maxTemperatureC: options.maxTemperatureC === undefined ? 52 : options.maxTemperatureC,
    },
    throughput:
      options.throughput === undefined
        ? { unit: 'token', count: 300, label: 'tokens', source: 'ollama' }
        : options.throughput === null
          ? null
          : {
              unit: options.throughput.unit,
              count: options.throughput.count,
              label: options.throughput.unit === 'token' ? 'tokens' : 'imagens',
              source: 'ollama',
            },
    samples: [],
    measuredMs,
    coveragePct,
    limitVerified: options.limitVerified === undefined ? true : options.limitVerified,
    observedLimitsW: { [uuids[0]]: observed },
  };
}
