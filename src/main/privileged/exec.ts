/**
 * Thin, injectable wrapper around `child_process.execFile`.
 *
 * Hard rules enforced by this module:
 *  - a program is ALWAYS executed with an argv array, never with a shell
 *    string, so no shell metacharacter coming from the user can ever be
 *    interpreted;
 *  - every call has a timeout, so a stuck helper can never hang the app.
 */

import { execFile } from 'child_process';

export interface ExecOptions {
  /** Hard timeout in milliseconds. The child is killed when it expires. */
  timeoutMs: number;
  /** Maximum amount of captured output in bytes. */
  maxBufferBytes?: number;
  /** Working directory of the child process. */
  cwd?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecRunner {
  run(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult>;
}

/** Failure raised by `ExecRunner` when the child could not be run or failed. */
export class ExecFailure extends Error {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** POSIX error code such as `ENOENT`, or null when the process did run. */
  readonly errno: string | null;
  readonly timedOut: boolean;

  constructor(
    message: string,
    details: {
      exitCode: number | null;
      stdout: string;
      stderr: string;
      errno: string | null;
      timedOut: boolean;
    },
  ) {
    super(message);
    this.name = 'ExecFailure';
    this.exitCode = details.exitCode;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
    this.errno = details.errno;
    this.timedOut = details.timedOut;
  }
}

const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

/** Real implementation backed by `child_process.execFile`. */
export const nodeExecRunner: ExecRunner = {
  run(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      // `execFile` never spawns a shell: the program and every argument are
      // handed to execve(2) as separate entries of the argv array.
      execFile(
        file,
        [...args],
        {
          timeout: options.timeoutMs,
          maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
          encoding: 'utf8',
          windowsHide: true,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout, stderr, exitCode: 0 });
            return;
          }
          const err = error as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: NodeJS.Signals | null;
            code?: number | string;
          };
          const timedOut = err.killed === true;
          const errno = typeof err.code === 'string' ? err.code : null;
          const exitCode = typeof err.code === 'number' ? err.code : null;
          reject(
            new ExecFailure(
              timedOut
                ? `Tempo esgotado ao executar ${file}.`
                : `Falha ao executar ${file}.`,
              { exitCode, stdout, stderr, errno, timedOut },
            ),
          );
        },
      );
    });
  },
};
