/**
 * Optimiser module entry point.
 */

import { OptimizerServiceImpl, type OptimizerServiceOptions } from './optimizer-service';

export {
  OptimizerServiceImpl,
  evaluateRun,
  matchesScope,
  rejectionMessage,
  throughputMetric,
  validateOptimizerRequest,
} from './optimizer-service';
export type {
  BenchmarkRunSource,
  OptimizerServiceOptions,
  RunRejection,
} from './optimizer-service';

/** Creates the optimiser used by the IPC layer. */
export function createOptimizerService(options: OptimizerServiceOptions): OptimizerServiceImpl {
  return new OptimizerServiceImpl(options);
}
