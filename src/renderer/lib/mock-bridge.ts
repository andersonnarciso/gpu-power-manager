/**
 * Simulation bridge.
 *
 * A complete, in-process implementation of `GpuPmApi` that behaves like the
 * real backend: it refuses invalid values, verifies what it changed and
 * measures real numbers from the simulated telemetry.
 *
 * The mock is only used when the renderer runs outside Electron (plain
 * browser preview). It is always clearly labelled in the UI.
 */

import type { GpuPmApi, PowerLimitBounds } from '@shared/contracts';
import {
  ErrorCode,
  type AppError,
  type AppInfo,
  type AppSettings,
  type BenchmarkMeasurement,
  type BenchmarkResult,
  type BenchmarkRunConfig,
  type EnergySummary,
  type GpuDevice,
  type GpuProcess,
  type OperationResult,
  type OptimizerRecommendation,
  type OptimizerRequest,
  type PersistenceStatus,
  type PowerLimitChangeResult,
  type PowerLimitRequest,
  type PowerProfile,
  type ProfileEntry,
  type ProfileKind,
  type ProfileStrategy,
  type TelemetrySample,
  type ThroughputResult,
  type ThroughputUnit,
  type WorkloadAdapterInfo,
  type WorkloadKind,
} from '@shared/types';
import {
  SIMULATED_GPUS,
  SimulatedPowerState,
  createRng,
  simulateGpuSnapshot,
} from '@shared/simulation';
import { energyFromMeasurements } from '@shared/energy';
import type {
  BenchmarkResultWithEvidence,
  EnergySummaryWithEvidence,
} from '@renderer/lib/benchmark-metrics';
import { getLocale, translate, type TranslationKey } from './i18n';

/* ------------------------------------------------------------------ helpers */

const SETTINGS_STORAGE_KEY = 'gpu-power-manager.settings.v1';

const DEFAULT_SETTINGS: AppSettings = {
  locale: 'pt-BR',
  theme: 'dark',
  telemetryEnabled: true,
  telemetryIntervalMs: 1000,
  historyWindowMinutes: 5,
  historyRetentionMinutes: 60,
  simulateMode: true,
  autoApplyProfileOnBoot: false,
  reduceMotion: false,
};

function appError(code: string, message: string, detail?: string): AppError {
  const error: AppError = { code, message };
  if (detail !== undefined) error.detail = detail;
  return error;
}

function clampToRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface MockAdapterDefinition extends WorkloadAdapterInfo {
  /** Tokens or images produced per second, when the adapter can measure it. */
  throughputRate?: number;
  throughputUnit?: ThroughputUnit;
  /** How long the simulated workload takes, seconds. */
  durationSeconds: number;
}

/* -------------------------------------------------------------- mock bridge */

export class MockBridge implements GpuPmApi {
  private readonly powerState = new SimulatedPowerState();
  private readonly rng = createRng(0x51ce55);
  private readonly telemetryListeners = new Set<(sample: TelemetrySample) => void>();
  private readonly telemetryErrorListeners = new Set<(error: AppError) => void>();
  private readonly profileStore = new Map<string, PowerProfile>();
  private readonly runs = new Map<string, BenchmarkResultWithEvidence>();
  private readonly runTimers = new Map<string, number>();
  /** Nominal sampling period of the simulated telemetry, milliseconds. */
  private readonly sampleIntervalMs = 1000;

  private telemetryTimer: number | null = null;
  private elapsedSeconds = 0;
  private lastSnapshot: TelemetrySample = { at: Date.now(), gpus: [] };
  private settingsState: AppSettings;
  private persistenceState: PersistenceStatus = {
    installed: false,
    enabled: false,
    unitPath: null,
    profileId: null,
    lastAppliedAt: null,
    lastError: null,
    polkitInstalled: false,
    helperInstalled: false,
  };

  constructor() {
    this.settingsState = this.readSettings();
  }

  /* ------------------------------------------------------------- app info */

  readonly app = {
    info: async (): Promise<AppInfo> => ({
      version: '1.0.0',
      electronVersion: 'N/A',
      platform: 'linux',
      simulated: true,
      driverAvailable: false,
      runningAsRoot: false,
      nvidiaSmiPath: null,
    }),
  };

  /* ------------------------------------------------------------------ gpu */

  readonly gpu = {
    list: async (): Promise<GpuDevice[]> => this.currentDevices(),
    snapshot: async (): Promise<TelemetrySample> => this.lastSnapshot,
    onTelemetry: (listener: (sample: TelemetrySample) => void): (() => void) => {
      this.telemetryListeners.add(listener);
      this.startTelemetry();
      return () => {
        this.telemetryListeners.delete(listener);
        if (this.telemetryListeners.size === 0) this.stopTelemetry();
      };
    },
    onTelemetryError: (listener: (error: AppError) => void): (() => void) => {
      this.telemetryErrorListeners.add(listener);
      return () => {
        this.telemetryErrorListeners.delete(listener);
      };
    },
  };

  /* ---------------------------------------------------------------- power */

  readonly power = {
    bounds: async (uuid: string): Promise<PowerLimitBounds> => {
      const def = SIMULATED_GPUS.find((gpu) => gpu.uuid === uuid);
      if (!def) {
        throw appError(
          ErrorCode.GpuNotFound,
          'GPU não encontrada.',
          `Nenhum dispositivo com o UUID ${uuid}.`,
        );
      }
      return {
        uuid,
        minWatts: def.minLimitW,
        maxWatts: def.maxLimitW,
        defaultWatts: def.defaultLimitW,
        currentWatts: this.powerState.getLimitW(uuid),
        adjustable: def.minLimitW !== def.maxLimitW,
      };
    },

    apply: async (uuid: string, watts: number): Promise<PowerLimitChangeResult> => {
      const def = SIMULATED_GPUS.find((gpu) => gpu.uuid === uuid);
      if (!def) {
        throw appError(
          ErrorCode.GpuNotFound,
          'GPU não encontrada.',
          `Nenhum dispositivo com o UUID ${uuid}.`,
        );
      }
      if (!Number.isInteger(watts)) {
        throw appError(
          ErrorCode.ValidationFailed,
          'O limite de potência deve ser um número inteiro em watts.',
          `Valor recebido: ${String(watts)}.`,
        );
      }
      if (watts < def.minLimitW || watts > def.maxLimitW) {
        throw appError(
          ErrorCode.ValidationFailed,
          'Limite de potência fora do intervalo permitido pelo driver.',
          `Intervalo permitido: ${def.minLimitW} W – ${def.maxLimitW} W.`,
        );
      }
      const accepted = this.powerState.setLimitW(uuid, watts);
      if (!accepted) {
        throw appError(
          ErrorCode.CommandFailed,
          'O driver recusou o novo limite de potência.',
          `Intervalo permitido: ${def.minLimitW} W – ${def.maxLimitW} W.`,
        );
      }
      return {
        uuid,
        requestedWatts: watts,
        appliedWatts: this.powerState.getLimitW(uuid),
        ok: true,
        verification: {
          confirmed: true,
          observedLimitW: this.powerState.getLimitW(uuid),
          observedAt: Date.now(),
        },
      };
    },

    applyMany: async (requests: PowerLimitRequest[]): Promise<PowerLimitChangeResult[]> => {
      const results: PowerLimitChangeResult[] = [];
      for (const request of requests) {
        try {
          results.push(await this.power.apply(request.uuid, request.watts));
        } catch (error) {
          const normalised = error as AppError;
          results.push({
            uuid: request.uuid,
            requestedWatts: request.watts,
            appliedWatts: null,
            ok: false,
            error: normalised,
          });
        }
      }
      return results;
    },

    reset: async (uuid: string): Promise<PowerLimitChangeResult> => {
      const def = SIMULATED_GPUS.find((gpu) => gpu.uuid === uuid);
      if (!def) {
        throw appError(ErrorCode.GpuNotFound, 'GPU não encontrada.', `UUID ${uuid}.`);
      }
      this.powerState.reset(uuid);
      return {
        uuid,
        requestedWatts: def.defaultLimitW,
        appliedWatts: this.powerState.getLimitW(uuid),
        ok: true,
        verification: {
          confirmed: true,
          observedLimitW: this.powerState.getLimitW(uuid),
          observedAt: Date.now(),
        },
      };
    },

    resetMany: async (uuids: string[]): Promise<PowerLimitChangeResult[]> => {
      const results: PowerLimitChangeResult[] = [];
      for (const uuid of uuids) {
        results.push(await this.power.reset(uuid));
      }
      return results;
    },
  };

  /* -------------------------------------------------------------- profiles */

  readonly profiles = {
    list: async (): Promise<PowerProfile[]> => this.listProfiles(),
    save: async (profile: PowerProfile): Promise<PowerProfile> => {
      if (!profile.id || !profile.name.trim()) {
        throw appError(ErrorCode.ProfileInvalid, 'O perfil precisa de um identificador e de um nome.');
      }
      const existing = this.profileStore.get(profile.id);
      const now = Date.now();
      const saved: PowerProfile = {
        ...profile,
        builtin: existing?.builtin ?? profile.builtin,
        createdAt: existing?.createdAt ?? profile.createdAt ?? now,
        updatedAt: now,
      };
      this.profileStore.set(saved.id, saved);
      return saved;
    },
    remove: async (id: string): Promise<OperationResult> => {
      const existing = this.profileStore.get(id);
      if (!existing) {
        return {
          ok: false,
          error: appError(ErrorCode.ProfileNotFound, 'Perfil não encontrado.', `Id ${id}.`),
        };
      }
      if (existing.builtin) {
        return {
          ok: false,
          error: appError(
            ErrorCode.ProfileInvalid,
            'Os perfis predefinidos não podem ser eliminados.',
            `Id ${id}.`,
          ),
        };
      }
      this.profileStore.delete(id);
      return { ok: true };
    },
    activate: async (id: string): Promise<PowerLimitChangeResult[]> => {
      const profile = this.profileStore.get(id);
      if (!profile) {
        throw appError(ErrorCode.ProfileNotFound, 'Perfil não encontrado.', `Id ${id}.`);
      }
      const requests: PowerLimitRequest[] = [];
      for (const entry of profile.entries) {
        const def = SIMULATED_GPUS.find((gpu) => gpu.uuid === entry.uuid);
        if (!def) continue;
        const watts = this.resolveEntry(entry, def.minLimitW, def.maxLimitW, def.defaultLimitW);
        if (watts === null) continue;
        requests.push({ uuid: entry.uuid, watts });
      }
      if (requests.length === 0) {
        throw appError(
          ErrorCode.ProfileInvalid,
          'O perfil não define limites para nenhuma GPU desta máquina.',
        );
      }
      return this.power.applyMany(requests);
    },
    resetDefaults: async (): Promise<PowerLimitChangeResult[]> => {
      this.powerState.resetAll();
      const results: PowerLimitChangeResult[] = [];
      for (const def of SIMULATED_GPUS) {
        results.push({
          uuid: def.uuid,
          requestedWatts: def.defaultLimitW,
          appliedWatts: this.powerState.getLimitW(def.uuid),
          ok: true,
          verification: {
            confirmed: true,
            observedLimitW: this.powerState.getLimitW(def.uuid),
            observedAt: Date.now(),
          },
        });
      }
      return results;
    },
  };

  /* ------------------------------------------------------------ persistence */

  readonly persistence = {
    status: async (): Promise<PersistenceStatus> => ({ ...this.persistenceState }),
    install: async (profileId: string): Promise<OperationResult> => {
      this.persistenceState = {
        ...this.persistenceState,
        installed: true,
        enabled: true,
        polkitInstalled: true,
        helperInstalled: true,
        unitPath: '/etc/systemd/system/gpu-power-manager.service',
        profileId,
        lastAppliedAt: Date.now(),
        lastError: null,
      };
      return { ok: true };
    },
    uninstall: async (): Promise<OperationResult> => {
      this.persistenceState = {
        installed: false,
        enabled: false,
        polkitInstalled: false,
        helperInstalled: false,
        unitPath: null,
        profileId: null,
        lastAppliedAt: null,
        lastError: null,
      };
      return { ok: true };
    },
    setEnabled: async (enabled: boolean): Promise<OperationResult> => {
      if (!this.persistenceState.installed) {
        return {
          ok: false,
          error: appError(
            ErrorCode.PersistenceFailed,
            'O serviço privilegiado ainda não está instalado.',
          ),
        };
      }
      this.persistenceState = { ...this.persistenceState, enabled };
      return { ok: true };
    },
    applyNow: async (): Promise<OperationResult> => {
      if (!this.persistenceState.installed) {
        return {
          ok: false,
          error: appError(
            ErrorCode.PersistenceFailed,
            'O serviço privilegiado ainda não está instalado.',
          ),
        };
      }
      if (!this.persistenceState.profileId) {
        return {
          ok: false,
          error: appError(ErrorCode.ProfileInvalid, 'Nenhum perfil foi selecionado.'),
        };
      }
      this.persistenceState = { ...this.persistenceState, lastAppliedAt: Date.now(), lastError: null };
      return { ok: true };
    },
  };

  /* -------------------------------------------------------------- benchmark */

  readonly benchmark = {
    adapters: async (): Promise<WorkloadAdapterInfo[]> =>
      this.adapterDefinitions().map(({ throughputRate, throughputUnit, durationSeconds, ...info }) => info),

    start: async (config: BenchmarkRunConfig): Promise<BenchmarkResult> => {
      const id = `run-${Date.now().toString(36)}-${Math.floor(this.rng() * 4096).toString(36)}`;
      const adapter = this.adapterDefinitions().find((item) => item.id === config.adapterId);

      if (config.adapterId && (!adapter || !adapter.available)) {
        throw appError(
          ErrorCode.AdapterUnavailable,
          'O adaptador de carga selecionado não está disponível nesta máquina.',
          config.adapterId,
        );
      }

      // The target power is only a LABEL for the run: like the real engine,
      // the simulation does not apply the limit behind the user's back. The
      // limit really in effect is recorded, so the renderer can tell whether
      // the label was true.
      const observedLimits: Record<string, number | null> = {};
      for (const uuid of config.uuids) {
        observedLimits[uuid] = this.powerState.getLimitW(uuid);
      }

      const run: BenchmarkResultWithEvidence = {
        id,
        config,
        startedAt: Date.now(),
        endedAt: null,
        status: 'running',
        durationSeconds: null,
        energy: null,
        throughput: null,
        samples: [],
        observedLimitsW: observedLimits,
        limitVerified: null,
      };
      this.runs.set(id, run);

      // A run with an adapter ends when the adapter is done. A manual run
      // has no workload to finish, so it is only interrupted by its duration
      // limit, exactly like the real engine does.
      const duration = adapter
        ? config.durationLimitSeconds
          ? Math.min(config.durationLimitSeconds, adapter.durationSeconds)
          : adapter.durationSeconds
        : config.durationLimitSeconds;
      if (duration !== null) {
        const timer = window.setTimeout(() => {
          this.finishRun(id, adapter ? 'completed' : 'aborted');
        }, duration * 1000);
        this.runTimers.set(id, timer);
      }

      return run;
    },

    stop: async (runId: string): Promise<BenchmarkResult | null> => {
      const run = this.runs.get(runId);
      if (!run) return null;
      if (run.status !== 'running') return run;
      this.finishRun(runId, run.samples.length >= 2 ? 'aborted' : 'failed');
      return this.runs.get(runId) ?? null;
    },

    runs: async (): Promise<BenchmarkResult[]> =>
      [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt),

    run: async (id: string): Promise<BenchmarkResult | null> => this.runs.get(id) ?? null,

    samples: async (runId: string): Promise<EnergySummary | null> => {
      const run = this.runs.get(runId);
      if (!run) return null;
      return this.integrate(
        run.samples,
        run.config.uuids,
        Math.max(0, Date.now() - run.startedAt),
      );
    },
  };

  /* -------------------------------------------------------------- optimizer */

  readonly optimizer = {
    recommend: async (request: OptimizerRequest): Promise<OptimizerRecommendation[]> => {
      const completed = [...this.runs.values()]
        .filter(
          (run) =>
            run.status === 'completed' &&
            run.energy !== null &&
            run.config.uuids.includes(request.uuid),
        )
        .sort((a, b) => a.startedAt - b.startedAt);

      const baseline = completed.find((run) => run.id === request.baselineRunId);
      if (!baseline) return [];

      const baselineEnergy = baseline.energy?.perGpu[request.uuid]?.joules ?? null;
      const baselineWatts = baseline.config.wattsPerGpu[request.uuid] ?? null;
      const baselineRate = throughputRate(baseline);

      interface Evaluation {
        watts: number;
        joules: number | null;
        energyMeasured: boolean;
        performanceDeltaPct: number | null;
        energyDeltaPct: number | null;
        meetsConstraint: boolean;
        reason: string;
      }

      const evaluations: Evaluation[] = [];
      for (const watts of request.candidateWatts) {
        // Only the runs measured at this exact limit, by the SAME adapter,
        // are comparable with the reference. The reference itself is a
        // candidate too, exactly like in the real service.
        const candidate = completed.find(
          (run) =>
            run.config.wattsPerGpu[request.uuid] === watts &&
            run.config.workload === baseline.config.workload &&
            run.config.adapterId === baseline.config.adapterId,
        );
        if (!candidate) continue; // Only measured candidates are reported.

        const candidateEnergy = candidate.energy?.perGpu[request.uuid]?.joules ?? null;
        const candidateRate = throughputRate(candidate);

        // Zero joules is not a measurement: it is the absence of one.
        const energyMeasured = candidateEnergy !== null && candidateEnergy > 0;
        const energyDelta =
          baselineEnergy && candidateEnergy !== null
            ? ((candidateEnergy - baselineEnergy) / baselineEnergy) * 100
            : null;
        const performanceDelta =
          baselineRate !== null && candidateRate !== null
            ? ((candidateRate - baselineRate) / baselineRate) * 100
            : null;

        const meets =
          performanceDelta === null
            ? false
            : performanceDelta >= -request.maxPerformanceLossPct;

        let reason: string;
        if (performanceDelta === null) {
          reason = translate(getLocale(), 'opt.reasonNoThroughput');
        } else if (meets) {
          reason = translate(getLocale(), 'opt.reasonMeets', {
            energy: energyDelta === null ? '—' : `${Math.abs(energyDelta ?? 0).toFixed(1)}%`,
          });
        } else {
          reason = translate(getLocale(), 'opt.reasonFails', {
            performance: `${Math.abs(performanceDelta).toFixed(1)}%`,
            max: `${request.maxPerformanceLossPct}%`,
          });
        }

        evaluations.push({
          watts,
          joules: candidateEnergy,
          energyMeasured,
          performanceDeltaPct: performanceDelta,
          energyDeltaPct: energyDelta,
          meetsConstraint: meets,
          reason,
        });
      }

      // The recommendation comes FIRST, exactly like the real service: the
      // renderer shows the first element and never picks a candidate on its
      // own.
      const acceptable = evaluations
        .filter((evaluation) => evaluation.meetsConstraint && evaluation.energyMeasured)
        .sort((a, b) => (a.joules ?? Infinity) - (b.joules ?? Infinity));
      const recommended = acceptable[0] ?? null;
      const others = evaluations
        .filter((evaluation) => evaluation !== recommended)
        .sort((a, b) => {
          if (a.meetsConstraint !== b.meetsConstraint) return a.meetsConstraint ? -1 : 1;
          return (a.joules ?? Infinity) - (b.joules ?? Infinity);
        });

      const toRecommendation = (evaluation: Evaluation): OptimizerRecommendation => ({
        uuid: request.uuid,
        watts: evaluation.watts,
        baselineWatts,
        performanceDeltaPct: evaluation.performanceDeltaPct,
        energyDeltaPct: evaluation.energyDeltaPct,
        meetsConstraint: evaluation.meetsConstraint,
        reason: evaluation.reason,
      });

      return [
        ...(recommended ? [toRecommendation(recommended)] : []),
        ...others.map(toRecommendation),
      ];
    },
  };

  /* -------------------------------------------------------------- processes */

  readonly processes = {
    list: async (): Promise<GpuProcess[]> => this.mockProcesses(),
  };

  /* --------------------------------------------------------------- settings */

  readonly settings = {
    get: async (): Promise<AppSettings> => ({ ...this.settingsState }),
    update: async (patch: Partial<AppSettings>): Promise<AppSettings> => {
      this.settingsState = { ...this.settingsState, ...patch };
      this.writeSettings(this.settingsState);
      if (patch.telemetryEnabled === false) this.stopTelemetry();
      if (patch.telemetryEnabled === true && this.telemetryListeners.size > 0) {
        this.startTelemetry();
      }
      return { ...this.settingsState };
    },
  };

  /* ----------------------------------------------------------- internals */

  private currentDevices(): GpuDevice[] {
    if (this.lastSnapshot.gpus.length > 0) return this.lastSnapshot.gpus;
    return simulateGpuSnapshot({
      at: Date.now(),
      elapsedSeconds: 0,
      rng: this.rng,
      state: this.powerState,
    });
  }

  private startTelemetry(): void {
    if (this.telemetryTimer !== null) return;
    if (!this.settingsState.telemetryEnabled) return;
    const interval = Math.max(200, this.settingsState.telemetryIntervalMs);
    this.telemetryTimer = window.setInterval(() => {
      this.tick();
    }, interval);
  }

  private stopTelemetry(): void {
    if (this.telemetryTimer === null) return;
    window.clearInterval(this.telemetryTimer);
    this.telemetryTimer = null;
  }

  private tick(): void {
    this.elapsedSeconds += 1;
    const at = Date.now();
    let gpus: GpuDevice[];
    try {
      gpus = simulateGpuSnapshot({
        at,
        elapsedSeconds: this.elapsedSeconds,
        rng: this.rng,
        state: this.powerState,
      });
    } catch (error) {
      const normalised = error as AppError;
      this.telemetryErrorListeners.forEach((listener) => listener(normalised));
      return;
    }
    const sample: TelemetrySample = { at, gpus };
    this.lastSnapshot = sample;
    this.telemetryListeners.forEach((listener) => listener(sample));
    this.recordBenchmarkSample(sample);
  }

  /* -------------------------------------------------------------- profiles */

  private listProfiles(): PowerProfile[] {
    const locale = getLocale();
    const now = Date.now();
    const builtins: PowerProfile[] = [
      {
        id: 'builtin-original',
        name: translate(locale, 'profiles.nameOriginal'),
        kind: 'original',
        description: translate(locale, 'profiles.descOriginal'),
        builtin: true,
        entries: this.entriesFor('default'),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'builtin-economy',
        name: translate(locale, 'profiles.nameEconomy'),
        kind: 'economy',
        description: translate(locale, 'profiles.descEconomy'),
        builtin: true,
        entries: this.entriesFor('min'),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'builtin-balanced',
        name: translate(locale, 'profiles.nameBalanced'),
        kind: 'balanced',
        description: translate(locale, 'profiles.descBalanced'),
        builtin: true,
        entries: this.entriesFor('ratio', 0.7),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'builtin-performance',
        name: translate(locale, 'profiles.namePerformance'),
        kind: 'performance',
        description: translate(locale, 'profiles.descPerformance'),
        builtin: true,
        entries: this.entriesFor('ratio', 0.9),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'builtin-custom',
        name: translate(locale, 'profiles.nameCustom'),
        kind: 'custom',
        description: translate(locale, 'profiles.descCustom'),
        builtin: true,
        entries: this.entriesFor('fixed', undefined, (def) =>
          Math.round(clampToRange(def.defaultLimitW * 0.8, def.minLimitW, def.maxLimitW)),
        ),
        createdAt: now,
        updatedAt: now,
      },
    ];

    // Built-in profiles are regenerated on every read so their name and
    // description always follow the active locale. User edits are preserved.
    for (const builtin of builtins) {
      const edited = this.profileStore.get(builtin.id);
      if (edited) {
        this.profileStore.set(builtin.id, {
          ...builtin,
          name: edited.name,
          description: edited.description,
          entries: edited.entries,
          updatedAt: edited.updatedAt,
        });
      } else {
        this.profileStore.set(builtin.id, builtin);
      }
    }

    return [...this.profileStore.values()].sort((a, b) => {
      if (a.builtin && b.builtin) {
        const order: ProfileKind[] = ['original', 'economy', 'balanced', 'performance', 'custom'];
        return order.indexOf(a.kind) - order.indexOf(b.kind);
      }
      if (a.builtin) return -1;
      if (b.builtin) return 1;
      return b.updatedAt - a.updatedAt;
    });
  }

  private entriesFor(
    strategy: ProfileStrategy,
    ratio?: number,
    watts?: (def: (typeof SIMULATED_GPUS)[number]) => number,
  ): ProfileEntry[] {
    return SIMULATED_GPUS.map((def) => {
      const entry: ProfileEntry = { uuid: def.uuid, watts: null, strategy };
      if (ratio !== undefined) entry.ratio = ratio;
      if (watts) entry.watts = watts(def);
      return entry;
    });
  }

  private resolveEntry(
    entry: ProfileEntry,
    minWatts: number,
    maxWatts: number,
    defaultWatts: number,
  ): number | null {
    const strategy: ProfileStrategy =
      entry.strategy ?? (entry.watts !== null && entry.watts !== undefined ? 'fixed' : 'default');
    switch (strategy) {
      case 'default':
        return defaultWatts;
      case 'min':
        return minWatts;
      case 'ratio': {
        const ratio = entry.ratio ?? 0.7;
        const raw = minWatts + (maxWatts - minWatts) * ratio;
        return Math.round(clampToRange(raw, minWatts, maxWatts));
      }
      case 'fixed':
        if (entry.watts === null || entry.watts === undefined) return defaultWatts;
        return Math.round(clampToRange(entry.watts, minWatts, maxWatts));
      default:
        return defaultWatts;
    }
  }

  /* -------------------------------------------------------------- benchmark */

  private adapterDefinitions(): MockAdapterDefinition[] {
    const locale = getLocale();
    const name = (key: TranslationKey): string => translate(locale, key);
    return [
      {
        id: 'ollama',
        name: name('bench.adapterOllama'),
        workload: 'llm-inference',
        endpoint: 'http://127.0.0.1:11434',
        available: true,
        detectionHint: translate(locale, 'bench.hintOllama', {
          endpoint: 'http://127.0.0.1:11434',
        }),
        throughputRate: 38.4,
        throughputUnit: 'token',
        durationSeconds: 14,
      },
      {
        id: 'llama-server',
        name: name('bench.adapterLlama'),
        workload: 'llm-inference',
        endpoint: 'http://127.0.0.1:8080',
        available: true,
        detectionHint: translate(locale, 'bench.hintLlama', {
          endpoint: 'http://127.0.0.1:8080',
        }),
        throughputRate: 52.1,
        throughputUnit: 'token',
        durationSeconds: 14,
      },
      {
        id: 'comfyui',
        name: name('bench.adapterComfyui'),
        workload: 'image-generation',
        endpoint: 'http://127.0.0.1:8188',
        available: true,
        detectionHint: translate(locale, 'bench.hintComfyui', {
          endpoint: 'http://127.0.0.1:8188',
        }),
        throughputRate: 0.42,
        throughputUnit: 'image',
        durationSeconds: 18,
      },
      {
        id: 'cuda-synthetic',
        name: name('bench.adapterCuda'),
        workload: 'cuda-synthetic',
        endpoint: null,
        available: true,
        detectionHint: name('bench.hintCuda'),
        durationSeconds: 10,
      },
      {
        id: 'stable-diffusion-webui',
        name: name('bench.adapterWebui'),
        workload: 'image-generation',
        endpoint: 'http://127.0.0.1:7860',
        available: false,
        detectionHint: translate(locale, 'bench.hintWebui', {
          endpoint: 'http://127.0.0.1:7860',
        }),
        durationSeconds: 18,
      },
    ];
  }

  private recordBenchmarkSample(sample: TelemetrySample): void {
    for (const run of this.runs.values()) {
      if (run.status !== 'running') continue;
      const powerW: Record<string, number> = {};
      const temperatureC: Record<string, number> = {};
      for (const uuid of run.config.uuids) {
        const device = sample.gpus.find((gpu) => gpu.uuid === uuid);
        const draw = device?.power.drawW;
        if (typeof draw === 'number') powerW[uuid] = draw;
        const temperature = device?.temperatureC;
        if (typeof temperature === 'number') temperatureC[uuid] = temperature;
      }
      const measurement: BenchmarkMeasurement = { at: sample.at, powerW, temperatureC };
      run.samples.push(measurement);
    }
  }

  /**
   * Integrates the samples of a run with the shared energy module, so the
   * simulation publishes the very same evidence as the real engine: the
   * measured window, the temperatures and the coverage of the run.
   */
  private integrate(
    samples: BenchmarkMeasurement[],
    uuids: string[],
    durationMs: number,
  ): EnergySummaryWithEvidence {
    const scoped = samples.map((sample) => {
      const powerW: Record<string, number> = {};
      const temperatureC: Record<string, number> = {};
      for (const uuid of uuids) {
        const watts = sample.powerW[uuid];
        if (typeof watts === 'number') powerW[uuid] = watts;
        const celsius = sample.temperatureC?.[uuid];
        if (typeof celsius === 'number') temperatureC[uuid] = celsius;
      }
      return { at: sample.at, powerW, temperatureC };
    });

    const summary = energyFromMeasurements(scoped, {
      uuids,
      expectedIntervalMs: this.sampleIntervalMs,
      durationMs,
    });
    return { ...summary };
  }

  private finishRun(runId: string, status: 'completed' | 'aborted' | 'failed'): void {
    const run = this.runs.get(runId);
    if (!run) return;

    const timer = this.runTimers.get(runId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.runTimers.delete(runId);
    }

    const endedAt = Date.now();
    run.endedAt = endedAt;
    run.durationSeconds = Math.max(0, (endedAt - run.startedAt) / 1000);
    const energy = this.integrate(run.samples, run.config.uuids, Math.max(0, endedAt - run.startedAt));
    // The coverage is the share of the run window that was really measured.
    const windowMs = Math.max(1, endedAt - run.startedAt);
    const measuredMs = energy.measuredMs ?? 0;
    energy.coveragePct = Math.min(100, Math.round((measuredMs / windowMs) * 100));
    run.energy = energy;
    run.status = status;

    const adapter = this.adapterDefinitions().find((item) => item.id === run.config.adapterId);
    if (adapter && adapter.available && adapter.throughputRate && adapter.throughputUnit) {
      const throughput = this.buildThroughput(adapter, run.durationSeconds);
      run.throughput = throughput;
    }

    // The limit really in effect is compared with the label of the run: the
    // renderer shows whether the label was true.
    const observed = run.observedLimitsW ?? {};
    let verified = run.config.uuids.length > 0;
    for (const uuid of run.config.uuids) {
      const target = run.config.wattsPerGpu[uuid];
      const limit = observed[uuid] ?? null;
      if (typeof target !== 'number' || limit === null || limit !== target) verified = false;
    }
    run.limitVerified = verified;
  }

  private buildThroughput(adapter: MockAdapterDefinition, durationSeconds: number): ThroughputResult {
    const locale = getLocale();
    const unit = adapter.throughputUnit ?? 'unknown';
    const count = Math.round((adapter.throughputRate ?? 0) * durationSeconds);
    const labels: Record<ThroughputUnit, TranslationKey> = {
      token: 'bench.unitToken',
      image: 'bench.unitImage',
      'video-second': 'bench.unitVideoSecond',
      unknown: 'bench.unitUnknown',
    };
    return {
      unit,
      count,
      label: translate(locale, labels[unit]),
      source: adapter.endpoint ?? adapter.name,
    };
  }

  /* -------------------------------------------------------------- processes */

  private mockProcesses(): GpuProcess[] {
    const base: GpuProcess[] = [
      {
        pid: 128455,
        name: 'llama-server',
        gpuUuid: SIMULATED_GPUS[0].uuid,
        usedMemoryMiB: 8421,
        type: 'compute',
        friendlyApp: 'llama.cpp',
      },
      {
        pid: 204118,
        name: 'python',
        gpuUuid: SIMULATED_GPUS[1].uuid,
        usedMemoryMiB: 6142,
        type: 'compute',
        friendlyApp: 'ComfyUI',
      },
      {
        pid: 91204,
        name: 'ollama',
        gpuUuid: SIMULATED_GPUS[0].uuid,
        usedMemoryMiB: 3318,
        type: 'compute',
        friendlyApp: 'Ollama',
      },
      {
        pid: 77310,
        name: 'Xorg',
        gpuUuid: SIMULATED_GPUS[1].uuid,
        usedMemoryMiB: 184,
        type: 'graphics',
        friendlyApp: null,
      },
    ];
    return base.map((process) => ({
      ...process,
      usedMemoryMiB:
        process.usedMemoryMiB === null
          ? null
          : Math.max(64, Math.round(process.usedMemoryMiB + (this.rng() - 0.5) * 96)),
    }));
  }

  /* --------------------------------------------------------------- settings */

  private readSettings(): AppSettings {
    try {
      const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private writeSettings(settings: AppSettings): void {
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* Storage unavailable (private mode): settings stay in memory only. */
    }
  }
}

/** Throughput rate of a completed run, in units per second. */
function throughputRate(run: BenchmarkResult): number | null {
  if (!run.throughput || !run.durationSeconds || run.durationSeconds <= 0) return null;
  return run.throughput.count / run.durationSeconds;
}

/** Workload kinds the UI can offer. */
export const MOCK_WORKLOADS: readonly WorkloadKind[] = [
  'llm-inference',
  'image-generation',
  'video-generation',
  'cuda-synthetic',
  'manual',
];
