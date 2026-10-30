/**
 * Persistence of the benchmark runs.
 *
 * The runs are stored as a single JSON file inside the user data directory
 * (`<userData>/benchmarks.json`). Writes are atomic: the new content goes to a
 * temporary file in the same directory and is then renamed over the old one,
 * so an interrupted write can never leave a truncated file behind.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BenchmarkResult } from '../../shared/types';

export interface BenchmarkRunStore {
  /** Loads every persisted run, oldest first. */
  load(): Promise<BenchmarkResult[]>;
  /** Persists the given runs. */
  save(runs: BenchmarkResult[]): Promise<void>;
}

export interface FileBenchmarkStoreOptions {
  /** File name inside the directory. Defaults to "benchmarks.json". */
  fileName?: string;
  /** Maximum number of runs kept on disk. Defaults to 50. */
  maxRuns?: number;
}

/** Creates a store that persists the runs in `<directory>/<fileName>`. */
export function createFileBenchmarkStore(
  directory: string,
  options: FileBenchmarkStoreOptions = {},
): BenchmarkRunStore {
  const fileName = options.fileName ?? 'benchmarks.json';
  const maxRuns = options.maxRuns ?? 50;
  const filePath = join(directory, fileName);

  return {
    async load(): Promise<BenchmarkResult[]> {
      let content: string;
      try {
        content = await readFile(filePath, 'utf8');
      } catch {
        return [];
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return [];
      }

      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isBenchmarkResult);
    },

    async save(runs: BenchmarkResult[]): Promise<void> {
      await mkdir(directory, { recursive: true });
      const trimmed = runs.slice(0, maxRuns);
      const temporaryPath = join(directory, `.${fileName}.${process.pid}.${Date.now()}.tmp`);
      await writeFile(temporaryPath, JSON.stringify(trimmed, null, 2), 'utf8');
      await rename(temporaryPath, filePath);
    },
  };
}

/** Creates a store that keeps the runs in memory. Used by the tests. */
export function createInMemoryBenchmarkStore(initial: BenchmarkResult[] = []): BenchmarkRunStore {
  let runs: BenchmarkResult[] = [...initial];
  return {
    async load(): Promise<BenchmarkResult[]> {
      return [...runs];
    },
    async save(next: BenchmarkResult[]): Promise<void> {
      runs = [...next];
    },
  };
}

/** Guards against a corrupted file: only well formed runs are kept. */
function isBenchmarkResult(value: unknown): value is BenchmarkResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BenchmarkResult>;
  return typeof candidate.id === 'string' && typeof candidate.startedAt === 'number';
}
