/**
 * Benchmark module entry point.
 *
 * Exposes the factory used by the main process and the adapter registry.
 * Nothing here touches Electron directly: the user data path is injected by
 * the caller.
 */

import { createFileBenchmarkStore, type BenchmarkRunStore } from './benchmark-store';
import { BenchmarkServiceImpl, type BenchmarkServiceOptions } from './benchmark-service';
import {
  resolveAdapterEndpoints,
  type AdapterEndpointsResolver,
} from '../settings/settings-endpoints';
import type { PowerReader } from './power-sampler';
import type { WorkloadAdapter } from './adapters/types';
import { ComfyUiAdapter, type ComfyUiAdapterOptions } from './adapters/comfyui-adapter';
import { CudaSyntheticAdapter, type CudaSyntheticAdapterOptions } from './adapters/cuda-synthetic-adapter';
import { LlamaCppAdapter, type LlamaCppAdapterOptions } from './adapters/llama-cpp-adapter';
import { ManualAdapter } from './adapters/manual-adapter';
import { OllamaAdapter, type OllamaAdapterOptions } from './adapters/ollama-adapter';
import { UnslothAdapter, type UnslothAdapterOptions } from './adapters/unsloth-adapter';
import {
  VideoGenerationAdapter,
  type VideoGenerationAdapterOptions,
} from './adapters/video-generation-adapter';

export { BenchmarkServiceImpl, validateBenchmarkConfig } from './benchmark-service';
export type { BenchmarkServiceOptions } from './benchmark-service';
export {
  createFileBenchmarkStore,
  createInMemoryBenchmarkStore,
} from './benchmark-store';
export type { BenchmarkRunStore, FileBenchmarkStoreOptions } from './benchmark-store';
export {
  PowerSampler,
  powerReaderFromDevices,
  powerReaderFromTelemetry,
} from './power-sampler';
export type { PowerReader, PowerReading, PowerSamplerOptions } from './power-sampler';
export {
  BENCHMARK_SAMPLE_INTERVAL_MS,
  createDriverPowerReader,
  driverPowerQueryArgs,
  parseDriverPowerCsv,
} from './driver-reader';
export type { DriverPowerReaderOptions } from './driver-reader';
export { AdapterError, toAdapterInfo } from './adapters/types';
export type {
  AdapterDetection,
  AdapterThroughputResult,
  WorkloadAdapter,
  WorkloadRunContext,
} from './adapters/types';
export { ManualAdapter } from './adapters/manual-adapter';
export { OllamaAdapter, DEFAULT_OLLAMA_URL } from './adapters/ollama-adapter';
export type { OllamaAdapterOptions } from './adapters/ollama-adapter';
export { LlamaCppAdapter, DEFAULT_LLAMA_CPP_URL } from './adapters/llama-cpp-adapter';
export type { LlamaCppAdapterOptions } from './adapters/llama-cpp-adapter';
export { ComfyUiAdapter } from './adapters/comfyui-adapter';
export type { ComfyUiAdapterOptions } from './adapters/comfyui-adapter';
export { VideoGenerationAdapter } from './adapters/video-generation-adapter';
export type { VideoGenerationAdapterOptions } from './adapters/video-generation-adapter';
export { CudaSyntheticAdapter } from './adapters/cuda-synthetic-adapter';
export type { CudaSyntheticAdapterOptions } from './adapters/cuda-synthetic-adapter';
export { UnslothAdapter, parseUnslothOutput } from './adapters/unsloth-adapter';
export type { UnslothAdapterOptions } from './adapters/unsloth-adapter';
export { ComfyUiClient, DEFAULT_COMFYUI_URL } from './adapters/comfyui-client';
export type { ComfyUiClientOptions } from './adapters/comfyui-client';

export interface BenchmarkAdapterFactoryOptions {
  ollama?: OllamaAdapterOptions;
  llamaCpp?: LlamaCppAdapterOptions;
  comfyui?: ComfyUiAdapterOptions;
  comfyuiVideo?: VideoGenerationAdapterOptions;
  cudaSynthetic?: CudaSyntheticAdapterOptions;
  unsloth?: UnslothAdapterOptions;
  /**
   * Endpoints currently configured by the user.
   *
   * They are INJECTED into the adapters: an adapter never reads a global, it
   * receives the URL it must talk to. Defaults to the endpoints of the
   * settings service.
   */
  endpoints?: AdapterEndpointsResolver;
}

/** Builds the adapter registry with the default configuration. */
export function createDefaultAdapters(options: BenchmarkAdapterFactoryOptions = {}): WorkloadAdapter[] {
  const endpoints = options.endpoints ?? resolveAdapterEndpoints;
  return [
    new ManualAdapter(),
    new OllamaAdapter({ endpoints, ...(options.ollama ?? {}) }),
    new LlamaCppAdapter({ endpoints, ...(options.llamaCpp ?? {}) }),
    new ComfyUiAdapter({ endpoints, ...(options.comfyui ?? {}) }),
    new VideoGenerationAdapter({ endpoints, ...(options.comfyuiVideo ?? {}) }),
    new CudaSyntheticAdapter(options.cudaSynthetic ?? {}),
    new UnslothAdapter({ endpoints, ...(options.unsloth ?? {}) }),
  ];
}

export interface CreateBenchmarkServiceOptions
  extends Omit<BenchmarkServiceOptions, 'store' | 'adapters'> {
  /** Directory where the runs are persisted (usually `app.getPath('userData')`). */
  userDataPath?: string;
  /** Adapter registry. Defaults to the standard one. */
  adapters?: WorkloadAdapter[];
  /** Custom store. Overrides `userDataPath`. */
  store?: BenchmarkRunStore;
}

/** Creates the benchmark service used by the IPC layer. */
export function createBenchmarkService(
  options: CreateBenchmarkServiceOptions,
): BenchmarkServiceImpl {
  const store =
    options.store ??
    (options.userDataPath
      ? createFileBenchmarkStore(options.userDataPath)
      : createFileBenchmarkStoreFallback());

  return new BenchmarkServiceImpl({
    powerReader: options.powerReader,
    adapters: options.adapters ?? createDefaultAdapters(),
    store,
    sampleIntervalMs: options.sampleIntervalMs,
    now: options.now,
    createId: options.createId,
    onStoreError: options.onStoreError,
  });
}

function createFileBenchmarkStoreFallback(): BenchmarkRunStore {
  // No user data path was provided (tests, headless usage): keep the runs in
  // memory instead of writing to an unexpected location.
  return {
    async load() {
      return [];
    },
    async save() {
      /* nothing to persist */
    },
  };
}
