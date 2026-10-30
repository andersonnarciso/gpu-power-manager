/**
 * Unsloth adapter.
 *
 * Unsloth is a Python library, not a server: there is nothing to talk to over
 * HTTP. The adapter therefore drives an EXTERNAL COMMAND configured by the
 * user.
 *
 * The command is executed with `execFile` and an argv array (never a shell),
 * with a timeout. The command is expected to print one JSON line:
 *
 *   {"tokens": 512, "duration_s": 3.25}
 *
 * When the command is not configured, or when its output cannot be parsed, the
 * adapter fails with a clear message. It never invents a token rate.
 */

import { ErrorCode, type ThroughputResult, type WorkloadKind } from '../../../shared/types';
import type { AdapterEndpointsResolver } from '../../settings/settings-endpoints';
import { findExecutable, runCommand } from './command';
import {
  AdapterError,
  type AdapterDetection,
  type AdapterThroughputResult,
  type WorkloadAdapter,
  type WorkloadRunContext,
} from './types';

export interface UnslothAdapterOptions {
  /** Absolute path or name of the command, e.g. "python3" or "./unsloth_bench.py". */
  command?: string | null;
  /** Arguments passed to the command. */
  args?: string[];
  /** Endpoints currently configured by the user. */
  endpoints?: AdapterEndpointsResolver;
  /** Timeout of the command, in milliseconds. */
  timeoutMs?: number;
}

export interface UnslothMeasurement {
  tokens: number;
  durationSeconds: number;
}

export class UnslothAdapter implements WorkloadAdapter {
  readonly id = 'unsloth';
  readonly name = 'Unsloth (comando externo)';
  readonly workload: WorkloadKind = 'llm-inference';

  private readonly configuredCommand: string | null;
  private readonly configuredArgs: string[] | null;
  private readonly endpoints: AdapterEndpointsResolver | null;
  private readonly timeoutMs: number;

  constructor(options: UnslothAdapterOptions = {}) {
    this.configuredCommand = options.command ?? null;
    this.configuredArgs = options.args ?? null;
    this.endpoints = options.endpoints ?? null;
    this.timeoutMs = options.timeoutMs ?? 900_000;
  }

  /**
   * The command this adapter runs.
   *
   * It is resolved on every use: the user may change it in the settings while
   * the application is running.
   */
  private get command(): string | null {
    const configured = this.endpoints?.().unslothCommand ?? null;
    return this.configuredCommand ?? configured;
  }

  /** The arguments of the command, resolved together with it. */
  private get args(): string[] {
    if (this.configuredArgs) return this.configuredArgs;
    return this.endpoints?.().unslothArgs ?? [];
  }

  async detect(): Promise<AdapterDetection> {
    if (!this.command) {
      return {
        available: false,
        endpoint: null,
        hint: 'Configure o comando do benchmark Unsloth (ex.: "python3 ~/benchmarks/unsloth_bench.py"). O comando deve imprimir {"tokens": N, "duration_s": X}.',
      };
    }

    if (!findExecutable(this.command)) {
      return {
        available: false,
        endpoint: null,
        hint: `O comando "${this.command}" não foi encontrado no PATH.`,
      };
    }

    return {
      available: true,
      endpoint: null,
      hint: `Comando Unsloth configurado: ${this.command}.`,
    };
  }

  async run(ctx: WorkloadRunContext): Promise<ThroughputResult> {
    if (!this.command) {
      throw new AdapterError(
        ErrorCode.AdapterUnavailable,
        'Nenhum comando Unsloth foi configurado para esta medição.',
      );
    }

    let stdout: string;
    let stderr: string;
    try {
      const result = await runCommand(this.command, this.args, {
        timeoutMs: this.timeoutMs,
        signal: ctx.signal,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AdapterError(
        ErrorCode.CommandFailed,
        `O comando Unsloth falhou (${this.command}): ${message}`,
      );
    }

    const measurement = parseUnslothOutput(stdout);
    if (measurement === null) {
      throw new AdapterError(
        ErrorCode.BenchmarkFailed,
        `A saída do comando Unsloth não contém o JSON esperado ({"tokens": N, "duration_s": X}).${stderr ? ` Saída de erro: ${stderr.trim()}` : ''}`,
      );
    }

    const perSecond =
      measurement.durationSeconds > 0 ? measurement.tokens / measurement.durationSeconds : null;

    const result: AdapterThroughputResult = {
      unit: 'token',
      count: measurement.tokens,
      label: 'tokens gerados',
      source: `comando externo (${this.command})`,
      perSecond,
    };
    return result;
  }
}

/** Extracts the measurement from the JSON line printed by the command. */
export function parseUnslothOutput(stdout: string): UnslothMeasurement | null {
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;

    const record = parsed as Record<string, unknown>;
    const tokens = record.tokens;
    const duration =
      record.duration_s ?? record.durationSeconds ?? record.duration ?? record.seconds;

    if (
      typeof tokens === 'number' &&
      Number.isFinite(tokens) &&
      typeof duration === 'number' &&
      Number.isFinite(duration)
    ) {
      return { tokens, durationSeconds: duration };
    }
  }
  return null;
}
