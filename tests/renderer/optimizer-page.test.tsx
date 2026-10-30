/**
 * Optimiser page: the recommendation is the one of the service, never one the
 * renderer picks on its own.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { OptimizerPage } from '@renderer/pages/OptimizerPage';
import { t } from '@renderer/lib/i18n';
import type { OptimizerRecommendation } from '@shared/types';
import { useBenchmarkStore } from '@renderer/store/benchmark';
import { useTelemetryStore } from '@renderer/store/telemetry';
import { usePowerStore } from '@renderer/store/power';
import { useUiStore } from '@renderer/store/ui';
import {
  createDevice,
  createRun,
  createStubBridge,
  createStubState,
  GPU_UUID,
  type StubState,
} from './helpers/dom';

const state: StubState = createStubState();
window.gpuPm = createStubBridge(state);

function reset(runs = [], recommendations: OptimizerRecommendation[] = []): void {
  state.runs = runs;
  state.adapters = [];
  state.recommendations = recommendations;
  state.applied = [];
  state.started = [];
  state.requests = [];
  useBenchmarkStore.setState({
    runs,
    adapters: [],
    runningId: null,
    liveRun: null,
    live: null,
    loading: false,
  });
  useTelemetryStore.setState({ devices: [createDevice()], history: [] });
  usePowerStore.setState({ bounds: {}, drafts: {}, applying: false, results: [] });
  useUiStore.setState({ toasts: [] });
}

/** The row the page marks as the recommendation of the service. */
function recommendedRow(): HTMLElement | null {
  return document.querySelector('[data-recommended="true"]');
}

async function analyse(): Promise<void> {
  const button = screen.getByRole('button', { name: t('opt.analyze') });
  await waitFor(() => expect(button).not.toBeDisabled());
  await act(async () => {
    fireEvent.click(button);
  });
}

/** Renders the page and lets the store settle, so no update escapes act(). */
async function renderPage(): Promise<void> {
  await act(async () => {
    render(<OptimizerPage />);
  });
}

describe('OptimizerPage', () => {
  beforeEach(() => {
    reset();
  });

  afterEach(() => {
    cleanup();
  });

  it('highlights the recommendation of the service and never picks one on its own', async () => {
    // The service recommends 220 W. The 160 W candidate was never measured, so
    // its energy delta is unknown: the renderer must not treat it as a zero
    // and pick it.
    const recommendations: OptimizerRecommendation[] = [
      {
        uuid: GPU_UUID,
        watts: 220,
        baselineWatts: 178,
        performanceDeltaPct: 0,
        energyDeltaPct: 20,
        meetsConstraint: true,
        reason: 'Recomendado: 220 W consumiu 1.200,0 J',
      },
      {
        uuid: GPU_UUID,
        watts: 160,
        baselineWatts: 178,
        performanceDeltaPct: -1,
        energyDeltaPct: null,
        meetsConstraint: true,
        reason: 'Energia não medida em 160 W: 0 J não é uma medição válida',
      },
    ];

    reset(
      [createRun({ id: 'base', name: 'Base 178 W', watts: 178, joules: 1200 })],
      recommendations,
    );
    await renderPage();

    await analyse();

    const row = await waitFor(() => {
      const found = recommendedRow();
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    expect(within(row).getByText('220 W')).toBeInTheDocument();
    expect(row.textContent).toContain('Recomendado: 220 W consumiu 1.200,0 J');

    // The candidate that was never measured is listed, but it is not the
    // recommendation and it is not the one the page offers to apply.
    const allRows = screen.getAllByRole('row');
    const unmeasured = allRows.find((node) => node.textContent?.includes('160 W'));
    expect(unmeasured).toBeDefined();
    expect(unmeasured?.getAttribute('data-recommended')).toBeNull();

    expect(screen.getByRole('button', { name: t('opt.applyRecommendation') })).toBeInTheDocument();
  });

  it('says so when the service returns no recommendation', async () => {
    reset([createRun({ id: 'base', name: 'Base 178 W', watts: 178, joules: 1200 })]);
    await renderPage();

    await analyse();

    expect(await screen.findByText(t('opt.noRecommendation'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('opt.applyRecommendation') })).toBeNull();
  });

  it('never seeds the candidates with an aborted or unmeasured run', async () => {
    reset([
      createRun({ id: 'base', name: 'Base 178 W', watts: 178, joules: 1200 }),
      createRun({ id: 'aborted', name: 'Interrompida', watts: 160, status: 'aborted', joules: 1200 }),
      createRun({ id: 'partial', name: 'Parcial', watts: 172, coveragePct: 10, joules: 1200 }),
      createRun({
        id: 'no-limit',
        name: 'Sem limite',
        watts: 166,
        joules: 1200,
        limitVerified: false,
        observedLimitW: 285,
      }),
    ]);
    await renderPage();

    await analyse();

    await waitFor(() => expect(state.requests.length).toBeGreaterThan(0));
    const candidates = state.requests[0].candidateWatts;
    // The watt value of the run that was really measured is offered.
    expect(candidates).toContain(178);
    // The aborted, the partial and the run whose limit was not in effect
    // never seed the candidates.
    expect(candidates).not.toContain(160);
    expect(candidates).not.toContain(172);
    expect(candidates).not.toContain(166);
  });
});
