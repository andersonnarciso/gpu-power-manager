/**
 * IPC handlers.
 *
 * This is the **only** bridge between the untrusted renderer and the services.
 * Every payload is validated here before it is handed over, and every thrown
 * error is converted into a structured `AppError` so the renderer never sees a
 * stack trace.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { IPC, INVOKE_CHANNELS } from '../../shared/ipc';
import type { AppContext } from '../app-context';
import type { AppError, PowerLimitRequest, PowerProfile } from '../../shared/types';
import { ErrorCode } from '../../shared/types';
import {
  assertArray,
  assertBoolean,
  assertGpuUuid,
  assertNonEmptyString,
  assertNumberRange,
  assertOneOf,
  assertPlainObject,
  assertWatts,
  toAppError,
  ValidationError,
} from '../../shared/validation';
import { validateBenchmarkConfig } from '../benchmark/benchmark-service';
import { validateOptimizerRequest } from '../optimizer/optimizer-service';
import { validateProfile } from '../profiles/profile-store';
import { applyNativeTheme } from '../theme';

/** Turns any thrown value into a payload the renderer can display. */
function fail(error: unknown): { error: AppError } {
  if (error instanceof ValidationError) {
    return { error: error.toAppError() };
  }
  return { error: toAppError(error) };
}

/**
 * Wraps a handler so that a rejection never escapes as an unhandled error and
 * always reaches the renderer as `{ error }`.
 *
 * The channel is checked against the allow-list, so a typo can never register
 * an arbitrary channel name.
 */
function handle<T>(channel: string, fn: (payload: unknown) => Promise<T>): void {
  if (!INVOKE_CHANNELS.includes(channel)) {
    throw new Error(`Canal IPC não permitido: "${channel}".`);
  }
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    try {
      return await fn(payload);
    } catch (error) {
      return fail(error);
    }
  });
}

/** Validates the settings patch: only known fields, each with its own rule. */
function validateSettingsPatch(patch: unknown): Record<string, unknown> {
  const raw = assertPlainObject(patch, 'settings');
  const allowed = new Set([
    'locale',
    'theme',
    'telemetryEnabled',
    'telemetryIntervalMs',
    'historyWindowMinutes',
    'historyRetentionMinutes',
    'simulateMode',
    'autoApplyProfileOnBoot',
    'reduceMotion',
  ]);
  const clean: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) {
      throw new ValidationError(key, `Preferência desconhecida: "${key}".`);
    }
    clean[key] = value;
  }

  if (clean.locale !== undefined) {
    clean.locale = assertOneOf(clean.locale, ['pt-BR', 'en'], 'locale');
  }
  if (clean.theme !== undefined) {
    clean.theme = assertOneOf(clean.theme, ['dark', 'light', 'system'], 'theme');
  }
  if (clean.telemetryEnabled !== undefined) {
    clean.telemetryEnabled = assertBoolean(clean.telemetryEnabled, 'telemetryEnabled');
  }
  if (clean.telemetryIntervalMs !== undefined) {
    clean.telemetryIntervalMs = assertNumberRange(
      clean.telemetryIntervalMs,
      'telemetryIntervalMs',
      250,
      10_000,
    );
  }
  if (clean.historyWindowMinutes !== undefined) {
    const window = assertNumberRange(clean.historyWindowMinutes, 'historyWindowMinutes', 1, 60);
    if (![1, 5, 15, 60].includes(window)) {
      throw new ValidationError('historyWindowMinutes', 'Janela deve ser 1, 5, 15 ou 60 minutos.');
    }
    clean.historyWindowMinutes = window;
  }
  if (clean.historyRetentionMinutes !== undefined) {
    clean.historyRetentionMinutes = assertNumberRange(
      clean.historyRetentionMinutes,
      'historyRetentionMinutes',
      1,
      1440,
    );
  }
  if (clean.simulateMode !== undefined) {
    clean.simulateMode = assertBoolean(clean.simulateMode, 'simulateMode');
  }
  if (clean.autoApplyProfileOnBoot !== undefined) {
    clean.autoApplyProfileOnBoot = assertBoolean(
      clean.autoApplyProfileOnBoot,
      'autoApplyProfileOnBoot',
    );
  }
  if (clean.reduceMotion !== undefined) {
    clean.reduceMotion = assertBoolean(clean.reduceMotion, 'reduceMotion');
  }

  return clean;
}

export interface RegisterHandlersOptions {
  context: AppContext;
  /** Window that receives the telemetry pushes. */
  window: BrowserWindow;
}

export function registerIpcHandlers(options: RegisterHandlersOptions): () => void {
  const { context, window } = options;

  /* ------------------------------------------------------------------ app */

  handle(IPC.appInfo, async () => context.info());

  /* -------------------------------------------------------------- telemetry */

  handle(IPC.gpuList, async () => context.telemetry.list());

  handle(IPC.telemetrySnapshot, async () => context.telemetry.snapshot());

  /* ------------------------------------------------------------------ power */

  handle(IPC.powerLimits, async (payload) => {
    const uuid = assertGpuUuid(payload);
    return context.power.bounds(uuid);
  });

  handle(IPC.powerApply, async (payload) => {
    const raw = assertPlainObject(payload, 'request');
    const uuid = assertGpuUuid(raw.uuid, 'uuid');
    const watts = assertWatts(raw.watts, 'watts');
    const result = await context.power.apply({ uuid, watts });
    // A change invalidates the cached device readings.
    await context.telemetry.pollOnce();
    return result;
  });

  handle(IPC.powerApplyMany, async (payload) => {
    const list = assertArray(payload, 'requests', 64);
    const requests: PowerLimitRequest[] = list.map((entry, index) => {
      const raw = assertPlainObject(entry, `requests[${index}]`);
      return {
        uuid: assertGpuUuid(raw.uuid, `requests[${index}].uuid`),
        watts: assertWatts(raw.watts, `requests[${index}].watts`),
      };
    });
    const results = await context.power.applyMany(requests);
    await context.telemetry.pollOnce();
    return results;
  });

  handle(IPC.powerReset, async (payload) => {
    const uuid = assertGpuUuid(payload);
    const result = await context.power.resetToDefault(uuid);
    await context.telemetry.pollOnce();
    return result;
  });

  handle(IPC.powerResetMany, async (payload) => {
    const list = assertArray(payload, 'uuids', 64);
    const uuids = list.map((entry, index) => assertGpuUuid(entry, `uuids[${index}]`));
    const results = await context.power.resetMany(uuids);
    await context.telemetry.pollOnce();
    return results;
  });

  /* --------------------------------------------------------------- profiles */

  handle(IPC.profilesList, async () => context.profiles.list());

  handle(IPC.profilesSave, async (payload) => {
    const profile = validateProfile(payload);
    if (!profile) {
      throw new ValidationError('profile', 'Perfil inválido.');
    }
    return context.profiles.save(profile as PowerProfile);
  });

  handle(IPC.profilesDelete, async (payload) => {
    const id = assertNonEmptyString(payload, 'id', 128);
    return context.profiles.remove(id);
  });

  handle(IPC.profilesActivate, async (payload) => {
    const id = assertNonEmptyString(payload, 'id', 128);
    const results = await context.profiles.activate(id);
    await context.telemetry.pollOnce();
    return results;
  });

  handle(IPC.profilesReset, async () => {
    const results = await context.profiles.resetDefaults();
    await context.telemetry.pollOnce();
    return results;
  });

  /* ------------------------------------------------------------ persistence */

  handle(IPC.persistenceStatus, async () => context.persistence.status());

  handle(IPC.persistenceInstall, async (payload) => {
    const raw = assertPlainObject(payload, 'payload');
    const profileId = assertNonEmptyString(raw.profileId, 'profileId', 128);
    return context.persistence.install(profileId);
  });

  handle(IPC.persistenceUninstall, async () => context.persistence.uninstall());

  handle(IPC.persistenceToggle, async (payload) => {
    const raw = assertPlainObject(payload, 'payload');
    const enabled = assertBoolean(raw.enabled, 'enabled');
    return context.persistence.setEnabled(enabled);
  });

  handle(IPC.persistenceApplyNow, async () => context.persistence.applyNow());

  /* -------------------------------------------------------------- benchmark */

  handle(IPC.benchmarkAdapters, async () => context.benchmark.adapters());

  handle(IPC.benchmarkStart, async (payload) => {
    const config = validateBenchmarkConfig(payload);
    return context.benchmark.start(config);
  });

  handle(IPC.benchmarkStop, async (payload) => {
    const runId = assertNonEmptyString(payload, 'runId', 128);
    return context.benchmark.stop(runId);
  });

  handle(IPC.benchmarkRuns, async () => context.benchmark.runs());

  handle(IPC.benchmarkRun, async (payload) => {
    const runId = assertNonEmptyString(payload, 'runId', 128);
    return context.benchmark.run(runId);
  });

  /* -------------------------------------------------------------- optimizer */

  handle(IPC.optimizerRecommend, async (payload) => {
    const request = validateOptimizerRequest(payload);
    return context.optimizer.recommend(request);
  });

  /* -------------------------------------------------------------- processes */

  handle(IPC.processesList, async () => context.processes.list());

  /* --------------------------------------------------------------- settings */

  handle(IPC.settingsGet, async () => context.settings.get());

  handle(IPC.settingsUpdate, async (payload) => {
    const patch = validateSettingsPatch(payload);
    const updated = context.settings.update(patch as Partial<typeof context.settings.get>);

    // Some preferences change how the main process behaves.
    context.applyTelemetryInterval();
    if (patch.simulateMode !== undefined) {
      await context.setSimulated(updated.simulateMode);
    }
    // The native window chrome follows the application theme.
    applyNativeTheme(updated.theme, window);

    return updated;
  });

  /* ------------------------------------------------------- push telemetry */

  const unsubscribeTelemetry = context.telemetry.subscribe((sample) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.telemetryPush, sample);
    }
  });

  const unsubscribeError = context.telemetry.onError((error) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.telemetryError, error);
    }
  });

  return () => {
    unsubscribeTelemetry();
    unsubscribeError();
    for (const channel of Object.values(IPC)) {
      ipcMain.removeHandler(channel);
    }
  };
}

/** Error code used when a channel is unknown to the main process. */
export const UNKNOWN_CHANNEL = ErrorCode.Unknown;
