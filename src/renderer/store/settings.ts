/**
 * Settings store.
 *
 * The backend owns the persisted settings; the store keeps the local copy
 * used by the UI and applies the visual consequences (theme, locale, reduced
 * motion) immediately.
 */

import { create } from 'zustand';
import type { AppSettings, Locale, ThemeMode } from '@shared/types';
import { getBridge } from '@renderer/lib/bridge';
import { setLocale } from '@renderer/lib/i18n';

export const FALLBACK_SETTINGS: AppSettings = {
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

let currentTheme: ThemeMode = FALLBACK_SETTINGS.theme;

const darkMedia =
  typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function paintTheme(): void {
  if (typeof document === 'undefined') return;
  const prefersDark = darkMedia?.matches ?? true;
  const isDark = currentTheme === 'dark' || (currentTheme === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', isDark);
}

if (darkMedia) {
  darkMedia.addEventListener('change', paintTheme);
}

/** Apply the theme to the document root. */
export function applyTheme(mode: ThemeMode): void {
  currentTheme = mode;
  paintTheme();
}

/** Apply the reduced-motion hook to the document root. */
export function applyReduceMotion(enabled: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('reduce-motion', enabled);
}

/** Apply the locale to the document root and to the i18n module. */
export function applyLocale(locale: Locale): void {
  setLocale(locale);
}

export interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  load: () => Promise<AppSettings>;
  update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: FALLBACK_SETTINGS,
  loaded: false,

  load: async () => {
    try {
      const settings = await getBridge().settings.get();
      applyTheme(settings.theme);
      applyLocale(settings.locale);
      applyReduceMotion(settings.reduceMotion);
      set({ settings, loaded: true });
      return settings;
    } catch {
      const settings = get().settings;
      applyTheme(settings.theme);
      applyLocale(settings.locale);
      applyReduceMotion(settings.reduceMotion);
      set({ loaded: true });
      return settings;
    }
  },

  update: async (patch) => {
    let settings: AppSettings;
    try {
      settings = await getBridge().settings.update(patch);
    } catch {
      settings = { ...get().settings, ...patch };
    }
    if (patch.theme) applyTheme(settings.theme);
    if (patch.locale) applyLocale(settings.locale);
    if (patch.reduceMotion !== undefined) applyReduceMotion(settings.reduceMotion);
    set({ settings });
    return settings;
  },
}));
