/**
 * Promise wrapper around `child_process.execFile`.
 *
 * Every external command of the persistence layer goes through here:
 *  - the command is always given as an **argv array**, never as a shell
 *    string, so no user input can ever be interpreted by a shell;
 *  - `shell` is explicitly disabled;
 *  - the standard error of the command is preserved, because the messages of
 *    `systemctl` and `nvidia-smi` are what the user needs to see.
 */

import { execFile } from 'node:child_process';

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export interface ExecFileOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Written to the standard input of the process. */
  input?: string;
}

export type ExecFileRunner = (
  file: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<ExecFileResult>;

/** Error thrown when a command exits with a non zero status. */
export class CommandError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly command: string;

  constructor(command: string, exitCode: number | null, stdout: string, stderr: string) {
    super(stderr.trim() !== '' ? stderr.trim() : `O comando "${command}" falhou.`);
    this.name = 'CommandError';
    this.command = command;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export function describeCommand(file: string, args: string[]): string {
  return [file, ...args].join(' ');
}

/** Runs a command and resolves with its output. Rejects with `CommandError`. */
export const runExecFile: ExecFileRunner = (file, args, options) =>
  new Promise<ExecFileResult>((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        encoding: 'utf8',
        shell: false,
        timeout: options.timeoutMs,
        env: options.env,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const out = stdout ?? '';
        const err = stderr ?? '';

        if (error) {
          const exitCode =
            typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
              ? ((error as NodeJS.ErrnoException & { code: number }).code as number)
              : null;
          reject(new CommandError(describeCommand(file, args), exitCode, out, err));
          return;
        }

        resolve({ stdout: out, stderr: err });
      },
    );

    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    }
  });
