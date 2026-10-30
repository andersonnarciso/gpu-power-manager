/**
 * Adapter for the NVIDIA `nvidia-smi` command line tool.
 *
 * Design rules that must not be broken:
 *  - the binary is always executed through `execFile` with an argv array,
 *    never through a shell, so no input can ever be interpreted as a command;
 *  - every call has a timeout, because a wedged driver must not freeze the
 *    telemetry loop;
 *  - the per-tick query is a **single** `nvidia-smi` invocation, no matter
 *    how many GPUs the machine has. One process per tick is a hard CPU
 *    efficiency requirement.
 *
 * The exec layer is injectable so the whole adapter can be unit tested
 * without a GPU.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ErrorCode } from '../../shared/types';
import type { GpuDevice } from '../../shared/types';
import { createLogger, nullLogger, type Logger } from './logger';
import {
  GPU_QUERY_FIELDS,
  THROTTLE_QUERY_FIELDS,
  parseAccountedAppsCsv,
  parseComputeAppsCsv,
  parseCudaVersion,
  parseGpuCsv,
  parsePmonOutput,
  parseThrottlePerformanceText,
  parseThrottleQueryCsv,
  type GpuProcessRow,
  type ThrottleReading,
} from './parse';
import type { GpuSource } from './source';

/* ------------------------------------------------------------------- errors */

/** Failure of a single `nvidia-smi` invocation. */
export class NvidiaSmiError extends Error {
  readonly code: string;
  /** stderr of the failed call, when the driver produced any. */
  readonly stderr: string;

  constructor(code: string, message: string, stderr = '') {
    super(message);
    this.name = 'NvidiaSmiError';
    this.code = code;
    this.stderr = stderr;
  }
}

/* ---------------------------------------------------------------- exec layer */

export interface ExecFileOptions {
  timeout: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}

export interface ExecFileOutcome {
  stdout: string;
  stderr: string;
}

/** The seam every test replaces. Never receives a shell string. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<ExecFileOutcome>;

interface ExecFileFailure {
  code?: string | number;
  killed?: boolean;
  signal?: string | null;
  message: string;
}

/** Default exec layer: `execFile` with an argv array, no shell involved. */
export const defaultExecFile: ExecFileFn = (file, args, options) =>
  new Promise<ExecFileOutcome>((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        env: options.env,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

function asExecFailure(error: unknown): ExecFileFailure {
  if (error instanceof Error) {
    const candidate = error as Partial<ExecFileFailure>;
    return {
      code: candidate.code,
      killed: candidate.killed,
      signal: candidate.signal ?? null,
      message: error.message,
    };
  }
  return { message: String(error) };
}

/* ------------------------------------------------------------ binary lookup */

/** Well known locations, checked after the `PATH`. */
export const NVIDIA_SMI_FALLBACK_PATHS: readonly string[] = [
  '/usr/bin/nvidia-smi',
  '/usr/local/bin/nvidia-smi',
  '/usr/lib/wsl/lib/nvidia-smi',
  '/usr/lib/x86_64-linux-gnu/nvidia-smi',
];

/** Default check: the path exists and is an executable regular file. */
export function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export interface LocateOptions {
  /** Value of `PATH`; defaults to the environment of the process. */
  pathEnv?: string;
  /** Extra candidates checked after `PATH`. */
  candidates?: readonly string[];
  /** Executability check, injectable for the tests. */
  isExecutable?: (candidate: string) => boolean;
}

/**
 * Finds the `nvidia-smi` binary: first every directory of `PATH`, then the
 * well known system locations. Returns `null` when the driver is missing.
 */
export function locateNvidiaSmi(options: LocateOptions = {}): string | null {
  const isExecutable = options.isExecutable ?? isExecutableFile;
  const candidates = options.candidates ?? NVIDIA_SMI_FALLBACK_PATHS;
  const pathEnv = options.pathEnv ?? process.env['PATH'] ?? '';

  for (const directory of pathEnv.split(path.delimiter)) {
    if (directory === '') continue;
    const candidate = path.join(directory, 'nvidia-smi');
    if (isExecutable(candidate)) return candidate;
  }

  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  return null;
}

/* ------------------------------------------------------------------ client */

export interface NvidiaSmiClientOptions {
  /** Explicit binary path; when omitted the binary is located on first use. */
  binaryPath?: string | null;
  /** Hard timeout for every call. */
  timeoutMs?: number;
  /** Maximum captured output, bytes. */
  maxBuffer?: number;
  /** Injectable exec layer. */
  exec?: ExecFileFn;
  /** Environment used for the child process. */
  env?: NodeJS.ProcessEnv;
  /** Injectable clock, used for `lastSeenAt`. */
  now?: () => number;
  /** Injectable logger. */
  logger?: Logger;
}

/** Result of the throttle query, including the "driver does not support it" case. */
export interface ThrottleQueryResult {
  /** False when the driver refused every known way of reading the reasons. */
  supported: boolean;
  readings: ThrottleReading[];
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export class NvidiaSmiClient {
  private readonly exec: ExecFileFn;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly logger: Logger;

  private binaryPath: string | null;
  private cudaVersionCache: string | null = null;
  private cudaVersionLoaded = false;
  private throttleReadings: ThrottleReading[] = [];

  constructor(options: NvidiaSmiClientOptions = {}) {
    this.exec = options.exec ?? defaultExecFile;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? createLogger('nvidia');
    this.binaryPath = options.binaryPath ?? null;
  }

  /** Path of the binary in use, locating it lazily when needed. */
  getBinaryPath(): string {
    if (this.binaryPath === null) {
      const located = locateNvidiaSmi();
      if (located === null) {
        throw new NvidiaSmiError(
          ErrorCode.DriverUnavailable,
          'Binário nvidia-smi não encontrado no PATH nem nos caminhos padrão.',
        );
      }
      this.binaryPath = located;
    }
    return this.binaryPath;
  }

  /** Overrides the binary path (used by the tests and by the app settings). */
  setBinaryPath(binaryPath: string | null): void {
    this.binaryPath = binaryPath;
    this.cudaVersionLoaded = false;
    this.cudaVersionCache = null;
  }

  /**
   * Runs `nvidia-smi` with the given arguments and returns stdout.
   * Throws {@link NvidiaSmiError} for every failure mode.
   */
  async run(args: readonly string[]): Promise<string> {
    const binary = this.getBinaryPath();
    let outcome: ExecFileOutcome;
    try {
      outcome = await this.exec(binary, args, {
        timeout: this.timeoutMs,
        maxBuffer: this.maxBuffer,
        env: this.env,
      });
    } catch (error) {
      throw this.toSmiError(error);
    }
    return outcome.stdout;
  }

  /** Same as {@link run} but also returns stderr. */
  async runWithStderr(args: readonly string[]): Promise<ExecFileOutcome> {
    const binary = this.getBinaryPath();
    try {
      return await this.exec(binary, args, {
        timeout: this.timeoutMs,
        maxBuffer: this.maxBuffer,
        env: this.env,
      });
    } catch (error) {
      throw this.toSmiError(error);
    }
  }

  /** Maps a raw exec failure onto a structured error. */
  private toSmiError(error: unknown): NvidiaSmiError {
    const failure = asExecFailure(error);
    if (failure.code === 'ENOENT') {
      return new NvidiaSmiError(
        ErrorCode.DriverUnavailable,
        'Binário nvidia-smi não encontrado.',
      );
    }
    if (failure.killed === true || failure.signal === 'SIGTERM' || failure.signal === 'SIGKILL') {
      return new NvidiaSmiError(
        ErrorCode.Timeout,
        `nvidia-smi excedeu o tempo limite de ${this.timeoutMs} ms.`,
      );
    }
    return new NvidiaSmiError(
      ErrorCode.CommandFailed,
      `nvidia-smi falhou: ${failure.message}`,
    );
  }

  /**
   * Reads every GPU in a **single** `nvidia-smi` call.
   */
  async queryGpuList(): Promise<GpuDevice[]> {
    const args = [
      `--query-gpu=${GPU_QUERY_FIELDS.join(',')}`,
      '--format=csv,noheader,nounits',
    ];
    const stdout = await this.run(args);
    return parseGpuCsv(stdout, {
      at: this.now(),
      cudaVersion: this.cudaVersionCache,
      throttle: this.throttleReadings,
    });
  }

  /**
   * Reads the CUDA version from the banner. The banner is the source of
   * truth: a driver may report a `driver_version` that does not match the
   * CUDA version it was built for.
   */
  async queryCudaVersion(): Promise<string | null> {
    const stdout = await this.run([]);
    const version = parseCudaVersion(stdout);
    this.cudaVersionCache = version;
    this.cudaVersionLoaded = true;
    return version;
  }

  /** Cached CUDA version, without touching the driver. */
  getCachedCudaVersion(): string | null {
    return this.cudaVersionLoaded ? this.cudaVersionCache : null;
  }

  /** Cached throttle readings, without touching the driver. */
  getCachedThrottleReadings(): ThrottleReading[] {
    return this.throttleReadings;
  }

  /**
   * Reads the throttle reasons.
   *
   * The `clocks_event_reasons` query fields are not supported by every
   * driver, so the implementation falls back to parsing
   * `nvidia-smi -q -d PERFORMANCE`. When both fail the result is flagged as
   * unsupported instead of raising: throttle reasons are decoration, not a
   * reason to break the telemetry loop.
   */
  async queryThrottleReasons(): Promise<ThrottleQueryResult> {
    const queryArgs = [
      `--query-gpu=${['index', ...THROTTLE_QUERY_FIELDS].join(',')}`,
      '--format=csv,noheader,nounits',
    ];
    try {
      const stdout = await this.run(queryArgs);
      const readings = parseThrottleQueryCsv(stdout);
      this.throttleReadings = readings;
      return { supported: true, readings };
    } catch (error) {
      this.logger.debug('Consulta de throttle reasons por query não suportada.', error);
    }

    try {
      const stdout = await this.run(['-q', '-d', 'PERFORMANCE']);
      const readings = parseThrottlePerformanceText(stdout);
      this.throttleReadings = readings;
      return { supported: readings.length > 0, readings };
    } catch (error) {
      this.logger.warn('Não foi possível ler os motivos de throttling.', error);
      this.throttleReadings = [];
      return { supported: false, readings: [] };
    }
  }

  /**
   * Reads the processes that use the GPUs.
   *
   * Compute applications are read with `--query-compute-apps`; the graphics
   * applications come from `--query-accounted-apps` and, when the driver
   * refuses those fields, from `nvidia-smi pmon`.
   */
  async queryGpuProcesses(): Promise<GpuProcessRow[]> {
    const compute = await this.queryComputeApps();
    const graphics = await this.queryAccountedApps();

    const merged = [...compute];
    const seen = new Set(compute.map((row) => `${row.pid}:${row.gpuUuid ?? 'none'}`));
    for (const row of graphics) {
      const key = `${row.pid}:${row.gpuUuid ?? 'none'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
    return merged;
  }

  /** `--query-compute-apps`, with a fallback when `gpu_uuid` is refused. */
  private async queryComputeApps(): Promise<GpuProcessRow[]> {
    const withUuid = ['--query-compute-apps=pid,process_name,used_gpu_memory,gpu_uuid'];
    try {
      const stdout = await this.run([...withUuid, '--format=csv,noheader,nounits']);
      return parseComputeAppsCsv(stdout);
    } catch (error) {
      this.logger.debug('Campo gpu_uuid recusado, usando consulta simplificada.', error);
    }
    try {
      const stdout = await this.run([
        '--query-compute-apps=pid,process_name,used_gpu_memory',
        '--format=csv,noheader,nounits',
      ]);
      return parseComputeAppsCsv(stdout);
    } catch (error) {
      this.logger.warn('Não foi possível listar as aplicações de compute.', error);
      return [];
    }
  }

  /** `--query-accounted-apps`, with the `pmon` fallback. */
  private async queryAccountedApps(): Promise<GpuProcessRow[]> {
    try {
      const stdout = await this.run([
        '--query-accounted-apps=pid,gpu_uuid,gpu_utilization,max_memory_usage',
        '--format=csv,noheader,nounits',
      ]);
      return parseAccountedAppsCsv(stdout);
    } catch (error) {
      this.logger.debug('Consulta de aplicações de graphics não suportada.', error);
    }
    try {
      const stdout = await this.run(['pmon', '-c', '1']);
      return parsePmonOutput(stdout);
    } catch (error) {
      this.logger.warn('Não foi possível listar as aplicações de graphics.', error);
      return [];
    }
  }
}

/* ------------------------------------------------------------------ source */

/**
 * The real hardware source. One `nvidia-smi` process per tick, ever.
 */
export class NvidiaGpuSource implements GpuSource {
  private readonly client: NvidiaSmiClient;
  private readonly logger: Logger;

  constructor(options: { client?: NvidiaSmiClient; logger?: Logger } = {}) {
    this.client = options.client ?? new NvidiaSmiClient();
    this.logger = options.logger ?? nullLogger;
  }

  /** The underlying client, for the power limit service. */
  getClient(): NvidiaSmiClient {
    return this.client;
  }

  async list(): Promise<GpuDevice[]> {
    return this.client.queryGpuList();
  }

  async poll(): Promise<GpuDevice[]> {
    return this.client.queryGpuList();
  }

  isSimulated(): boolean {
    return false;
  }

  /**
   * Reads the CUDA banner once. Kept out of the tick so the per-tick cost
   * stays at exactly one process.
   */
  async prime(): Promise<void> {
    try {
      await this.client.queryCudaVersion();
    } catch (error) {
      this.logger.warn('Não foi possível ler a versão do CUDA.', error);
    }
  }

  /**
   * Refreshes the throttle reasons and caches them, so the next poll shows
   * them on the devices.
   *
   * This is deliberately **not** part of the tick: the throttle flags are
   * not supported by every driver and they change slowly, so the app reads
   * them on demand instead of paying for a second process every second.
   */
  async refreshThrottleReasons(): Promise<ThrottleQueryResult> {
    return this.client.queryThrottleReasons();
  }
}
