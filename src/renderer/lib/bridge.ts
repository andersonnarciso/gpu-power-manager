/**
 * Bridge resolution.
 *
 * Inside Electron the preload script exposes `window.gpuPm`, shaped exactly
 * like `GpuPmApi`. In a plain browser (the visual preview) there is no bridge,
 * so a fully functional simulation is used instead.
 *
 * The renderer never talks to Node, Electron or the driver directly.
 *
 * IMPORTANT: when the app runs inside Electron but the preload bridge is
 * missing (a broken or sandboxed preload), the mock is **never** used as a
 * silent fallback. The UI shows a dedicated error panel instead, because
 * simulated numbers must never be mistaken for real measurements.
 */

import type { GpuPmApi } from '@shared/contracts';
import { ErrorCode, type AppError, type AppInfo } from '@shared/types';
import { MockBridge } from './mock-bridge';

declare global {
  interface Window {
    gpuPm?: GpuPmApi;
    process?: { versions?: { electron?: string } };
  }
}

export type BridgeMode = 'electron' | 'mock';

export interface BridgeStatus {
  mode: BridgeMode;
  /** False when the real bridge could not be resolved. */
  available: boolean;
  /** Populated when the bridge is unavailable. */
  error: AppError | null;
}

let activeBridge: GpuPmApi | null = null;
let activeStatus: BridgeStatus = { mode: 'mock', available: true, error: null };

/**
 * Detect whether the renderer is running inside the Electron shell.
 *
 * Two independent signals are used: the Electron version injected on
 * `window.process` (absent in a sandboxed context) and the Electron user
 * agent, which is always present.
 */
export function isElectronRuntime(): boolean {
  if (typeof window === 'undefined') return false;

  const electronVersion = window.process?.versions?.electron;
  if (typeof electronVersion === 'string' && electronVersion.length > 0) return true;

  if (typeof navigator !== 'undefined' && /Electron\//i.test(navigator.userAgent)) return true;

  return false;
}

/**
 * Bridge that fails every call with a readable error.
 *
 * Used inside Electron when the preload bridge did not load. The renderer
 * stays alive and shows the error instead of pretending to have data.
 */
class UnavailableBridge implements GpuPmApi {
  private readonly reason: AppError;

  constructor(reason: AppError) {
    this.reason = reason;
  }

  private fail<T>(): Promise<T> {
    return Promise.reject(this.reason);
  }

  readonly app = {
    info: async (): Promise<AppInfo> => this.fail<AppInfo>(),
  };

  readonly gpu = {
    list: async () => this.fail<never[]>(),
    snapshot: async () => this.fail<never>(),
    onTelemetry: () => (): void => undefined,
    onTelemetryError: (listener: (error: AppError) => void) => {
      listener(this.reason);
      return (): void => undefined;
    },
  };

  readonly power = {
    bounds: async () => this.fail<never>(),
    apply: async () => this.fail<never>(),
    applyMany: async () => this.fail<never[]>(),
    reset: async () => this.fail<never>(),
    resetMany: async () => this.fail<never[]>(),
  };

  readonly profiles = {
    list: async () => this.fail<never[]>(),
    save: async () => this.fail<never>(),
    remove: async () => this.fail<never>(),
    activate: async () => this.fail<never[]>(),
    resetDefaults: async () => this.fail<never[]>(),
  };

  readonly persistence = {
    status: async () => this.fail<never>(),
    install: async () => this.fail<never>(),
    uninstall: async () => this.fail<never>(),
    setEnabled: async () => this.fail<never>(),
    applyNow: async () => this.fail<never>(),
  };

  readonly benchmark = {
    adapters: async () => this.fail<never[]>(),
    start: async () => this.fail<never>(),
    stop: async () => this.fail<never>(),
    runs: async () => this.fail<never[]>(),
    run: async () => this.fail<never>(),
    samples: async () => this.fail<never>(),
  };

  readonly optimizer = {
    recommend: async () => this.fail<never[]>(),
  };

  readonly processes = {
    list: async () => this.fail<never[]>(),
  };

  readonly settings = {
    get: async () => this.fail<never>(),
    update: async () => this.fail<never>(),
  };
}

/** Resolve the bridge to use for the whole session. */
export function getBridge(): GpuPmApi {
  if (activeBridge) return activeBridge;

  const injected = typeof window !== 'undefined' ? window.gpuPm : undefined;

  if (injected) {
    activeBridge = injected;
    activeStatus = { mode: 'electron', available: true, error: null };
    return activeBridge;
  }

  if (isElectronRuntime()) {
    // Inside Electron the real bridge is mandatory: never fake it.
    const error: AppError = {
      code: ErrorCode.DriverUnavailable,
      message:
        'A ponte privilegiada não foi carregada. O preload do Electron não expôs `window.gpuPm`, por isso a aplicação não consegue ler o hardware real.',
      detail:
        'Verifique o ficheiro de preload (src/preload) e as opções de contextIsolation / sandbox do BrowserWindow. Sem a ponte, a aplicação recusa mostrar dados simulados.',
    };
    activeBridge = new UnavailableBridge(error);
    activeStatus = { mode: 'electron', available: false, error };
    return activeBridge;
  }

  activeBridge = new MockBridge();
  activeStatus = { mode: 'mock', available: true, error: null };
  return activeBridge;
}

/** Current bridge state: mode, availability and the failure reason. */
export function getBridgeStatus(): BridgeStatus {
  getBridge();
  return activeStatus;
}

/** True when the app is running against the simulation instead of hardware. */
export function isMockBridge(): boolean {
  return getBridgeStatus().mode === 'mock';
}
