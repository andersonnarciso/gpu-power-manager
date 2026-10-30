/**
 * Settings service.
 *
 * Implements the `SettingsService` contract of `src/shared/contracts.ts`.
 *
 * The settings live in `<userData>/settings.json` and are written atomically
 * (temporary file + rename), so an interrupted write can never leave a
 * truncated file behind.
 *
 * Every field is validated twice: when the file is read (an invalid value
 * falls back to the default and a warning is recorded) and when the value is
 * updated (an invalid value is **rejected**, never silently coerced).
 *
 * The low level helpers (`atomic-json`, `user-data`) are shared with the
 * profile store; they live in `src/main/profiles` because that was the first
 * consumer. Moving them to a common folder is a trivial refactor.
 */

import * as fsSync from 'node:fs';
import {
  ErrorCode,
  type AppError,
  type AppSettings,
  type Locale,
  type ThemeMode,
} from '../../shared/types';
import type { SettingsService } from '../../shared/contracts';
import { ValidationError, assertArray, assertBoolean, assertIntRange, assertNoShellMetacharacters, assertOneOf } from '../../shared/validation';
import { writeJsonFileAtomicSync } from '../profiles/atomic-json';
import { SETTINGS_FILE_NAME, userDataFilePath } from '../profiles/user-data';
import {
  adapterEndpointsOf,
  registerAdapterEndpointsProvider,
} from './settings-endpoints';

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'pt-BR',
  theme: 'system',
  telemetryEnabled: true,
  telemetryIntervalMs: 1000,
  historyWindowMinutes: 5,
  historyRetentionMinutes: 60,
  simulateMode: false,
  hideHardwareIdentifiers: false,
  autoApplyProfileOnBoot: false,
  reduceMotion: false,
  // The endpoints of the workload adapters. The defaults are the ports the
  // adapters always used, so a user who configures nothing sees no change.
  ollamaUrl: 'http://127.0.0.1:11434',
  llamaCppUrl: 'http://127.0.0.1:8080',
  comfyUiUrl: 'http://127.0.0.1:8188',
  unslothCommand: '',
  unslothArgs: [],
};

export const SUPPORTED_LOCALES: readonly Locale[] = ['pt-BR', 'en'];
export const SUPPORTED_THEMES: readonly ThemeMode[] = ['dark', 'light', 'system'];
export const SUPPORTED_HISTORY_WINDOWS: readonly number[] = [1, 5, 15, 60];

export const TELEMETRY_INTERVAL_MIN_MS = 250;
export const TELEMETRY_INTERVAL_MAX_MS = 10000;
export const HISTORY_RETENTION_MIN_MINUTES = 1;
export const HISTORY_RETENTION_MAX_MINUTES = 1440;

export interface SettingsServiceOptions {
  /** Full path of `settings.json`. Defaults to `<userData>/settings.json`. */
  filePath?: string;
}

interface SettingsFile {
  version: number;
  settings: AppSettings;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates an endpoint of an adapter.
 *
 * The endpoint is used to build an HTTP request, so it must be an http(s) URL
 * with a host. Anything else is rejected instead of being coerced.
 */
export function validateEndpointUrl(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(
      field,
      `O endpoint "${field}" deve ser uma URL http:// ou https:// (ex.: http://127.0.0.1:8088).`,
    );
  }

  const text = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new ValidationError(
      field,
      `O endpoint "${field}" não é uma URL válida (ex.: http://127.0.0.1:8088).`,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(field, `O endpoint "${field}" deve usar http:// ou https://.`);
  }
  if (!parsed.hostname) {
    throw new ValidationError(field, `O endpoint "${field}" deve informar um host.`);
  }

  return text;
}

/**
 * Validates the command of the Unsloth adapter.
 *
 * The command is executed with `execFile` and an argv array, never with a
 * shell, but it must still be a plain executable name or path: a command with
 * shell metacharacters is always a mistake.
 */
export function validateUnslothCommand(field: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValidationError(field, 'O comando do Unsloth deve ser texto.');
  }

  const text = value.trim();
  if (text === '') return '';

  assertNoShellMetacharacters(text, field);
  if (!/^[A-Za-z0-9._\-~/]+$/.test(text)) {
    throw new ValidationError(
      field,
      'O comando do Unsloth deve ser um executável ou um caminho simples, sem espaços nem caracteres de shell.',
    );
  }

  return text;
}

/** Validates the arguments of the Unsloth command. */
export function validateUnslothArgs(field: string, value: unknown): string[] {
  const list = assertArray(value, field, 64);
  const args: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') {
      throw new ValidationError(field, 'Os argumentos do Unsloth devem ser texto.');
    }
    if (item.includes('\0')) {
      throw new ValidationError(field, 'Os argumentos do Unsloth não podem conter bytes nulos.');
    }
    args.push(item);
  }
  return args;
}

/** Validates a single field and returns the value to store. */
export function validateSettingField(
  field: keyof AppSettings,
  value: unknown,
): AppSettings[keyof AppSettings] {
  switch (field) {
    case 'locale':
      return assertOneOf(value, SUPPORTED_LOCALES, 'locale');
    case 'theme':
      return assertOneOf(value, SUPPORTED_THEMES, 'theme');
    case 'telemetryEnabled':
      return assertBoolean(value, 'telemetryEnabled');
    case 'telemetryIntervalMs':
      return assertIntRange(
        value,
        'telemetryIntervalMs',
        TELEMETRY_INTERVAL_MIN_MS,
        TELEMETRY_INTERVAL_MAX_MS,
      );
    case 'historyWindowMinutes': {
      const numeric =
        typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (
        typeof numeric !== 'number' ||
        !Number.isInteger(numeric) ||
        !SUPPORTED_HISTORY_WINDOWS.includes(numeric)
      ) {
        throw new ValidationError(
          'historyWindowMinutes',
          'A janela de histórico deve ser 1, 5, 15 ou 60 minutos.',
        );
      }
      return numeric as AppSettings['historyWindowMinutes'];
    }    case 'historyRetentionMinutes':
      return assertIntRange(
        value,
        'historyRetentionMinutes',
        HISTORY_RETENTION_MIN_MINUTES,
        HISTORY_RETENTION_MAX_MINUTES,
      );
    case 'simulateMode':
      return assertBoolean(value, 'simulateMode');
    case 'hideHardwareIdentifiers':
      return assertBoolean(value, 'hideHardwareIdentifiers');
    case 'autoApplyProfileOnBoot':
      return assertBoolean(value, 'autoApplyProfileOnBoot');
    case 'reduceMotion':
      return assertBoolean(value, 'reduceMotion');
    case 'ollamaUrl':
      return validateEndpointUrl('ollamaUrl', value) as AppSettings['ollamaUrl'];
    case 'llamaCppUrl':
      return validateEndpointUrl('llamaCppUrl', value) as AppSettings['llamaCppUrl'];
    case 'comfyUiUrl':
      return validateEndpointUrl('comfyUiUrl', value) as AppSettings['comfyUiUrl'];
    case 'unslothCommand':
      return validateUnslothCommand('unslothCommand', value) as AppSettings['unslothCommand'];
    case 'unslothArgs':
      return validateUnslothArgs('unslothArgs', value) as AppSettings['unslothArgs'];
    default: {
      const exhaustive: never = field;
      throw new ValidationError(String(exhaustive), 'Configuração desconhecida.');
    }
  }
}

/** Validates a whole settings object, field by field. */
export function validateSettings(raw: unknown): AppSettings {
  if (!isPlainObject(raw)) {
    throw new ValidationError('settings', 'As configurações devem ser um objeto.');
  }
  const result: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
    if (raw[key] === undefined) {
      continue;
    }
    result[key] = validateSettingField(key, raw[key]);
  }
  return result as unknown as AppSettings;
}

export class SettingsServiceImpl implements SettingsService {
  private readonly filePath: string;
  private current: AppSettings;
  private recordedWarning: AppError | null = null;

  constructor(options: SettingsServiceOptions = {}) {
    this.filePath = options.filePath ?? userDataFilePath(SETTINGS_FILE_NAME);
    this.current = this.load();
    // The settings are the source of truth of the endpoints of the adapters:
    // they are published so the benchmark module can inject them.
    registerAdapterEndpointsProvider(() => adapterEndpointsOf(this.current));
  }

  /** The last problem found while loading the file (corrupt file, ...). */
  warning(): AppError | null {
    return this.recordedWarning;
  }

  /** Absolute path of the settings file. */
  get path(): string {
    return this.filePath;
  }

  private load(): AppSettings {
    let raw: string;
    try {
      raw = fsSync.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') {
        return { ...DEFAULT_SETTINGS };
      }
      this.recordedWarning = {
        code: ErrorCode.Unknown,
        message: 'Não foi possível ler as configurações. Os valores padrão serão usados.',
        detail: error instanceof Error ? error.message : String(error),
      };
      return { ...DEFAULT_SETTINGS };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.recordedWarning = {
        code: ErrorCode.ValidationFailed,
        message: 'O arquivo de configurações estava corrompido. Os valores padrão serão usados.',
        detail: error instanceof Error ? error.message : String(error),
      };
      return { ...DEFAULT_SETTINGS };
    }

    const candidate = isPlainObject(parsed) && parsed.settings !== undefined ? parsed.settings : parsed;

    try {
      return validateSettings(candidate);
    } catch (error) {
      this.recordedWarning = {
        code: ErrorCode.ValidationFailed,
        message:
          'O arquivo de configurações continha valores inválidos. Os valores padrão serão usados.',
        detail: error instanceof Error ? error.message : String(error),
      };
      return { ...DEFAULT_SETTINGS };
    }
  }

  get(): AppSettings {
    return { ...this.current };
  }

  /**
   * Applies a partial update.
   *
   * Unknown keys are ignored, known keys are strictly validated: an invalid
   * value throws a `ValidationError` and nothing is written.
   */
  update(patch: Partial<AppSettings>): AppSettings {
    if (!isPlainObject(patch)) {
      throw new ValidationError('settings', 'As configurações devem ser um objeto.');
    }

    const next: Record<string, unknown> = { ...this.current };
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
      const value = (patch as unknown as Record<string, unknown>)[key];
      if (value === undefined) {
        continue;
      }
      next[key] = validateSettingField(key, value);
    }

    const settings = next as unknown as AppSettings;
    const payload: SettingsFile = { version: 1, settings };
    writeJsonFileAtomicSync(this.filePath, payload);
    this.current = settings;

    return { ...settings };
  }
}
