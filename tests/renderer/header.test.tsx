/**
 * The header.
 *
 * The language toggle carries the "PT"/"EN" label inside a button. When it
 * used the square icon size, the label overflowed the fixed 32px box and was
 * painted outside the button, close to the edge of the window.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Imported first: the polyfills must be in place before the stores are
// evaluated (the theme store reads `matchMedia` when it is loaded).
import './helpers/dom';

import { Header } from '@renderer/components/layout/Header';
import { useSettingsStore, FALLBACK_SETTINGS } from '@renderer/store/settings';
import { useAppStore } from '@renderer/store/app';
import { useTelemetryStore } from '@renderer/store/telemetry';
import { useUiStore } from '@renderer/store/ui';
import { t } from '@renderer/lib/i18n';

describe('Header', () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: { ...FALLBACK_SETTINGS, locale: 'pt-BR' } });
    useAppStore.setState({ info: null, simulated: false });
    useTelemetryStore.setState({ connected: true });
    useUiStore.setState({ section: 'dashboard', sidebarCollapsed: false, toasts: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the active language inside the toggle', () => {
    render(<Header />);
    const button = screen.getByLabelText(t('header.toggleLanguage'));
    expect(button.textContent).toContain('PT');
  });

  it('does not squeeze the label into a fixed square button', () => {
    render(<Header />);
    const button = screen.getByLabelText(t('header.toggleLanguage'));
    // A fixed width (`w-8`) is what made the label overflow the button.
    expect(button.className).not.toMatch(/\bw-8\b/);
    expect(button.className).toMatch(/\bpx-2\b/);
  });
});
