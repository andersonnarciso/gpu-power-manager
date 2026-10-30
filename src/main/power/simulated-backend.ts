/**
 * Simulated power limit backend.
 *
 * It mirrors the behaviour of the real driver: a value outside the supported
 * range is refused instead of being clamped, and an unknown GPU is reported
 * as such. Because of that the whole app can be exercised, and tested, on a
 * machine without an NVIDIA GPU.
 */

import { SIMULATED_GPUS, SimulatedPowerState, type SimulatedGpuDefinition } from '../../shared/simulation';
import { ErrorCode, type GpuUuid } from '../../shared/types';
import { fail } from '../privileged/errors';
import type { BackendPowerLimits, PowerLimitBackend } from './backend';
import { formatRange } from './limits';

export class SimulatedPowerBackend implements PowerLimitBackend {
  private readonly state: SimulatedPowerState;
  private readonly definitions: readonly SimulatedGpuDefinition[];

  constructor(state?: SimulatedPowerState, definitions: readonly SimulatedGpuDefinition[] = SIMULATED_GPUS) {
    this.state = state ?? new SimulatedPowerState();
    this.definitions = definitions;
  }

  isSimulated(): boolean {
    return true;
  }

  async exists(uuid: GpuUuid): Promise<boolean> {
    return this.definition(uuid) !== null;
  }

  async bounds(uuid: GpuUuid): Promise<BackendPowerLimits> {
    const definition = this.definition(uuid);
    if (definition === null) {
      throw fail(ErrorCode.GpuNotFound, `A GPU ${uuid} não existe no sistema.`);
    }
    return {
      min: definition.minLimitW,
      max: definition.maxLimitW,
      defaultLimit: definition.defaultLimitW,
      current: this.state.getLimitW(uuid),
    };
  }

  async apply(uuid: GpuUuid, watts: number): Promise<void> {
    const definition = this.definition(uuid);
    if (definition === null) {
      throw fail(ErrorCode.GpuNotFound, `A GPU ${uuid} não existe no sistema.`);
    }
    if (!Number.isInteger(watts) || watts < definition.minLimitW || watts > definition.maxLimitW) {
      // Same rule as the real driver: refuse, never clamp.
      throw fail(
        ErrorCode.ValidationFailed,
        `O limite de ${watts} W está fora da faixa suportada por esta GPU (${formatRange(
          definition.minLimitW,
          definition.maxLimitW,
        )}).`,
        { detail: `Valores aceitos: ${definition.minLimitW}–${definition.maxLimitW} W.` },
      );
    }
    if (!this.state.setLimitW(uuid, watts)) {
      throw fail(
        ErrorCode.CommandFailed,
        `O estado simulado recusou o novo limite de ${watts} W para a GPU ${uuid}.`,
      );
    }
  }

  async reset(uuid: GpuUuid): Promise<void> {
    const definition = this.definition(uuid);
    if (definition === null) {
      throw fail(ErrorCode.GpuNotFound, `A GPU ${uuid} não existe no sistema.`);
    }
    if (!this.state.reset(uuid)) {
      throw fail(ErrorCode.CommandFailed, `Não foi possível restaurar o limite padrão da GPU ${uuid}.`);
    }
  }

  private definition(uuid: GpuUuid): SimulatedGpuDefinition | null {
    return this.definitions.find((candidate) => candidate.uuid === uuid) ?? null;
  }
}
