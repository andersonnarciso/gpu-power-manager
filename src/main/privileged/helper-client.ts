/**
 * Client of the privileged helper.
 *
 * The Electron main process never talks to `nvidia-smi -pl` directly: that
 * needs root and the app must never run as root. Every privileged operation
 * is delegated to `helper/gpu-power-manager-helper.py`, which is executed
 * through `pkexec` so polkit can ask the user for authorization.
 *
 * The helper is always invoked with an argv array, never with a shell
 * string.
 */

import path from 'path';

import { ErrorCode, type AppError } from '../../shared/types';
import { assertGpuUuid, assertWatts, ValidationError } from '../../shared/validation';
import { AppErrorException, asAppError, fail } from './errors';
import { ExecFailure, nodeExecRunner, type ExecRunner } from './exec';
import { findPkexec, nodeFileProbe, type FileProbe } from './polkit';

/** System wide locations of the installed helper, in priority order. */
export const HELPER_SEARCH_PATHS: readonly string[] = [
  '/usr/local/libexec/gpu-power-manager-helper',
  '/usr/libexec/gpu-power-manager-helper',
  '/usr/lib/gpu-power-manager/helper',
];

/** Instructions shown when the helper is missing. */
export const HELPER_INSTALL_INSTRUCTIONS =
  'Instale o utilitário privilegiado pelo próprio aplicativo (Configurações > Persistência > Instalar) ' +
  'ou manualmente com: sudo install -o root -g root -m 0755 helper/gpu-power-manager-helper.py ' +
  '/usr/local/libexec/gpu-power-manager-helper';

export interface HelperClientOptions {
  /** Executor used to spawn the helper. Injectable for tests. */
  runner?: ExecRunner;
  /** Filesystem probe used to locate the helper. */
  probe?: FileProbe;
  /** Explicit helper path. When set, the search order is skipped. */
  helperPath?: string | null;
  /** Explicit `pkexec` path. When null and not found, calls fail. */
  pkexecPath?: string | null;
  /** Root of the application (source checkout or `process.resourcesPath`). */
  appRoot?: string;
  /** Timeout applied to every helper invocation. */
  timeoutMs?: number;
}

/** Limits reported by the helper for one GPU. */
export interface HelperGpuLimits {
  uuid: string;
  name: string | null;
  minWatts: number | null;
  defaultWatts: number | null;
  maxWatts: number | null;
  currentWatts: number | null;
}

/** Result of a successful helper call. */
export interface HelperOutcome {
  ok: boolean;
  uuid: string | null;
  appliedWatts: number | null;
  verified: boolean;
  limits: HelperGpuLimits[];
  raw: string;
}

interface HelperJsonError {
  code: string;
  message: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Root of the installation.
 *
 * Packaged builds expose `process.resourcesPath`; when running from source the
 * module lives in `src/main/privileged`, three levels below the repository
 * root.
 */
export function defaultAppRoot(): string {
  const resourcesPath = process.resourcesPath;
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) return resourcesPath;
  return path.resolve(__dirname, '..', '..', '..');
}

/**
 * Every location that may hold the helper, in priority order.
 *
 * The first three are the system wide installation paths. The remaining ones
 * are the bundled copies used while developing from source and inside an
 * AppImage.
 */
export function helperCandidates(appRoot: string = defaultAppRoot()): string[] {
  return [
    ...HELPER_SEARCH_PATHS,
    path.join(appRoot, 'resources', 'helper', 'gpu-power-manager-helper'),
    path.join(appRoot, 'resources', 'helper', 'gpu-power-manager-helper.py'),
    path.join(appRoot, 'helper', 'gpu-power-manager-helper'),
    path.join(appRoot, 'helper', 'gpu-power-manager-helper.py'),
  ];
}

/** Parses the JSON error object emitted by the helper on stdout. */
export function parseHelperError(stdout: string): HelperJsonError | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (record['ok'] !== false) return null;
    const error = record['error'];
    if (error && typeof error === 'object') {
      const errorRecord = error as Record<string, unknown>;
      const code = typeof errorRecord['code'] === 'string' ? errorRecord['code'] : ErrorCode.Unknown;
      const message =
        typeof errorRecord['message'] === 'string'
          ? errorRecord['message']
          : 'O utilitário privilegiado falhou.';
      return { code, message };
    }
    if (typeof error === 'string') return { code: ErrorCode.Unknown, message: error };
    const message = typeof record['message'] === 'string' ? record['message'] : 'O utilitário privilegiado falhou.';
    return { code: ErrorCode.Unknown, message };
  } catch {
    return null;
  }
}

/** Extracts the limits array from a `--print-limits` payload. */
function parseLimits(value: unknown): HelperGpuLimits[] {
  if (!Array.isArray(value)) return [];
  const limits: HelperGpuLimits[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const uuid = typeof record['uuid'] === 'string' ? record['uuid'] : null;
    if (uuid === null) continue;
    const asNumber = (key: string): number | null => {
      const raw = record[key];
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    };
    limits.push({
      uuid,
      name: typeof record['name'] === 'string' ? record['name'] : null,
      minWatts: asNumber('minWatts'),
      defaultWatts: asNumber('defaultWatts'),
      maxWatts: asNumber('maxWatts'),
      currentWatts: asNumber('currentWatts'),
    });
  }
  return limits;
}

/** Talks to the privileged helper through pkexec. */
export class HelperClient {
  private readonly runner: ExecRunner;
  private readonly probe: FileProbe;
  private readonly timeoutMs: number;
  private readonly appRoot: string;
  private readonly explicitHelperPath: string | null;
  private readonly explicitPkexecPath: string | null;

  constructor(options: HelperClientOptions = {}) {
    this.runner = options.runner ?? nodeExecRunner;
    this.probe = options.probe ?? nodeFileProbe;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.appRoot = options.appRoot ?? defaultAppRoot();
    this.explicitHelperPath = options.helperPath ?? null;
    this.explicitPkexecPath = options.pkexecPath ?? null;
  }

  /** Absolute path of the installed helper, or null when it is missing. */
  locateHelper(): string | null {
    if (this.explicitHelperPath !== null) return this.explicitHelperPath;
    for (const candidate of helperCandidates(this.appRoot)) {
      if (this.probe.exists(candidate)) return candidate;
    }
    return null;
  }

  /** Absolute path of `pkexec`, or null when polkit is not available. */
  locatePkexec(): string | null {
    if (this.explicitPkexecPath !== null) return this.explicitPkexecPath;
    return findPkexec(this.probe);
  }

  /** Applies a power limit through the helper. */
  async setPowerLimit(uuid: string, watts: number): Promise<HelperOutcome> {
    const safeUuid = this.validateUuid(uuid);
    const safeWatts = this.validateWatts(watts);
    return this.invoke(['--uuid', safeUuid, '--watts', String(safeWatts)]);
  }

  /** Restores the factory default power limit through the helper. */
  async resetPowerLimit(uuid: string): Promise<HelperOutcome> {
    const safeUuid = this.validateUuid(uuid);
    return this.invoke(['--uuid', safeUuid, '--reset']);
  }

  /** Reads the live limits of every GPU (or of one GPU) through the helper. */
  async printLimits(uuid?: string): Promise<HelperOutcome> {
    const args = ['--print-limits'];
    if (uuid !== undefined) args.push('--uuid', this.validateUuid(uuid));
    return this.invoke(args);
  }

  private validateUuid(uuid: string): string {
    try {
      return assertGpuUuid(uuid);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw fail(ErrorCode.ValidationFailed, error.message, { detail: `Campo inválido: ${error.field}` });
      }
      throw error;
    }
  }

  private validateWatts(watts: number): number {
    try {
      return assertWatts(watts);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw fail(ErrorCode.ValidationFailed, error.message, { detail: `Campo inválido: ${error.field}` });
      }
      throw error;
    }
  }

  /**
   * Runs the helper and returns its parsed answer.
   *
   * Throws an `AppErrorException` for every failure so the caller can turn it
   * into a user facing result.
   */
  async invoke(args: readonly string[]): Promise<HelperOutcome> {
    const helper = this.locateHelper();
    if (helper === null) {
      throw fail(
        ErrorCode.PrivilegedHelperMissing,
        'O utilitário privilegiado não está instalado, portanto o limite de potência não pode ser alterado.',
        { detail: HELPER_INSTALL_INSTRUCTIONS },
      );
    }
    const pkexec = this.locatePkexec();
    if (pkexec === null) {
      throw fail(
        ErrorCode.AuthorizationUnavailable,
        'Este sistema não possui polkit (pkexec), necessário para alterar limites de potência com segurança.',
        { detail: 'Instale o pacote "polkit" ou "pkexec" e reinicie o aplicativo.' },
      );
    }

    let stdout: string;
    let stderr: string;
    try {
      // argv array, never a shell string: the arguments can not be interpreted
      // by a shell.
      const result = await this.runner.run(pkexec, [helper, ...args], { timeoutMs: this.timeoutMs });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      throw this.mapFailure(error);
    }

    return this.parseOutcome(stdout, stderr);
  }

  /** Translates a process failure into a domain error. */
  private mapFailure(error: unknown): AppErrorException {
    if (!(error instanceof ExecFailure)) {
      const appError: AppError = asAppError(error);
      return fail(appError.code, appError.message, { detail: appError.detail });
    }

    if (error.errno === 'ENOENT') {
      return fail(
        ErrorCode.AuthorizationUnavailable,
        'O comando pkexec não foi encontrado, portanto não é possível obter autorização para alterar o limite de potência.',
        { detail: 'Instale o pacote "polkit" (que fornece o pkexec) e tente novamente.' },
      );
    }

    if (error.timedOut) {
      return fail(
        ErrorCode.Timeout,
        `O utilitário privilegiado não respondeu a tempo (${this.timeoutMs} ms).`,
        { detail: 'Verifique se o driver NVIDIA está responsivo.' },
      );
    }

    // The helper prints a JSON error object even when it fails: prefer it,
    // it carries the precise reason.
    const helperError = parseHelperError(error.stdout);
    if (helperError !== null) {
      return fail(helperError.code, helperError.message);
    }

    const exitCode = error.exitCode;
    if (exitCode === 126) {
      // pkexec: the authorization dialog was dismissed by the user.
      return fail(ErrorCode.AuthorizationDenied, 'A autorização para alterar o limite de potência foi cancelada.', {
        cancelled: true,
        detail: error.stderr.trim().length > 0 ? error.stderr.trim() : undefined,
      });
    }
    if (exitCode === 127) {
      // pkexec: the authorization could not be obtained (no agent, denied, ...).
      return fail(
        ErrorCode.AuthorizationUnavailable,
        'Não foi possível obter autorização administrativa para alterar o limite de potência.',
        { detail: error.stderr.trim().length > 0 ? error.stderr.trim() : undefined },
      );
    }
    if (exitCode === 2) {
      return fail(ErrorCode.ValidationFailed, 'O utilitário rejeitou os dados informados (validação inválida).', {
        detail: error.stderr.trim().length > 0 ? error.stderr.trim() : undefined,
      });
    }
    if (exitCode === 3) {
      return fail(
        ErrorCode.UnsupportedByDriver,
        'Esta GPU ou este driver não suporta o ajuste do limite de potência.',
        { detail: error.stderr.trim().length > 0 ? error.stderr.trim() : undefined },
      );
    }
    if (exitCode === 4) {
      return fail(ErrorCode.CommandFailed, 'O driver NVIDIA recusou a alteração do limite de potência.', {
        detail: error.stderr.trim().length > 0 ? error.stderr.trim() : undefined,
      });
    }
    if (exitCode === 5) {
      return fail(
        ErrorCode.CommandFailed,
        'O comando foi executado, mas o driver não confirmou o novo limite de potência.',
        { detail: error.stderr.trim().length > 0 ? error.stderr.trim() : undefined },
      );
    }
    return fail(
      ErrorCode.CommandFailed,
      `O utilitário privilegiado falhou (código de saída ${exitCode ?? 'desconhecido'}).`,
      { detail: error.stderr.trim().length > 0 ? error.stderr.trim() : undefined },
    );
  }

  /** Parses the JSON document printed by the helper. */
  private parseOutcome(stdout: string, stderr: string): HelperOutcome {
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      throw fail(ErrorCode.CommandFailed, 'O utilitário privilegiado não produziu nenhuma resposta.', {
        detail: stderr.trim(),
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw fail(ErrorCode.CommandFailed, 'O utilitário privilegiado produziu uma resposta inválida.', {
        detail: trimmed.slice(0, 500),
      });
    }
    if (!parsed || typeof parsed !== 'object') {
      throw fail(ErrorCode.CommandFailed, 'O utilitário privilegiado produziu uma resposta inválida.');
    }
    const record = parsed as Record<string, unknown>;
    if (record['ok'] !== true) {
      const helperError = parseHelperError(trimmed);
      if (helperError !== null) throw fail(helperError.code, helperError.message);
      throw fail(ErrorCode.CommandFailed, 'O utilitário privilegiado falhou.');
    }
    const appliedWatts =
      typeof record['appliedWatts'] === 'number' && Number.isFinite(record['appliedWatts'])
        ? record['appliedWatts']
        : null;
    return {
      ok: true,
      uuid: typeof record['uuid'] === 'string' ? record['uuid'] : null,
      appliedWatts,
      verified: record['verified'] === true,
      limits: parseLimits(record['gpus']),
      raw: trimmed,
    };
  }
}
