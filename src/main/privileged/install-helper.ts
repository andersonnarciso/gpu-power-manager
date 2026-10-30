/**
 * Installer of the privileged helper and of the polkit policy.
 *
 * Both files are installed through `pkexec`, so polkit asks the user for
 * administrator authorization before anything is written.
 *
 * Security rules enforced here:
 *  - the helper always ends up owned by root, with mode 0755, inside a
 *    directory that only root can write to;
 *  - the polkit policy always ends up owned by root, with mode 0644;
 *  - after installing, the ownership and the mode are verified again and the
 *    installation is considered failed when they are wrong. A privileged
 *    binary that a normal user can rewrite would be a privilege escalation
 *    hole.
 */

import path from 'path';

import { ErrorCode, type AppError } from '../../shared/types';
import { asAppError } from './errors';
import { nodeExecRunner, type ExecRunner } from './exec';
import { defaultAppRoot } from './helper-client';
import { findPkexec, nodeFileProbe, type FileProbe } from './polkit';

/** Where the privileged helper is installed. */
export const HELPER_TARGET_PATH = '/usr/local/libexec/gpu-power-manager-helper';

/** Directory the helper is installed into. It must not be user writable. */
export const HELPER_TARGET_DIR = '/usr/local/libexec';

/** Where the polkit policy is installed. */
export const POLICY_TARGET_PATH = '/usr/share/polkit-1/actions/com.gpupowermanager.policy';

/** Path of the `install` core utility. */
export const INSTALL_CANDIDATES: readonly string[] = ['/usr/bin/install', '/bin/install'];

/** Path of the `rm` core utility. */
export const RM_CANDIDATES: readonly string[] = ['/usr/bin/rm', '/bin/rm'];

/** Expected ownership and mode of the installed helper. */
export const HELPER_EXPECTED_MODE = 0o755;

/** Expected ownership and mode of the installed policy. */
export const POLICY_EXPECTED_MODE = 0o644;

const DEFAULT_TIMEOUT_MS = 60_000;

export interface InstallHelperOptions {
  /** Executor used to spawn pkexec. */
  runner?: ExecRunner;
  /** Filesystem probe used to inspect and verify the installed files. */
  probe?: FileProbe;
  /** Root of the application (source checkout or `process.resourcesPath`). */
  appRoot?: string;
  /** Explicit path of the helper source file. */
  helperSourcePath?: string | null;
  /** Explicit path of the policy source file. */
  policySourcePath?: string | null;
  /** Explicit path of `pkexec`. */
  pkexecPath?: string | null;
  /** Explicit path of the `install` utility. */
  installPath?: string | null;
  /** Explicit path of the `rm` utility. */
  rmPath?: string | null;
  /** Destination of the helper. */
  helperTargetPath?: string;
  /** Destination of the policy file. */
  policyTargetPath?: string;
  /** Timeout applied to every privileged command. */
  timeoutMs?: number;
}

/** One step of the installation, reported back to the user interface. */
export interface InstallStep {
  label: string;
  ok: boolean;
  detail: string;
}

export interface InstallReport {
  ok: boolean;
  steps: InstallStep[];
  error?: AppError;
}

/** Candidate locations of the helper source file. */
export function helperSourceCandidates(appRoot: string): string[] {
  return [
    path.join(appRoot, 'helper', 'gpu-power-manager-helper.py'),
    path.join(appRoot, 'resources', 'helper', 'gpu-power-manager-helper.py'),
    path.join(appRoot, 'helper', 'gpu-power-manager-helper'),
  ];
}

/** Candidate locations of the polkit policy source file. */
export function policySourceCandidates(appRoot: string): string[] {
  return [
    path.join(appRoot, 'resources', 'polkit', 'com.gpupowermanager.policy'),
    path.join(appRoot, 'polkit', 'com.gpupowermanager.policy'),
  ];
}

function firstExisting(candidates: readonly string[], probe: FileProbe): string | null {
  for (const candidate of candidates) {
    if (probe.exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Checks that a privileged file has the expected owner and mode.
 *
 * Returns an error message when the file is unsafe, null when it is fine.
 */
export function describeOwnershipProblem(
  stats: { uid: number; mode: number; isFile: boolean } | null,
  expectedMode: number,
  label: string,
): string | null {
  if (stats === null) return `${label} não existe após a instalação.`;
  if (!stats.isFile) return `${label} não é um arquivo regular.`;
  if (stats.uid !== 0) {
    return `${label} não pertence ao root (uid ${stats.uid}). Um arquivo privilegiado editável pelo usuário seria uma escalada de privilégio.`;
  }
  if (stats.mode !== expectedMode) {
    const expected = expectedMode.toString(8).padStart(4, '0');
    const found = stats.mode.toString(8).padStart(4, '0');
    return `${label} está com modo ${found}, mas o modo seguro exigido é ${expected}.`;
  }
  return null;
}

/**
 * Checks that a directory can not be written by anybody but root.
 *
 * Returns an error message when the directory is unsafe, null when it is fine.
 */
export function describeDirectoryProblem(
  stats: { uid: number; mode: number; isDirectory: boolean } | null,
  label: string,
): string | null {
  if (stats === null) return `${label} não existe.`;
  if (!stats.isDirectory) return `${label} não é um diretório.`;
  if (stats.uid !== 0) return `${label} não pertence ao root (uid ${stats.uid}).`;
  if ((stats.mode & 0o022) !== 0) {
    const found = stats.mode.toString(8).padStart(4, '0');
    return `${label} é gravável por outros usuários (modo ${found}).`;
  }
  return null;
}

/**
 * Installs the privileged helper and the polkit policy.
 *
 * The operation is idempotent: running it twice leaves the system in the same
 * state and reports what happened on every step.
 */
export async function installHelper(options: InstallHelperOptions = {}): Promise<InstallReport> {
  const runner = options.runner ?? nodeExecRunner;
  const probe = options.probe ?? nodeFileProbe;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const appRoot = options.appRoot ?? resolveAppRoot();
  const helperTarget = options.helperTargetPath ?? HELPER_TARGET_PATH;
  const policyTarget = options.policyTargetPath ?? POLICY_TARGET_PATH;
  const steps: InstallStep[] = [];

  const pkexec = options.pkexecPath ?? findPkexec(probe);
  if (pkexec === null) {
    return {
      ok: false,
      steps,
      error: {
        code: ErrorCode.AuthorizationUnavailable,
        message: 'Este sistema não possui polkit (pkexec), necessário para instalar o utilitário privilegiado.',
        detail: 'Instale o pacote "polkit" (que fornece o pkexec) e tente novamente.',
      },
    };
  }

  const helperSource = options.helperSourcePath ?? firstExisting(helperSourceCandidates(appRoot), probe);
  if (helperSource === null || !probe.exists(helperSource)) {
    return {
      ok: false,
      steps,
      error: {
        code: ErrorCode.PrivilegedHelperMissing,
        message: 'O arquivo do utilitário privilegiado não foi encontrado na instalação do aplicativo.',
        detail: `Procurado em: ${helperSourceCandidates(appRoot).join(', ')}`,
      },
    };
  }

  const policySource = options.policySourcePath ?? firstExisting(policySourceCandidates(appRoot), probe);
  if (policySource === null || !probe.exists(policySource)) {
    return {
      ok: false,
      steps,
      error: {
        code: ErrorCode.PrivilegedHelperMissing,
        message: 'O arquivo de política do polkit não foi encontrado na instalação do aplicativo.',
        detail: `Procurado em: ${policySourceCandidates(appRoot).join(', ')}`,
      },
    };
  }

  const installPath = options.installPath ?? firstExisting(INSTALL_CANDIDATES, probe);
  if (installPath === null) {
    return {
      ok: false,
      steps,
      error: {
        code: ErrorCode.CommandFailed,
        message: 'O utilitário "install" do sistema não foi encontrado, portanto a instalação não pode continuar.',
      },
    };
  }

  const targetDir = path.dirname(helperTarget);
  const dirProblem = describeDirectoryProblem(probe.stat(targetDir), `O diretório ${targetDir}`);
  if (dirProblem !== null) {
    return {
      ok: false,
      steps,
      error: {
        code: ErrorCode.PermissionDenied,
        message: `Não é seguro instalar o utilitário privilegiado em ${targetDir}.`,
        detail: dirProblem,
      },
    };
  }

  // 1. The helper itself.
  const helperExisted = probe.exists(helperTarget);
  const helperStep = await runInstall(
    runner,
    pkexec,
    installPath,
    helperSource,
    helperTarget,
    HELPER_EXPECTED_MODE,
    timeoutMs,
  );
  steps.push({
    label: 'Utilitário privilegiado',
    ok: helperStep.ok,
    detail: helperStep.ok
      ? helperExisted
        ? `Atualizado em ${helperTarget} (root, modo 0755).`
        : `Instalado em ${helperTarget} (root, modo 0755).`
      : helperStep.detail,
  });
  if (!helperStep.ok) {
    return { ok: false, steps, error: helperStep.error };
  }

  const helperProblem = describeOwnershipProblem(
    probe.stat(helperTarget),
    HELPER_EXPECTED_MODE,
    `O utilitário privilegiado ${helperTarget}`,
  );
  if (helperProblem !== null) {
    await removeQuietly(runner, pkexec, options, helperTarget, timeoutMs);
    steps.push({ label: 'Verificação de segurança', ok: false, detail: helperProblem });
    return {
      ok: false,
      steps,
      error: {
        code: ErrorCode.PermissionDenied,
        message: 'A instalação do utilitário privilegiado foi recusada porque as permissões do arquivo não são seguras.',
        detail: helperProblem,
      },
    };
  }
  steps.push({
    label: 'Verificação de segurança',
    ok: true,
    detail: `O utilitário privilegiado pertence ao root e está com o modo 0755.`,
  });

  // 2. The polkit policy.
  const policyExisted = probe.exists(policyTarget);
  const policyStep = await runInstall(
    runner,
    pkexec,
    installPath,
    policySource,
    policyTarget,
    POLICY_EXPECTED_MODE,
    timeoutMs,
  );
  steps.push({
    label: 'Política do polkit',
    ok: policyStep.ok,
    detail: policyStep.ok
      ? policyExisted
        ? `Atualizada em ${policyTarget} (root, modo 0644).`
        : `Instalada em ${policyTarget} (root, modo 0644).`
      : policyStep.detail,
  });
  if (!policyStep.ok) {
    return { ok: false, steps, error: policyStep.error };
  }

  const policyProblem = describeOwnershipProblem(
    probe.stat(policyTarget),
    POLICY_EXPECTED_MODE,
    `A política do polkit ${policyTarget}`,
  );
  if (policyProblem !== null) {
    await removeQuietly(runner, pkexec, options, policyTarget, timeoutMs);
    steps.push({ label: 'Verificação da política', ok: false, detail: policyProblem });
    return {
      ok: false,
      steps,
      error: {
        code: ErrorCode.PermissionDenied,
        message: 'A instalação da política do polkit foi recusada porque as permissões do arquivo não são seguras.',
        detail: policyProblem,
      },
    };
  }
  steps.push({
    label: 'Verificação da política',
    ok: true,
    detail: 'A política do polkit pertence ao root e está com o modo 0644.',
  });

  return { ok: true, steps };
}

/**
 * Removes the privileged helper and the polkit policy, restoring the system to
 * the state it was in before the installation.
 */
export async function uninstallHelper(options: InstallHelperOptions = {}): Promise<InstallReport> {
  const runner = options.runner ?? nodeExecRunner;
  const probe = options.probe ?? nodeFileProbe;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const helperTarget = options.helperTargetPath ?? HELPER_TARGET_PATH;
  const policyTarget = options.policyTargetPath ?? POLICY_TARGET_PATH;
  const steps: InstallStep[] = [];

  const pkexec = options.pkexecPath ?? findPkexec(probe);
  if (pkexec === null) {
    return {
      ok: false,
      steps,
      error: {
        code: ErrorCode.AuthorizationUnavailable,
        message: 'Este sistema não possui polkit (pkexec), necessário para remover o utilitário privilegiado.',
      },
    };
  }

  const rmPath = options.rmPath ?? firstExisting(RM_CANDIDATES, probe);
  if (rmPath === null) {
    return {
      ok: false,
      steps,
      error: {
        code: ErrorCode.CommandFailed,
        message: 'O utilitário "rm" do sistema não foi encontrado, portanto a remoção não pode continuar.',
      },
    };
  }

  for (const target of [helperTarget, policyTarget]) {
    if (!probe.exists(target)) {
      steps.push({ label: target, ok: true, detail: 'Já não estava instalado.' });
      continue;
    }
    try {
      await runner.run(pkexec, [rmPath, '-f', target], { timeoutMs });
    } catch (error) {
      const appError: AppError = asAppError(error);
      steps.push({ label: target, ok: false, detail: appError.message });
      return {
        ok: false,
        steps,
        error: {
          code: ErrorCode.CommandFailed,
          message: `Não foi possível remover ${target}.`,
          detail: appError.detail ?? appError.message,
        },
      };
    }
    const stillThere = probe.exists(target);
    steps.push({
      label: target,
      ok: !stillThere,
      detail: stillThere ? 'O arquivo continua presente após a remoção.' : 'Removido com sucesso.',
    });
    if (stillThere) {
      return {
        ok: false,
        steps,
        error: {
          code: ErrorCode.CommandFailed,
          message: `A remoção de ${target} não foi concluída.`,
        },
      };
    }
  }

  return { ok: true, steps };
}

interface InstallOutcome {
  ok: boolean;
  detail: string;
  error?: AppError;
}

async function runInstall(
  runner: ExecRunner,
  pkexec: string,
  installPath: string,
  source: string,
  target: string,
  mode: number,
  timeoutMs: number,
): Promise<InstallOutcome> {
  try {
    // argv array: no shell is involved, so no path can be interpreted.
    await runner.run(
      pkexec,
      [installPath, '-o', 'root', '-g', 'root', '-m', mode.toString(8).padStart(4, '0'), source, target],
      { timeoutMs },
    );
    return { ok: true, detail: `Instalado em ${target}.` };
  } catch (error) {
    const appError: AppError = asAppError(error);
    return {
      ok: false,
      detail: appError.detail ?? appError.message,
      error: {
        code: ErrorCode.CommandFailed,
        message: `Não foi possível instalar ${target}.`,
        detail: appError.detail ?? appError.message,
      },
    };
  }
}

async function removeQuietly(
  runner: ExecRunner,
  pkexec: string,
  options: InstallHelperOptions,
  target: string,
  timeoutMs: number,
): Promise<void> {
  const probe = options.probe ?? nodeFileProbe;
  const rmPath = options.rmPath ?? firstExisting(RM_CANDIDATES, probe);
  if (rmPath === null) return;
  try {
    await runner.run(pkexec, [rmPath, '-f', target], { timeoutMs });
  } catch {
    // Best effort cleanup: the original error is the one that matters.
  }
}

/** Root of the installation (source checkout or `process.resourcesPath`). */
export function resolveAppRoot(): string {
  return defaultAppRoot();
}
