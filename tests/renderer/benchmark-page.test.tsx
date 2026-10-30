/**
 * Benchmark page: the renderer must never publish a figure that was not
 * measured, and it must only offer comparable runs for a comparison.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BenchmarkPage } from '@renderer/pages/BenchmarkPage';
import { t } from '@renderer/lib/i18n';
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

function reset(runs = []): void {
  state.runs = runs;
  state.adapters = [];
  state.recommendations = [];
  state.applied = [];
  state.started = [];
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

/** The table of the results, the one that lists the measured runs. */
function resultsTable(): HTMLElement {
  const table = screen
    .getAllByRole('table')
    .find((node) => within(node).queryByRole('columnheader', { name: t('bench.runName') }));
  expect(table).toBeDefined();
  return table as HTMLElement;
}

/** The row of the results table that carries the given name. */
async function rowNamed(name: string): Promise<HTMLElement> {
  const cell = await within(resultsTable()).findByText(name);
  const row = cell.closest('tr');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

/** The cell of a row, found by the text of its column header. */
function cellOf(row: HTMLElement, header: string): HTMLElement {
  const headers = within(resultsTable()).getAllByRole('columnheader');
  const index = headers.findIndex((node) => node.textContent?.trim() === header);
  expect(index).toBeGreaterThanOrEqual(0);
  const cell = row.cells[index];
  expect(cell).toBeDefined();
  return cell as HTMLElement;
}

async function openSelect(label: string): Promise<void> {
  const trigger = screen.getByLabelText(label);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

/** The messages of the toasts the page published. */
function toasts(): string[] {
  return useUiStore.getState().toasts.map((toast) => `${toast.title} ${toast.description ?? ''}`);
}

/** Renders the page and lets the store settle, so no update escapes act(). */
async function renderPage(): Promise<void> {
  await act(async () => {
    render(<BenchmarkPage />);
  });
}

describe('BenchmarkPage', () => {
  beforeEach(() => {
    reset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the real figure of a run that was measured', async () => {
    reset([
      createRun({
        id: 'ok',
        name: 'Medido 200 W',
        joules: 1200,
        throughput: { unit: 'token', count: 300 },
      }),
    ]);
    await renderPage();

    const row = await rowNamed('Medido 200 W');
    expect(within(row).getByText('4,00 por token')).toBeInTheDocument();
    expect(cellOf(row, t('bench.energy')).textContent).toContain('1.200 J');
  });

  it('never publishes a per token figure for a run that produced no token', async () => {
    reset([
      createRun({
        id: 'zero',
        name: 'Sem tokens',
        joules: 500,
        throughput: { unit: 'token', count: 0 },
      }),
    ]);
    await renderPage();

    const row = await rowNamed('Sem tokens');
    expect(within(row).queryByText(/por token/)).toBeNull();
    expect(within(row).queryByText('500,00 por token')).toBeNull();
    expect(within(row).getByLabelText(t('bench.noWorkProduced'))).toHaveTextContent('—');
  });

  it('never publishes a figure for an energy that was not measured', async () => {
    reset([
      createRun({
        id: 'unresolved',
        name: 'Sem medição',
        joules: 0,
        measuredMs: 0,
        throughput: { unit: 'token', count: 120 },
      }),
    ]);
    await renderPage();

    const row = await rowNamed('Sem medição');
    expect(within(row).queryByText(/0,00 por token/)).toBeNull();
    expect(cellOf(row, t('bench.energy')).textContent).not.toContain('0 J');
    expect(within(row).getAllByLabelText(t('bench.energyNotMeasured')).length).toBeGreaterThan(0);
  });

  it('renders the temperatures and the "not measured" marker when there is none', async () => {
    reset([
      createRun({
        id: 'temp',
        name: 'Com temperatura',
        joules: 1200,
        avgTemperatureC: 42.3,
        maxTemperatureC: 52,
      }),
      createRun({
        id: 'no-temp',
        name: 'Sem temperatura',
        joules: 1200,
        avgTemperatureC: null,
        maxTemperatureC: null,
      }),
    ]);
    await renderPage();

    const withTemp = await rowNamed('Com temperatura');
    expect(cellOf(withTemp, t('bench.temperatureAvg')).textContent).toContain('42 °C');
    expect(cellOf(withTemp, t('bench.temperatureMax')).textContent).toContain('52 °C');

    const withoutTemp = await rowNamed('Sem temperatura');
    expect(
      within(cellOf(withoutTemp, t('bench.temperatureAvg'))).getByLabelText(t('bench.notMeasured')),
    ).toHaveTextContent('—');
    expect(
      within(cellOf(withoutTemp, t('bench.temperatureMax'))).getByLabelText(t('bench.notMeasured')),
    ).toHaveTextContent('—');
  });

  it('only offers comparable runs in the comparison', async () => {
    reset([
      createRun({ id: 'a', name: 'Base 200 W', adapterId: 'ollama', joules: 1200 }),
      createRun({ id: 'b', name: 'Candidato 180 W', adapterId: 'ollama', joules: 900, watts: 180 }),
      createRun({ id: 'aborted', name: 'Interrompida', adapterId: 'ollama', status: 'aborted' }),
      createRun({
        id: 'other',
        name: 'Outro adaptador',
        adapterId: 'llama-server',
        joules: 1000,
      }),
    ]);
    await renderPage();

    await rowNamed('Base 200 W');
    await openSelect(t('bench.baseline'));

    const options = screen.getAllByRole('option').map((node) => node.textContent);
    expect(options).toContain('Base 200 W');
    expect(options).toContain('Candidato 180 W');
    expect(options).not.toContain('Interrompida');
    expect(options).not.toContain('Outro adaptador');
  });

  it('drops a candidate that stops being comparable and explains why', async () => {
    reset([
      createRun({ id: 'a', name: 'Base 200 W', adapterId: 'ollama', joules: 1200 }),
      createRun({ id: 'b', name: 'Candidato 180 W', adapterId: 'ollama', joules: 900, watts: 180 }),
    ]);
    await renderPage();

    await rowNamed('Base 200 W');
    await openSelect(t('bench.baseline'));
    fireEvent.click(screen.getByRole('option', { name: 'Base 200 W' }));
    await openSelect(t('bench.candidate'));
    fireEvent.click(screen.getByRole('option', { name: 'Candidato 180 W' }));

    expect(await screen.findByText(t('bench.deltaEnergy'))).toBeInTheDocument();

    // A run whose limit was known not to be in effect is not comparable.
    await act(async () => {
      reset([
        createRun({ id: 'a', name: 'Base 200 W', adapterId: 'ollama', joules: 1200 }),
        createRun({
          id: 'b',
          name: 'Candidato 180 W',
          adapterId: 'ollama',
          joules: 900,
          watts: 180,
          limitVerified: false,
          observedLimitW: 285,
        }),
      ]);
    });

    expect(await screen.findByText(t('bench.compareDroppedCandidate'))).toBeInTheDocument();
  });

  it('shows the limit that was really in effect and flags a run whose label was false', async () => {
    reset([
      createRun({
        id: 'not-applied',
        name: 'Rotulo de 160 W',
        watts: 160,
        joules: 1200,
        limitVerified: false,
        observedLimitW: 285,
      }),
    ]);
    await renderPage();

    const row = await rowNamed('Rotulo de 160 W');
    const limitCell = cellOf(row, t('bench.powerLimitColumn'));
    expect(limitCell.textContent).toContain('160 W');
    expect(limitCell.textContent).toContain('285 W');
    expect(within(row).getByText(t('bench.limitNotApplied'))).toBeInTheDocument();
    expect(within(row).getByText(t('bench.notComparable'))).toBeInTheDocument();
  });

  it('validates the target power against the range the driver reports', async () => {
    reset();
    await renderPage();

    const input = (await screen.findByLabelText(t('bench.targetPower'))) as HTMLInputElement;
    expect(screen.getByText(t('bench.allowedRange', { min: 150, max: 180 }))).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '500' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('bench.start') }));
    });

    await waitFor(() =>
      expect(toasts().join(' ')).toContain(t('power.outOfRange', { min: 150, max: 180 })),
    );
    expect(state.started).toHaveLength(0);
  });

  it('offers a path that applies the target limit before the measurement', async () => {
    reset();
    await renderPage();

    const input = (await screen.findByLabelText(t('bench.targetPower'))) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '160' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('bench.applyLimitBefore') }));
    });

    await waitFor(() => expect(toasts().join(' ')).toContain(t('bench.limitApplied')));
    expect(state.applied).toEqual([{ uuid: GPU_UUID, watts: 160 }]);
  });
});
