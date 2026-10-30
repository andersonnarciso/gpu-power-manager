import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_SETTINGS,
  SettingsServiceImpl,
  validateSettingField,
} from '../../src/main/settings/settings-service';

let workspace: string;
let filePath: string;

beforeEach(async () => {
  workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gpupm-settings-'));
  filePath = path.join(workspace, 'settings.json');
});

afterEach(async () => {
  await fs.promises.rm(workspace, { recursive: true, force: true });
});

function createService(): SettingsServiceImpl {
  return new SettingsServiceImpl({ filePath });
}

describe('SettingsServiceImpl', () => {
  it('uses the defaults when the file does not exist', () => {
    const service = createService();
    expect(service.get()).toEqual(DEFAULT_SETTINGS);
    expect(service.warning()).toBeNull();
  });

  it('persists an update atomically and reloads it', () => {
    const service = createService();
    const updated = service.update({ theme: 'dark', telemetryIntervalMs: 2000 });

    expect(updated.theme).toBe('dark');
    expect(updated.telemetryIntervalMs).toBe(2000);

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).settings.theme).toBe('dark');

    const reloaded = createService();
    expect(reloaded.get().theme).toBe('dark');
    expect(reloaded.get().telemetryIntervalMs).toBe(2000);
  });

  it('leaves no temporary file behind', () => {
    const service = createService();
    service.update({ theme: 'light' });

    const leftovers = fs.readdirSync(workspace).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('falls back to the defaults and records a warning for a corrupt file', () => {
    fs.writeFileSync(filePath, '{ not json', 'utf8');

    const service = createService();

    expect(service.get()).toEqual(DEFAULT_SETTINGS);
    expect(service.warning()).not.toBeNull();
    expect(service.warning()?.message).toContain('corrompido');
  });

  it('falls back to the defaults and records a warning for an invalid value', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, settings: { theme: 'neon', locale: 'pt-BR' } }),
      'utf8',
    );

    const service = createService();

    expect(service.get().theme).toBe(DEFAULT_SETTINGS.theme);
    expect(service.warning()).not.toBeNull();
  });

  it('rejects an invalid locale', () => {
    const service = createService();
    expect(() => service.update({ locale: 'fr-FR' as never })).toThrow(/locale/i);
    expect(service.get().locale).toBe(DEFAULT_SETTINGS.locale);
  });

  it('rejects an invalid theme', () => {
    const service = createService();
    expect(() => service.update({ theme: 'neon' as never })).toThrow(/theme/i);
    expect(service.get().theme).toBe(DEFAULT_SETTINGS.theme);
  });

  it('accepts the supported locales and themes', () => {
    const service = createService();
    expect(service.update({ locale: 'en' }).locale).toBe('en');
    expect(service.update({ theme: 'system' }).theme).toBe('system');
    expect(service.update({ theme: 'light' }).theme).toBe('light');
  });

  it('accepts the telemetry interval boundaries', () => {
    const service = createService();
    expect(service.update({ telemetryIntervalMs: 250 }).telemetryIntervalMs).toBe(250);
    expect(service.update({ telemetryIntervalMs: 10000 }).telemetryIntervalMs).toBe(10000);
  });

  it('rejects a telemetry interval out of the boundaries', () => {
    const service = createService();
    expect(() => service.update({ telemetryIntervalMs: 249 })).toThrow(/telemetryIntervalMs/);
    expect(() => service.update({ telemetryIntervalMs: 10001 })).toThrow(/telemetryIntervalMs/);
    expect(() => service.update({ telemetryIntervalMs: 1000.5 })).toThrow(/telemetryIntervalMs/);
    expect(service.get().telemetryIntervalMs).toBe(DEFAULT_SETTINGS.telemetryIntervalMs);
  });

  it('accepts the supported history windows', () => {
    const service = createService();
    for (const window of [1, 5, 15, 60] as const) {
      expect(service.update({ historyWindowMinutes: window }).historyWindowMinutes).toBe(window);
    }
  });

  it('rejects an unsupported history window', () => {
    const service = createService();
    expect(() => service.update({ historyWindowMinutes: 10 as never })).toThrow(
      /janela de histórico/i,
    );
    expect(service.get().historyWindowMinutes).toBe(DEFAULT_SETTINGS.historyWindowMinutes);
  });

  it('accepts the history retention boundaries', () => {
    const service = createService();
    expect(service.update({ historyRetentionMinutes: 1 }).historyRetentionMinutes).toBe(1);
    expect(service.update({ historyRetentionMinutes: 1440 }).historyRetentionMinutes).toBe(1440);
  });

  it('rejects a history retention out of the boundaries', () => {
    const service = createService();
    expect(() => service.update({ historyRetentionMinutes: 0 })).toThrow(/historyRetentionMinutes/);
    expect(() => service.update({ historyRetentionMinutes: 1441 })).toThrow(/historyRetentionMinutes/);
  });

  it('rejects a non boolean flag', () => {
    const service = createService();
    expect(() => service.update({ simulateMode: 'yes' as never })).toThrow(/simulateMode/);
    expect(() => service.update({ reduceMotion: 1 as never })).toThrow(/reduceMotion/);
    expect(() => service.update({ autoApplyProfileOnBoot: null as never })).toThrow(
      /autoApplyProfileOnBoot/,
    );
    expect(() => service.update({ telemetryEnabled: 'no' as never })).toThrow(/telemetryEnabled/);
  });

  it('stores the boolean flags', () => {
    const service = createService();
    const updated = service.update({
      simulateMode: true,
      reduceMotion: true,
      autoApplyProfileOnBoot: true,
      telemetryEnabled: false,
    });

    expect(updated.simulateMode).toBe(true);
    expect(updated.reduceMotion).toBe(true);
    expect(updated.autoApplyProfileOnBoot).toBe(true);
    expect(updated.telemetryEnabled).toBe(false);
  });

  it('does not change the stored settings when an update is rejected', () => {
    const service = createService();
    service.update({ theme: 'dark' });

    expect(() => service.update({ theme: 'neon' as never })).toThrow();

    expect(createService().get().theme).toBe('dark');
  });

  it('ignores unknown keys but keeps the known ones', () => {
    const service = createService();
    const updated = service.update({ theme: 'dark', somethingElse: 42 } as never);
    expect(updated.theme).toBe('dark');
  });
});

describe('validateSettingField', () => {
  it('validates every field of the settings', () => {
    expect(validateSettingField('locale', 'pt-BR')).toBe('pt-BR');
    expect(validateSettingField('theme', 'dark')).toBe('dark');
    expect(validateSettingField('telemetryIntervalMs', 250)).toBe(250);
    expect(validateSettingField('historyWindowMinutes', 5)).toBe(5);
    expect(validateSettingField('historyRetentionMinutes', 60)).toBe(60);
    expect(validateSettingField('simulateMode', true)).toBe(true);
    expect(() => validateSettingField('locale', 'xx')).toThrow();
    expect(() => validateSettingField('theme', 'xx')).toThrow();
    expect(() => validateSettingField('historyWindowMinutes', 7)).toThrow();
  });
});
