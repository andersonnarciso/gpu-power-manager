/**
 * Telemetry store.
 *
 * Holds the latest reading of every GPU plus a bounded ring buffer with the
 * recorded history. The buffer never grows past one hour of one-second
 * samples, so the renderer memory stays flat.
 */

import { create } from 'zustand';
import type { AppError, GpuDevice, TelemetrySample } from '@shared/types';

export type HistoryWindowMinutes = 1 | 5 | 15 | 60;

export const HISTORY_WINDOWS: readonly HistoryWindowMinutes[] = [1, 5, 15, 60];

/** One hour of one-second samples. */
export const MAX_HISTORY_FRAMES = 3600;

export interface TelemetryPoint {
  at: number;
  powerW: number | null;
  temperatureC: number | null;
  utilizationPct: number;
  vramMiB: number;
  smMHz: number | null;
}

export interface HistoryFrame {
  at: number;
  byUuid: Record<string, TelemetryPoint>;
}

export interface TelemetryState {
  devices: GpuDevice[];
  history: HistoryFrame[];
  windowMinutes: HistoryWindowMinutes;
  connected: boolean;
  lastUpdateAt: number | null;
  error: AppError | null;
  setSnapshot: (sample: TelemetrySample) => void;
  setWindow: (minutes: HistoryWindowMinutes) => void;
  setConnected: (connected: boolean) => void;
  setError: (error: AppError | null) => void;
  clear: () => void;
}

function toFrame(sample: TelemetrySample): HistoryFrame {
  const byUuid: Record<string, TelemetryPoint> = {};
  for (const device of sample.gpus) {
    byUuid[device.uuid] = {
      at: sample.at,
      powerW: device.power.drawW,
      temperatureC: device.temperatureC,
      utilizationPct: device.utilizationGpuPercent,
      vramMiB: device.memory.usedMiB,
      smMHz: device.clocks.smMHz,
    };
  }
  return { at: sample.at, byUuid };
}

export const useTelemetryStore = create<TelemetryState>((set) => ({
  devices: [],
  history: [],
  windowMinutes: 5,
  connected: false,
  lastUpdateAt: null,
  error: null,

  setSnapshot: (sample) =>
    set((state) => {
      const history = [...state.history, toFrame(sample)];
      if (history.length > MAX_HISTORY_FRAMES) {
        history.splice(0, history.length - MAX_HISTORY_FRAMES);
      }
      return {
        devices: sample.gpus,
        history,
        lastUpdateAt: sample.at,
        error: null,
      };
    }),

  setWindow: (minutes) => set({ windowMinutes: minutes }),

  setConnected: (connected) => set({ connected }),

  setError: (error) => set({ error }),

  clear: () => set({ devices: [], history: [], lastUpdateAt: null, error: null }),
}));

/** Frames recorded inside the selected window. */
export function framesInWindow(
  frames: HistoryFrame[],
  minutes: number,
  now: number = Date.now(),
): HistoryFrame[] {
  const cutoff = now - minutes * 60_000;
  if (frames.length === 0) return [];
  const firstRelevant = frames.findIndex((frame) => frame.at >= cutoff);
  if (firstRelevant === -1) return [frames[frames.length - 1]];
  return frames.slice(firstRelevant);
}

/** Device lookup by UUID. */
export function findDevice(devices: GpuDevice[], uuid: string): GpuDevice | undefined {
  return devices.find((device) => device.uuid === uuid);
}
