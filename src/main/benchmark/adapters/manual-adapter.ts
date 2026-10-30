/**
 * Manual measurement adapter.
 *
 * The user starts the measurement, runs their own task (a game, a training
 * script, anything) and stops the measurement. The app cannot know how many
 * tokens or images were produced, so the throughput is reported as unknown and
 * the UI shows energy only.
 */

import type { ThroughputResult, WorkloadKind } from '../../../shared/types';
import type { AdapterDetection, WorkloadAdapter, WorkloadRunContext } from './types';

export class ManualAdapter implements WorkloadAdapter {
  readonly id = 'manual';
  readonly name = 'Medição manual';
  readonly workload: WorkloadKind = 'manual';

  async detect(): Promise<AdapterDetection> {
    return {
      available: true,
      endpoint: null,
      hint: 'Inicie a medição, execute sua tarefa e interrompa a medição ao final.',
    };
  }

  /**
   * The manual workload needs no context: the user drives the task by hand.
   *
   * The parameter is accepted anyway so the adapter honours the same call
   * shape as every other adapter of the registry.
   */
  async run(_ctx?: WorkloadRunContext): Promise<ThroughputResult> {
    return {
      unit: 'unknown',
      count: 0,
      label: 'tarefa manual',
      source: 'medição manual do usuário',
    };
  }
}
