/**
 * Benchmark store.
 *
 * Keeps the workload adapters, the run history and the live samples of the
 * run currently in progress.
 */

import { create } from 'zustand';
import type {
  BenchmarkResult,
  BenchmarkRunConfig,
  EnergySummary,
  WorkloadAdapterInfo,
} from '@shared/types';
import { getBridge } from '@renderer/lib/bridge';

export interface BenchmarkState {
  adapters: WorkloadAdapterInfo[];
  runs: BenchmarkResult[];
  runningId: string | null;
  liveRun: BenchmarkResult | null;
  live: EnergySummary | null;
  loading: boolean;
  loadAdapters: () => Promise<void>;
  loadRuns: () => Promise<void>;
  start: (config: BenchmarkRunConfig) => Promise<BenchmarkResult>;
  stop: (runId: string) => Promise<void>;
  refreshLive: () => Promise<void>;
}

export const useBenchmarkStore = create<BenchmarkState>((set, get) => ({
  adapters: [],
  runs: [],
  runningId: null,
  liveRun: null,
  live: null,
  loading: false,

  loadAdapters: async () => {
    set({ loading: true });
    try {
      const adapters = await getBridge().benchmark.adapters();
      set({ adapters, loading: false });
    } finally {
      set({ loading: false });
    }
  },

  loadRuns: async () => {
    const runs = await getBridge().benchmark.runs();
    set({ runs });
  },

  start: async (config) => {
    const run = await getBridge().benchmark.start(config);
    set({ runningId: run.id, liveRun: run, live: null });
    await get().loadRuns();
    return run;
  },

  stop: async (runId) => {
    await getBridge().benchmark.stop(runId);
    set({ runningId: null });
    await get().loadRuns();
  },

  refreshLive: async () => {
    const { runningId } = get();
    if (!runningId) return;
    const bridge = getBridge();
    const [run, samples] = await Promise.all([
      bridge.benchmark.run(runningId),
      bridge.benchmark.samples(runningId),
    ]);
    set({ liveRun: run, live: samples });
    if (run && run.status !== 'running') {
      set({ runningId: null });
      await get().loadRuns();
    }
  },
}));
