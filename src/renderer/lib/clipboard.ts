/**
 * Copying to the clipboard.
 *
 * Three mechanisms exist and none of them can be trusted blindly:
 *
 *  1. The Electron bridge copies through the clipboard of the main process.
 *     This is the only mechanism that works while the window is not focused
 *     and it is the one used inside the application.
 *  2. The web clipboard API (`navigator.clipboard.writeText`) needs a secure
 *     context **and** a permission that Electron refuses by default.
 *  3. The legacy `document.execCommand('copy')` does not throw when it fails:
 *     it returns `false`. Treating that as success would tell the user that a
 *     value was copied when nothing was copied at all.
 *
 * Every function here therefore answers with the truth: `true` only when the
 * text really reached the clipboard.
 */

import { getBridge } from './bridge';

/** Maximum length accepted by the clipboard. */
const MAX_TEXT_LENGTH = 8192;

/**
 * Legacy copy through a temporary selection.
 *
 * Returns the result of `execCommand`, which is `false` — not an exception —
 * when the copy did not happen.
 */
function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', 'true');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';
  area.style.opacity = '0';
  document.body.appendChild(area);

  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
  }
}

/**
 * Copies text to the clipboard, trying every mechanism available.
 *
 * Resolves to `true` only when the text really reached the clipboard.
 */
export async function writeToClipboard(text: string): Promise<boolean> {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_LENGTH) {
    return false;
  }

  // 1. Electron: the clipboard of the main process.
  try {
    const bridge = getBridge();
    if (await bridge.clipboard.writeText(text)) return true;
  } catch {
    // The bridge is unavailable or refused: try the next mechanism.
  }

  // 2. Web clipboard API (browser preview, or Electron with the permission).
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused by the browser: try the next mechanism.
  }

  // 3. Legacy selection copy. Its boolean result is the answer.
  return legacyCopy(text);
}
