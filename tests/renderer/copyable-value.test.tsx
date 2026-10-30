/**
 * The copy button of a value.
 *
 * The user reported that copying the GPU UUID always failed inside the
 * application ("Não foi possível copiar"). The button must report a copy that
 * really happened and must never claim a success that did not occur.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const clipboard = vi.hoisted(() => ({
  writeToClipboard: vi.fn(async (_text: string): Promise<boolean> => true),
}));

vi.mock('@renderer/lib/clipboard', () => ({
  writeToClipboard: (text: string) => clipboard.writeToClipboard(text),
}));

import { CopyableValue } from '@renderer/components/common/CopyableValue';
import { useUiStore } from '@renderer/store/ui';
import { t } from '@renderer/lib/i18n';

const UUID = 'GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1';

describe('CopyableValue', () => {
  beforeEach(() => {
    clipboard.writeToClipboard.mockReset();
    clipboard.writeToClipboard.mockResolvedValue(true);
    useUiStore.setState({ toasts: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('copies the full value and confirms it', async () => {
    render(<CopyableValue value={UUID} display="GPU-ff55d89d…8971f1" label="Copiar UUID" />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Copiar UUID'));
    });

    expect(clipboard.writeToClipboard).toHaveBeenCalledWith(UUID);
    await vi.waitFor(() => {
      const toasts = useUiStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].variant).toBe('success');
      expect(toasts[0].title).toBe(t('common.copied'));
    });
  });

  it('reports a failure instead of claiming a successful copy', async () => {
    clipboard.writeToClipboard.mockResolvedValue(false);

    render(<CopyableValue value={UUID} display="GPU-ff55d89d…8971f1" label="Copiar UUID" />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Copiar UUID'));
    });

    await vi.waitFor(() => {
      const toasts = useUiStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].variant).toBe('error');
      expect(toasts[0].title).toBe(t('common.copyFailed'));
    });
  });
});
