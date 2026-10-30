/**
 * Copying to the clipboard.
 *
 * The defect this suite guards against: inside Electron the copy button
 * always failed ("Não foi possível copiar"), because the web clipboard API is
 * refused there — and the legacy fallback returns `false` instead of
 * throwing, so a failed copy could be reported as a successful one.
 *
 * The rule of the product applies to the clipboard too: nothing is reported
 * as copied when it was not copied.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  writeText: vi.fn(async (_text: string): Promise<boolean> => true),
}));

vi.mock('@renderer/lib/bridge', () => ({
  getBridge: () => ({
    clipboard: {
      writeText: (text: string) => bridge.writeText(text),
    },
  }),
}));

import { writeToClipboard } from '@renderer/lib/clipboard';

/** Installs a web clipboard API on the window. */
function installWebClipboard(writeText: (text: string) => Promise<void>): ReturnType<typeof vi.fn> {
  const spy = vi.fn(writeText);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: spy },
  });
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: true,
  });
  return spy;
}

/** Removes the web clipboard API from the window. */
function removeWebClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: false,
  });
}

describe('clipboard', () => {
  beforeEach(() => {
    bridge.writeText.mockReset();
    bridge.writeText.mockResolvedValue(true);
    removeWebClipboard();
    // jsdom has no `execCommand`: the default answer is "the copy failed".
    document.execCommand = vi.fn(() => false);
  });

  it('copies through the Electron bridge without touching the web API', async () => {
    const web = installWebClipboard(async () => undefined);

    await expect(writeToClipboard('GPU-ff55d89d')).resolves.toBe(true);
    expect(bridge.writeText).toHaveBeenCalledWith('GPU-ff55d89d');
    expect(web).not.toHaveBeenCalled();
  });

  it('falls back to the web clipboard API when the bridge refuses', async () => {
    bridge.writeText.mockResolvedValue(false);
    const web = installWebClipboard(async () => undefined);

    await expect(writeToClipboard('GPU-ff55d89d')).resolves.toBe(true);
    expect(web).toHaveBeenCalledWith('GPU-ff55d89d');
  });

  it('falls back to the web clipboard API when the bridge throws', async () => {
    bridge.writeText.mockRejectedValue(new Error('ponte indisponível'));
    const web = installWebClipboard(async () => undefined);

    await expect(writeToClipboard('GPU-ff55d89d')).resolves.toBe(true);
    expect(web).toHaveBeenCalledWith('GPU-ff55d89d');
  });

  it('reports a failure when every mechanism refuses', async () => {
    bridge.writeText.mockResolvedValue(false);
    installWebClipboard(async () => {
      throw new Error('Write permission denied');
    });

    await expect(writeToClipboard('GPU-ff55d89d')).resolves.toBe(false);
  });

  it('never reports success when the legacy copy returns false', async () => {
    bridge.writeText.mockResolvedValue(false);
    document.execCommand = vi.fn(() => false);

    await expect(writeToClipboard('GPU-ff55d89d')).resolves.toBe(false);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });

  it('accepts the legacy copy when it really worked', async () => {
    bridge.writeText.mockResolvedValue(false);
    document.execCommand = vi.fn(() => true);

    await expect(writeToClipboard('GPU-ff55d89d')).resolves.toBe(true);
  });

  it('refuses an empty or oversized text without touching the clipboard', async () => {
    await expect(writeToClipboard('')).resolves.toBe(false);
    await expect(writeToClipboard('x'.repeat(8193))).resolves.toBe(false);
    expect(bridge.writeText).not.toHaveBeenCalled();
    expect(document.execCommand).not.toHaveBeenCalled();
  });
});
