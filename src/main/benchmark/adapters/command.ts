/**
 * Runs an external command without a shell.
 *
 * The command and its arguments are always passed as an argv array, so a
 * value coming from the settings can never be interpreted as shell syntax.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  /** Hard timeout in milliseconds. */
  timeoutMs: number;
  /** Abort signal, used to stop a running benchmark. */
  signal?: AbortSignal;
  /** Maximum size of the captured output. */
  maxBuffer?: number;
  /** Working directory of the command. */
  cwd?: string;
}

/** Executes a command and resolves with its output. */
export function runCommand(
  file: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs,
        signal: options.signal,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        cwd: options.cwd,
        encoding: 'utf8',
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
}

/**
 * Looks for an executable in the PATH.
 *
 * Returns the absolute path of the first match, or null.
 */
export function findExecutable(name: string): string | null {
  if (!name || name.length === 0) return null;
  if (name.includes('/')) {
    return isExecutableFile(name) ? name : null;
  }

  const rawPath = process.env.PATH ?? '';
  const separator = process.platform === 'win32' ? ';' : ':';
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
      : [''];

  for (const dir of rawPath.split(separator)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = `${dir}/${name}${extension}`;
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
