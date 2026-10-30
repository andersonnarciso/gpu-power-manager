import { nativeTheme, type BrowserWindow } from 'electron';
import type { ThemeMode } from '../shared/types';

/** Window background used before the first paint, per theme. */
const DARK_WINDOW_BG = '#0a0b0d';
const LIGHT_WINDOW_BG = '#f7f8fa';

/**
 * Keeps the native window chrome in sync with the application theme.
 *
 * Without this the Linux title bar keeps the dark frame while the app is in
 * the light theme, which reads as a broken window. `nativeTheme.themeSource`
 * also makes the window controls follow the system theme.
 */
export function applyNativeTheme(theme: ThemeMode, window?: BrowserWindow | null): void {
  nativeTheme.themeSource = theme;
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  window?.setBackgroundColor(dark ? DARK_WINDOW_BG : LIGHT_WINDOW_BG);
}
