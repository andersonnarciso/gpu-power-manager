/**
 * Atomic JSON file helpers.
 *
 * "Atomic" means: the new content is written to a temporary file inside the
 * SAME directory as the destination and then renamed over it. `rename(2)` is
 * atomic within a filesystem, so a crash, a full disk or a killed process can
 * never leave a truncated JSON file behind: a reader either sees the previous
 * version or the new one, never a half written file.
 *
 * The temporary file is removed when the rename fails, so a failed write never
 * leaves debris behind either.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export type JsonReadResult =
  | { kind: 'ok'; value: unknown }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function temporaryPathFor(filePath: string): string {
  const unique = `${process.pid.toString(36)}-${randomBytes(6).toString('hex')}`;
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${unique}`);
}

/** Reads and parses a JSON file. Never throws. */
export async function readJsonFile(filePath: string): Promise<JsonReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return { kind: 'missing' };
    }
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    return { kind: 'ok', value: JSON.parse(raw) as unknown };
  } catch (error) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Writes `value` as pretty printed JSON, atomically.
 *
 * Throws when the write fails; the previous file is left untouched in that
 * case.
 */
export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });

  const temporaryPath = temporaryPathFor(filePath);
  const payload = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await fs.writeFile(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    try {
      await fs.unlink(temporaryPath);
    } catch {
      // The temporary file may not exist; nothing else to do here.
    }
    throw error;
  }
}

/** Synchronous variant used by the settings service (its API is sync). */
export function writeJsonFileAtomicSync(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  fsSync.mkdirSync(directory, { recursive: true });

  const temporaryPath = temporaryPathFor(filePath);
  const payload = `${JSON.stringify(value, null, 2)}\n`;

  try {
    fsSync.writeFileSync(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
    fsSync.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fsSync.unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not exist; nothing else to do here.
    }
    throw error;
  }
}

/** Creates a directory (and its parents) when it does not exist yet. */
export async function ensureDirectory(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true });
}
