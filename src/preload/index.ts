/**
 * Preload bridge.
 *
 * The renderer runs sandboxed with context isolation, so this file is the only
 * thing it can reach. It exposes a **fixed, named** API — there is no generic
 * "invoke any channel" escape hatch, and `ipcRenderer` itself is never
 * handed to the renderer.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc';
import type { GpuPmApi } from '../shared/contracts';
import type {
  AppError,
  GpuDevice,
  GpuProcess,
  TelemetrySample,
} from '../shared/types';

/**
 * Subscribes to a push channel and returns a function that removes the
 * listener again.
 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => {
    listener(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: GpuPmApi = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
  },

  gpu: {
    list: (): Promise<GpuDevice[]> => ipcRenderer.invoke(IPC.gpuList),
    snapshot: (): Promise<TelemetrySample> => ipcRenderer.invoke(IPC.telemetrySnapshot),
    onTelemetry: (listener: (sample: TelemetrySample) => void) =>
      subscribe<TelemetrySample>(IPC.telemetryPush, listener),
    onTelemetryError: (listener: (error: AppError) => void) =>
      subscribe<AppError>(IPC.telemetryError, listener),
  },

  power: {
    bounds: (uuid: string) => ipcRenderer.invoke(IPC.powerLimits, uuid),
    apply: (uuid: string, watts: number) =>
      ipcRenderer.invoke(IPC.powerApply, { uuid, watts }),
    applyMany: (requests) => ipcRenderer.invoke(IPC.powerApplyMany, requests),
    reset: (uuid: string) => ipcRenderer.invoke(IPC.powerReset, uuid),
    resetMany: (uuids: string[]) => ipcRenderer.invoke(IPC.powerResetMany, uuids),
  },

  profiles: {
    list: () => ipcRenderer.invoke(IPC.profilesList),
    save: (profile) => ipcRenderer.invoke(IPC.profilesSave, profile),
    remove: (id: string) => ipcRenderer.invoke(IPC.profilesDelete, id),
    activate: (id: string) => ipcRenderer.invoke(IPC.profilesActivate, id),
    resetDefaults: () => ipcRenderer.invoke(IPC.profilesReset),
  },

  persistence: {
    status: () => ipcRenderer.invoke(IPC.persistenceStatus),
    install: (profileId: string) => ipcRenderer.invoke(IPC.persistenceInstall, { profileId }),
    uninstall: () => ipcRenderer.invoke(IPC.persistenceUninstall),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC.persistenceToggle, { enabled }),
    applyNow: () => ipcRenderer.invoke(IPC.persistenceApplyNow),
  },

  benchmark: {
    adapters: () => ipcRenderer.invoke(IPC.benchmarkAdapters),
    start: (config) => ipcRenderer.invoke(IPC.benchmarkStart, config),
    stop: (runId: string) => ipcRenderer.invoke(IPC.benchmarkStop, runId),
    runs: () => ipcRenderer.invoke(IPC.benchmarkRuns),
    run: (id: string) => ipcRenderer.invoke(IPC.benchmarkRun, id),
    // The contract exposes the live energy of a run, not the whole result.
    samples: async (runId: string) => {
      const result = await ipcRenderer.invoke(IPC.benchmarkRun, runId);
      return result?.energy ?? null;
    },
  },

  optimizer: {
    recommend: (request) => ipcRenderer.invoke(IPC.optimizerRecommend, request),
  },

  processes: {
    list: (): Promise<GpuProcess[]> => ipcRenderer.invoke(IPC.processesList),
  },

  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
  },

  clipboard: {
    /**
     * The IPC layer answers with `{ error }` instead of rejecting, so the
     * result is checked here: only `true` means the text reached the
     * clipboard.
     */
    writeText: async (text: string): Promise<boolean> => {
      const result = await ipcRenderer.invoke(IPC.clipboardWriteText, text);
      return result === true;
    },
  },
};

contextBridge.exposeInMainWorld('gpuPm', api);
