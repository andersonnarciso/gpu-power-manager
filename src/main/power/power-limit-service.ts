/**
 * Implementation of the `PowerLimitService` contract.
 *
 * Every change follows the same protocol:
 *   1. validate the input (UUID and watts);
 *   2. check the GPU exists;
 *   3. resolve the live range from the driver and refuse values outside it;
 *   4. perform the change;
 *   5. re-read the limit and confirm it was really applied.
 *
 * A change that can not be confirmed is reported as a failure even when the
 * command itself succeeded, because the user must never be told that a limit
 * was applied when it was not.
 */

import type { PowerLimitBounds, PowerLimitService } from '../../shared/contracts';
import {
  ErrorCode,
  type AppError,
  type GpuUuid,
  type PowerLimitChangeResult,
  type PowerLimitRequest,
} from '../../shared/types';
import { assertGpuUuid, assertWatts, ValidationError } from '../../shared/validation';
import { AppErrorException, asAppError, fail } from '../privileged/errors';
import { HelperClient } from '../privileged/helper-client';
import { nodeExecRunner, type ExecRunner } from '../privileged/exec';
import { nodeFileProbe, type FileProbe } from '../privileged/polkit';
import type { PowerLimitBackend } from './backend';
import { NvidiasmiBackend, NVIDIA_SMI_CANDIDATES } from './nvidia-smi-backend';
import { resolveDefaultWatts, resolveTargetWatts, toPowerLimitBounds } from './limits';
import { SimulatedPowerBackend } from './simulated-backend';

export interface PowerLimitServiceOptions {
  /** Backend used to read and change the limits. */
  backend?: PowerLimitBackend;
  /** Forces the simulated backend even when real hardware is present. */
  simulate?: boolean;
  /** Executor used by the backends. */
  runner?: ExecRunner;
  /** Filesystem probe used by the backends. */
  probe?: FileProbe;
  /** Client of the privileged helper. */
  helperClient?: HelperClient;
  /** Clock used to stamp the verifications. */
  now?: () => number;
}

/** Coerces a requested watt value into a number usable for reporting. */
function safeRequestedWatts(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class PowerLimitServiceImpl implements PowerLimitService {
  private readonly backend: PowerLimitBackend;
  private readonly now: () => number;

  constructor(backend: PowerLimitBackend, options: { now?: () => number } = {}) {
    this.backend = backend;
    this.now = options.now ?? Date.now;
  }

  async bounds(uuid: GpuUuid): Promise<PowerLimitBounds> {
    const safeUuid = this.validateUuid(uuid);
    const exists = await this.backend.exists(safeUuid);
    if (!exists) {
      throw fail(ErrorCode.GpuNotFound, `A GPU ${safeUuid} não existe no sistema.`);
    }
    const limits = await this.backend.bounds(safeUuid);
    return toPowerLimitBounds(safeUuid, limits);
  }

  async apply(request: PowerLimitRequest): Promise<PowerLimitChangeResult> {
    const rawUuid = request?.uuid;
    const rawWatts = request?.watts;
    const requestedWatts = safeRequestedWatts(rawWatts);

    let uuid: string;
    try {
      uuid = assertGpuUuid(rawUuid);
    } catch (error) {
      return this.failure(rawUuid, requestedWatts, this.toAppError(error));
    }

    let watts: number;
    try {
      watts = assertWatts(rawWatts);
    } catch (error) {
      return this.failure(uuid, requestedWatts, this.toAppError(error));
    }

    try {
      const exists = await this.backend.exists(uuid);
      if (!exists) {
        return this.failure(uuid, watts, {
          code: ErrorCode.GpuNotFound,
          message: `A GPU ${uuid} não existe no sistema.`,
        });
      }

      const limits = await this.backend.bounds(uuid);
      const bounds = toPowerLimitBounds(uuid, limits);
      if (!bounds.adjustable) {
        return this.failure(uuid, watts, {
          code: ErrorCode.UnsupportedByDriver,
          message: 'Esta GPU não permite alterar o limite de potência.',
          detail: 'O driver informou uma faixa fixa (mínimo igual ao máximo).',
        });
      }

      const resolution = resolveTargetWatts(watts, bounds);
      if (!resolution.ok) {
        // The backend is never called with a value outside the range.
        return this.failure(uuid, watts, resolution.error);
      }

      await this.backend.apply(uuid, resolution.watts);
      return await this.confirm(uuid, resolution.watts);
    } catch (error) {
      return this.failure(uuid, watts, this.toAppError(error));
    }
  }

  async applyMany(requests: PowerLimitRequest[]): Promise<PowerLimitChangeResult[]> {
    const list = Array.isArray(requests) ? requests : [];
    const results: PowerLimitChangeResult[] = [];
    // Sequential on purpose: a batch of changes would otherwise trigger one
    // authorization dialog per GPU at the same time.
    for (const request of list) {
      try {
        results.push(await this.apply(request));
      } catch (error) {
        // `apply` never throws, this is only a safety net.
        results.push(
          this.failure(request?.uuid, safeRequestedWatts(request?.watts), this.toAppError(error)),
        );
      }
    }
    return results;
  }

  async resetToDefault(uuid: GpuUuid): Promise<PowerLimitChangeResult> {
    let safeUuid: string;
    try {
      safeUuid = assertGpuUuid(uuid);
    } catch (error) {
      return this.failure(uuid, 0, this.toAppError(error));
    }

    try {
      const exists = await this.backend.exists(safeUuid);
      if (!exists) {
        return this.failure(safeUuid, 0, {
          code: ErrorCode.GpuNotFound,
          message: `A GPU ${safeUuid} não existe no sistema.`,
        });
      }

      const limits = await this.backend.bounds(safeUuid);
      const bounds = toPowerLimitBounds(safeUuid, limits);
      const resolution = resolveDefaultWatts(bounds);
      if (!resolution.ok) {
        return this.failure(safeUuid, 0, resolution.error);
      }

      await this.backend.reset(safeUuid);
      return await this.confirm(safeUuid, resolution.watts);
    } catch (error) {
      return this.failure(safeUuid, 0, this.toAppError(error));
    }
  }

  async resetMany(uuids: GpuUuid[]): Promise<PowerLimitChangeResult[]> {
    const list = Array.isArray(uuids) ? uuids : [];
    const results: PowerLimitChangeResult[] = [];
    for (const uuid of list) {
      try {
        results.push(await this.resetToDefault(uuid));
      } catch (error) {
        results.push(this.failure(uuid, 0, this.toAppError(error)));
      }
    }
    return results;
  }

  /**
   * Re-reads the limit from the driver and compares it with what was asked.
   */
  private async confirm(uuid: string, expectedWatts: number): Promise<PowerLimitChangeResult> {
    const limits = await this.backend.bounds(uuid);
    const observedLimitW = limits.current;
    const confirmed = observedLimitW === expectedWatts;
    const verification = {
      confirmed,
      observedLimitW,
      observedAt: this.now(),
    };
    if (!confirmed) {
      return {
        uuid,
        requestedWatts: expectedWatts,
        appliedWatts: observedLimitW,
        ok: false,
        error: {
          code: ErrorCode.CommandFailed,
          message:
            observedLimitW === null
              ? `O driver não informou o limite de potência após a alteração para ${expectedWatts} W.`
              : `O driver informou ${observedLimitW} W depois da alteração, mas foram pedidos ${expectedWatts} W.`,
          detail: 'A alteração não foi confirmada pelo driver e por isso é considerada falha.',
        },
        verification,
      };
    }
    return {
      uuid,
      requestedWatts: expectedWatts,
      appliedWatts: observedLimitW,
      ok: true,
      verification,
    };
  }

  private failure(uuid: unknown, requestedWatts: number, error: AppError): PowerLimitChangeResult {
    return {
      uuid: typeof uuid === 'string' ? uuid : '',
      requestedWatts,
      appliedWatts: null,
      ok: false,
      error,
    };
  }

  private validateUuid(uuid: unknown): string {
    try {
      return assertGpuUuid(uuid);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw fail(ErrorCode.ValidationFailed, error.message, { detail: `Campo inválido: ${error.field}` });
      }
      throw error;
    }
  }

  private toAppError(error: unknown): AppError {
    if (error instanceof AppErrorException) return error.appError;
    return asAppError(error);
  }
}

/**
 * Builds the power limit service.
 *
 * Backend selection:
 *  - an explicit backend always wins;
 *  - `simulate: true` forces the simulated backend;
 *  - otherwise the real backend is used when `nvidia-smi` is present and the
 *    simulated one is used as a fallback, so the app still works (and can
 *    still be tested) on a machine without an NVIDIA GPU.
 */
export function createPowerLimitService(options: PowerLimitServiceOptions = {}): PowerLimitServiceImpl {
  return new PowerLimitServiceImpl(createPowerLimitBackend(options), { now: options.now });
}

/** Builds the backend used by the service. */
export function createPowerLimitBackend(options: PowerLimitServiceOptions = {}): PowerLimitBackend {
  if (options.backend !== undefined) return options.backend;
  const probe = options.probe ?? nodeFileProbe;
  const runner = options.runner ?? nodeExecRunner;
  if (options.simulate === true) return new SimulatedPowerBackend();
  const helperClient = options.helperClient ?? new HelperClient({ runner, probe });
  const hasDriver = NVIDIA_SMI_CANDIDATES.some((candidate) => probe.exists(candidate));
  if (!hasDriver) return new SimulatedPowerBackend();
  return new NvidiasmiBackend({ runner, probe, helperClient });
}
