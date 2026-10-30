/**
 * Boot persistence through systemd.
 *
 * The manager installs (and removes) everything the operating system needs to
 * apply a power profile **before** the desktop session starts:
 *
 *   /etc/systemd/system/gpu-power-manager-persist.service   the unit
 *   /usr/local/lib/gpu-power-manager/gpu-power-manager-apply.py  the helper
 *   /usr/share/polkit-1/actions/com.gpupowermanager.policy
 *   /var/lib/gpu-power-manager/profile.json                   the payload
 *
 * Every privileged operation goes through `pkexec` with an **argv array**:
 * no shell is involved, so nothing the user types can be interpreted as a
 * command. `pkexec` asks the administrator for the password through polkit;
 * passwordless sudo is never required.
 *
 * The unit does not depend on the Electron application: it only runs the
 * Python helper, which talks to `nvidia-smi` directly.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

import {
  ErrorCode,
  type AppError,
  type OperationResult,
  type PersistenceStatus,
} from '../../shared/types';
import type { PersistenceService } from '../../shared/contracts';
import { toAppError } from '../../shared/validation';
import {
  APPLY_SCRIPT_FILE_NAME,
  APPLY_STATE_FILE_NAME,
  DEFAULT_NVIDIA_SMI_PATH,
  DEFAULT_SCRIPT_PATH,
  DEFAULT_STATE_DIR,
  DEFAULT_STATE_FILE,
  type ApplyPayload,
} from './apply-script';
import { CommandError, runExecFile, type ExecFileRunner } from './exec-file';

export const UNIT_NAME = 'gpu-power-manager-persist.service';
export const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}`;
export const SCRIPT_DIR = '/usr/local/lib/gpu-power-manager';
/**
 * The application ships a **single** polkit policy file that declares every
 * action it needs (power limit, helper installation and persistence). Sharing
 * one file avoids two installers fighting over two policy files with
 * confusing names.
 */
export const POLICY_FILE_NAME = 'com.gpupowermanager.policy';
export const POLICY_PATH = `/usr/share/polkit-1/actions/${POLICY_FILE_NAME}`;
export const POLKIT_ACTION_ID = 'com.gpupowermanager.manage-persistence';

export const DEFAULT_PKEXEC_PATH = '/usr/bin/pkexec';
export const DEFAULT_SYSTEMCTL_PATH = '/usr/bin/systemctl';

/* ------------------------------------------------------------------- payload */

/** Builds the payload that is written to the root owned state directory. */
export interface PersistencePayloadProvider {
  buildPayload(profileId: string): Promise<ApplyPayload>;
}

/* ------------------------------------------------------------------- system */

export interface SystemdAvailability {
  available: boolean;
  /** User readable explanation, empty when systemd is available. */
  message: string;
}

export interface SystemdManagerOptions {
  unitName?: string;
  unitPath?: string;
  scriptPath?: string;
  scriptDir?: string;
  policyPath?: string;
  stateDir?: string;
  stateFile?: string;
  /** Folder that holds the shipped unit, helper and polkit policy. */
  resourcesDir?: string;
  pkexecPath?: string;
  systemctlPath?: string;
  nvidiaSmiPath?: string;
  /** Builds the payload persisted in the state directory. Injected. */
  payloadProvider: PersistencePayloadProvider;
  now?: () => number;
  /** Command runner. Injectable for the tests. */
  exec?: ExecFileRunner;
  /** Detection of systemd. Injectable for the tests. */
  systemdProbe?: () => Promise<SystemdAvailability>;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Finds the first existing candidate, so the tool works on every layout. */
export function resolveToolPath(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    try {
      fsSync.accessSync(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return candidates[0] ?? '';
}

/** Locates the shipped `resources/systemd` folder. */
export function resolveResourcesDir(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') {
    return explicit;
  }
  const candidates: string[] = [];
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    candidates.push(path.join(process.resourcesPath, 'systemd'));
  }
  candidates.push(path.join(__dirname, '..', '..', '..', 'resources', 'systemd'));
  for (const candidate of candidates) {
    try {
      fsSync.accessSync(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return candidates[candidates.length - 1] ?? '';
}

/* --------------------------------------------------------------------- unit */

export interface ServiceUnitOptions {
  unitName: string;
  scriptPath: string;
  stateFile: string;
}

/**
 * Renders the systemd unit.
 *
 * The rendered content is the content of
 * `resources/systemd/gpu-power-manager-persist.service`; the unit test keeps
 * both in sync.
 */
export function renderServiceUnit(options: ServiceUnitOptions): string {
  return `[Unit]
Description=GPU Power Manager - aplicação dos limites de potência no boot
Documentation=man:nvidia-smi(1)
After=network.target systemd-modules-load.service nvidia-persistenced.service
Wants=network.target
ConditionPathExists=${options.stateFile}

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${options.scriptPath}
StandardOutput=journal
StandardError=journal
Restart=no
TimeoutStartSec=180
Nice=10

[Install]
WantedBy=multi-user.target
`;
}

/* ------------------------------------------------------------------ manager */

export class SystemdManager implements PersistenceService {
  private readonly unitName: string;
  private readonly unitPath: string;
  private readonly scriptPath: string;
  private readonly scriptDir: string;
  private readonly policyPath: string;
  private readonly stateDir: string;
  private readonly stateFile: string;
  private readonly resourcesDir: string;
  private readonly pkexecPath: string;
  private readonly systemctlPath: string;
  private readonly payloadProvider: PersistencePayloadProvider;
  private readonly now: () => number;
  private readonly exec: ExecFileRunner;
  private readonly systemdProbe: () => Promise<SystemdAvailability>;

  constructor(options: SystemdManagerOptions) {
    this.unitName = options.unitName ?? UNIT_NAME;
    this.unitPath = options.unitPath ?? UNIT_PATH;
    this.scriptPath = options.scriptPath ?? DEFAULT_SCRIPT_PATH;
    this.scriptDir = options.scriptDir ?? path.dirname(this.scriptPath);
    this.policyPath = options.policyPath ?? POLICY_PATH;
    this.stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
    this.stateFile = options.stateFile ?? DEFAULT_STATE_FILE;
    this.resourcesDir = resolveResourcesDir(options.resourcesDir);
    this.pkexecPath = options.pkexecPath ?? DEFAULT_PKEXEC_PATH;
    this.systemctlPath = options.systemctlPath ?? DEFAULT_SYSTEMCTL_PATH;
    this.payloadProvider = options.payloadProvider;
    this.now = options.now ?? Date.now;
    this.exec = options.exec ?? runExecFile;
    this.systemdProbe = options.systemdProbe ?? (() => detectSystemd(this.systemctlPath));
  }

  /* ------------------------------------------------------------ detection */

  /** Checks whether this machine can persist anything at boot. */
  async checkSystemd(): Promise<SystemdAvailability> {
    return this.systemdProbe();
  }

  /* --------------------------------------------------------------- status */

  async status(): Promise<PersistenceStatus> {
    const unitExists = await pathExists(this.unitPath);
    const helperExists = await pathExists(this.scriptPath);
    const policyExists = await pathExists(this.policyPath);

    let enabled = false;
    if (unitExists) {
      try {
        const result = await this.exec(this.systemctlPath, ['is-enabled', this.unitName], {
          timeoutMs: 15_000,
        });
        enabled = result.stdout.trim().startsWith('enabled');
      } catch {
        enabled = false;
      }
    }

    const state = await this.readStateFile();

    return {
      installed: unitExists && helperExists,
      enabled,
      unitPath: this.unitPath,
      profileId: state?.profileId ?? null,
      lastAppliedAt: state?.lastAppliedAt ?? null,
      lastError: state?.lastError ?? null,
      polkitInstalled: policyExists,
      helperInstalled: helperExists,
    };
  }

  private async readStateFile(): Promise<ApplyPayload | null> {
    try {
      const raw = await fs.readFile(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ApplyPayload>;
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }
      return {
        version: typeof parsed.version === 'number' ? parsed.version : 0,
        profileId: typeof parsed.profileId === 'string' ? parsed.profileId : '',
        profileName: typeof parsed.profileName === 'string' ? parsed.profileName : '',
        builtin: parsed.builtin === true,
        installedAt: typeof parsed.installedAt === 'number' ? parsed.installedAt : 0,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        lastAppliedAt: typeof parsed.lastAppliedAt === 'number' ? parsed.lastAppliedAt : null,
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      };
    } catch {
      return null;
    }
  }

  /* -------------------------------------------------------------- install */

  async install(profileId: string): Promise<OperationResult> {
    const availability = await this.checkSystemd();
    if (!availability.available) {
      return {
        ok: false,
        error: {
          code: ErrorCode.AdapterUnavailable,
          message: availability.message,
        },
      };
    }

    let payload: ApplyPayload;
    try {
      payload = await this.payloadProvider.buildPayload(profileId);
    } catch (error) {
      const appError = toAppError(error);
      return {
        ok: false,
        error: {
          code: appError.code,
          message: `Não foi possível preparar o perfil para a inicialização: ${appError.message}`,
          detail: appError.detail,
        },
      };
    }

    const payloadError = validatePayload(payload);
    if (payloadError !== null) {
      return { ok: false, error: payloadError };
    }

    let stagingDir: string;
    try {
      stagingDir = await fs.mkdtemp(path.join(tmpdir(), 'gpu-pm-'));
    } catch (error) {
      return {
        ok: false,
        error: {
          code: ErrorCode.PersistenceFailed,
          message: 'Não foi possível criar a pasta temporária para a instalação.',
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }

    try {
      const stagedUnit = path.join(stagingDir, this.unitName);
      const stagedScript = path.join(stagingDir, APPLY_SCRIPT_FILE_NAME);
      const stagedPolicy = path.join(stagingDir, POLICY_FILE_NAME);
      const stagedPayload = path.join(stagingDir, APPLY_STATE_FILE_NAME);

      const unit = renderServiceUnit({
        unitName: this.unitName,
        scriptPath: this.scriptPath,
        stateFile: this.stateFile,
      });

      await fs.writeFile(stagedUnit, unit, { encoding: 'utf8', mode: 0o644 });
      await fs.writeFile(stagedScript, await this.readHelperScript(), {
        encoding: 'utf8',
        mode: 0o755,
      });
      await fs.writeFile(stagedPolicy, await this.readPolicyFile(), {
        encoding: 'utf8',
        mode: 0o644,
      });
      await fs.writeFile(stagedPayload, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o644,
      });

      const installTool = resolveToolPath(['/usr/bin/install', '/bin/install']);

      const steps: Array<{ args: string[]; what: string }> = [
        {
          args: [installTool, '-d', '-m', '0755', '-o', 'root', '-g', 'root', this.stateDir],
          what: 'criar a pasta de estado',
        },
        {
          args: [installTool, '-d', '-m', '0755', '-o', 'root', '-g', 'root', this.scriptDir],
          what: 'criar a pasta do utilitário',
        },
        {
          args: [
            installTool,
            '-m',
            '0644',
            '-o',
            'root',
            '-g',
            'root',
            stagedUnit,
            this.unitPath,
          ],
          what: 'instalar o serviço do systemd',
        },
        {
          args: [
            installTool,
            '-m',
            '0755',
            '-o',
            'root',
            '-g',
            'root',
            stagedScript,
            this.scriptPath,
          ],
          what: 'instalar o utilitário de aplicação',
        },
        {
          args: [
            installTool,
            '-m',
            '0644',
            '-o',
            'root',
            '-g',
            'root',
            stagedPolicy,
            this.policyPath,
          ],
          what: 'instalar a política do polkit',
        },
        {
          args: [
            installTool,
            '-m',
            '0644',
            '-o',
            'root',
            '-g',
            'root',
            stagedPayload,
            this.stateFile,
          ],
          what: 'gravar o perfil na pasta de estado',
        },
        {
          args: [this.systemctlPath, 'daemon-reload'],
          what: 'recarregar o systemd',
        },
        {
          args: [this.systemctlPath, 'enable', '--now', this.unitName],
          what: 'ativar o serviço na inicialização',
        },
      ];

      for (const step of steps) {
        const result = await this.privileged(step.args, step.what);
        if (!result.ok) {
          return { ok: false, error: result.error };
        }
      }

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: ErrorCode.PersistenceFailed,
          message: 'Não foi possível instalar a persistência na inicialização.',
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readHelperScript(): Promise<string> {
    const source = path.join(this.resourcesDir, APPLY_SCRIPT_FILE_NAME);
    return fs.readFile(source, 'utf8');
  }

  private async readPolicyFile(): Promise<string> {
    // The policy lives in the sibling `polkit` folder: `resources/polkit` in
    // the repository and `<resourcesPath>/polkit` in a packaged app.
    const candidates = [
      path.join(this.resourcesDir, '..', 'polkit', POLICY_FILE_NAME),
      path.join(this.resourcesDir, POLICY_FILE_NAME),
    ];
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        return await fs.readFile(candidate, 'utf8');
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Política do polkit não encontrada em ${candidates.join(', ')}.`);
  }

  /* ------------------------------------------------------------ uninstall */

  async uninstall(): Promise<OperationResult> {
    const availability = await this.checkSystemd();
    if (!availability.available) {
      return {
        ok: false,
        error: {
          code: ErrorCode.AdapterUnavailable,
          message: availability.message,
        },
      };
    }

    const removeTool = resolveToolPath(['/usr/bin/rm', '/bin/rm']);
    const rmdirTool = resolveToolPath(['/usr/bin/rmdir', '/bin/rmdir']);

    const steps: Array<{ args: string[]; what: string; optional?: boolean }> = [
      {
        args: [this.systemctlPath, 'disable', '--now', this.unitName],
        what: 'desativar o serviço na inicialização',
        optional: true,
      },
      {
        args: [
          removeTool,
          '-f',
          this.unitPath,
          this.scriptPath,
          this.policyPath,
          this.stateFile,
        ],
        what: 'remover os arquivos instalados',
      },
      {
        args: [rmdirTool, this.scriptDir, this.stateDir],
        what: 'remover as pastas de instalação',
        optional: true,
      },
      {
        args: [this.systemctlPath, 'daemon-reload'],
        what: 'recarregar o systemd',
      },
    ];

    let firstError: AppError | null = null;

    for (const step of steps) {
      const result = await this.privileged(step.args, step.what);
      if (!result.ok && firstError === null) {
        firstError = result.error;
      }
    }

    if (firstError !== null) {
      return { ok: false, error: firstError };
    }
    return { ok: true };
  }

  /* -------------------------------------------------------------- enable */

  async setEnabled(enabled: boolean): Promise<OperationResult> {
    const availability = await this.checkSystemd();
    if (!availability.available) {
      return {
        ok: false,
        error: {
          code: ErrorCode.AdapterUnavailable,
          message: availability.message,
        },
      };
    }

    const args = enabled
      ? [this.systemctlPath, 'enable', '--now', this.unitName]
      : [this.systemctlPath, 'disable', this.unitName];

    const result = await this.privileged(
      args,
      enabled ? 'ativar o serviço na inicialização' : 'desativar o serviço na inicialização',
    );
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true };
  }

  /* ------------------------------------------------------------ apply now */

  async applyNow(): Promise<OperationResult> {
    const availability = await this.checkSystemd();
    if (!availability.available) {
      return {
        ok: false,
        error: {
          code: ErrorCode.AdapterUnavailable,
          message: availability.message,
        },
      };
    }

    const installed = await pathExists(this.unitPath);
    if (!installed) {
      return {
        ok: false,
        error: {
          code: ErrorCode.PersistenceFailed,
          message: 'A persistência na inicialização ainda não foi instalada.',
          detail: 'Instale a persistência antes de aplicar o perfil manualmente.',
        },
      };
    }

    const result = await this.privileged(
      [this.systemctlPath, 'restart', this.unitName],
      'aplicar o perfil agora',
    );
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true };
  }

  /* -------------------------------------------------------------- helpers */

  private async privileged(
    args: string[],
    what: string,
  ): Promise<{ ok: true } | { ok: false; error: AppError }> {
    try {
      await this.exec(this.pkexecPath, args, { timeoutMs: 120_000 });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: this.toCommandError(what, error) };
    }
  }

  private toCommandError(what: string, error: unknown): AppError {
    const stderr = error instanceof CommandError ? error.stderr.trim() : '';
    const exitCode = error instanceof CommandError ? error.exitCode : null;
    const cancelled = exitCode === 126;

    let code: string = ErrorCode.CommandFailed;
    if (cancelled) {
      code = ErrorCode.AuthorizationDenied;
    } else if (/not authorized|permission denied|authentication/i.test(stderr)) {
      code = ErrorCode.PermissionDenied;
    }

    const message = cancelled
      ? `A autorização do sistema foi cancelada e não foi possível ${what}.`
      : `Não foi possível ${what}. Execute novamente e autorize a solicitação do sistema.`;

    const detail =
      stderr !== ''
        ? stderr
        : error instanceof Error
          ? error.message
          : String(error);

    const appError: AppError = { code, message, detail };
    if (cancelled) {
      appError.cancelled = true;
    }
    return appError;
  }
}

/* --------------------------------------------------------------- detection */

/** Detects whether this machine can persist a unit at boot. */
export async function detectSystemd(systemctlPath: string): Promise<SystemdAvailability> {
  let pid1 = '';
  try {
    pid1 = (await fs.readFile('/proc/1/comm', 'utf8')).trim();
  } catch {
    pid1 = '';
  }

  if (pid1 !== '' && pid1 !== 'systemd') {
    return {
      available: false,
      message:
        `Este computador não usa systemd (o processo inicial é "${pid1}"), ` +
        'portanto a aplicação de limites no boot não está disponível.',
    };
  }

  if (!(await pathExists(systemctlPath))) {
    return {
      available: false,
      message:
        `O comando systemctl não foi encontrado em ${systemctlPath}. ` +
        'A persistência na inicialização exige uma distribuição com systemd.',
    };
  }

  try {
    await runExecFile(systemctlPath, ['--version'], { timeoutMs: 10_000 });
  } catch (error) {
    return {
      available: false,
      message:
        'O systemd não respondeu a "systemctl --version". ' +
        'A persistência na inicialização não está disponível neste sistema.',
    };
  }

  return { available: true, message: '' };
}

/** Validates the payload before it is written to the root owned state folder. */
export function validatePayload(payload: ApplyPayload): AppError | null {
  if (typeof payload !== 'object' || payload === null) {
    return {
      code: ErrorCode.ValidationFailed,
      message: 'O conteúdo do perfil é inválido.',
    };
  }
  if (typeof payload.profileId !== 'string' || payload.profileId.trim() === '') {
    return {
      code: ErrorCode.ValidationFailed,
      message: 'O perfil não tem um identificador válido.',
    };
  }
  if (!Array.isArray(payload.entries)) {
    return {
      code: ErrorCode.ValidationFailed,
      message: 'O perfil não tem a lista de GPUs.',
    };
  }

  for (const entry of payload.entries) {
    if (!/^GPU-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(entry.uuid)) {
      return {
        code: ErrorCode.ValidationFailed,
        message: `O identificador da GPU "${entry.uuid}" é inválido.`,
      };
    }
    if (entry.watts !== null && (!Number.isInteger(entry.watts) || entry.watts <= 0)) {
      return {
        code: ErrorCode.ValidationFailed,
        message: `O limite de potência da GPU ${entry.uuid} é inválido.`,
      };
    }
  }

  return null;
}
