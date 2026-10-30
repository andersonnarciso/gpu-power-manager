// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER_SCRIPT = path.resolve(HERE, '..', '..', 'helper', 'gpu-power-manager-helper.py');

interface HelperRun {
  status: number;
  stdout: string;
  stderr: string;
}

function runHelper(args: string[]): HelperRun {
  const result = spawnSync('python3', [HELPER_SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** True when this machine has a usable NVIDIA driver. */
function nvidiaAvailable(): boolean {
  const result = spawnSync('/usr/bin/nvidia-smi', ['--query-gpu=uuid', '--format=csv,noheader'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  return result.status === 0;
}

/**
 * The real-machine suite must work on **any** NVIDIA machine, not only on the
 * developer's. It therefore asserts structural invariants (the driver reports
 * coherent ranges) instead of the exact UUIDs and watt values of one box.
 */
interface HelperGpu {
  uuid: string;
  name?: string;
  minWatts: number;
  defaultWatts: number;
  maxWatts: number;
  currentWatts: number;
}

function readLimits(): HelperGpu[] {
  const run = runHelper(['--print-limits']);
  expect(run.status).toBe(0);
  const payload = JSON.parse(run.stdout) as { ok: boolean; gpus: HelperGpu[] };
  expect(payload.ok).toBe(true);
  return payload.gpus;
}

/** The first GPU of the machine, whatever it is. */
function firstGpu(): HelperGpu {
  const gpus = readLimits();
  expect(gpus.length).toBeGreaterThan(0);
  return gpus[0];
}

const HAS_NVIDIA = nvidiaAvailable();

describe('helper script: source safety', () => {
  it('has a posix friendly shebang', () => {
    const source = fs.readFileSync(HELPER_SCRIPT, 'utf8');
    expect(source.startsWith('#!/usr/bin/env python3')).toBe(true);
  });

  it('never builds a shell command', () => {
    const source = fs.readFileSync(HELPER_SCRIPT, 'utf8');
    expect(source).not.toContain('os.system');
    expect(source).not.toContain('shell=True');
    expect(source).not.toContain('subprocess.call(');
    expect(source).not.toContain('subprocess.Popen(');
    // Every command is executed through an argument list.
    expect(source).toContain('shell=False');
  });

  it('uses only the standard library', () => {
    const source = fs.readFileSync(HELPER_SCRIPT, 'utf8');
    const imports = [...source.matchAll(/^import ([a-zA-Z0-9_]+)/gm)].map((match) => match[1]);
    for (const name of imports) {
      expect(['argparse', 'json', 'os', 're', 'shutil', 'subprocess', 'sys']).toContain(name);
    }
  });
});

describe.skipIf(!HAS_NVIDIA)('helper script: real machine', () => {
  it('prints the real limits as a single JSON object', () => {
    const gpus = readLimits();
    expect(Array.isArray(gpus)).toBe(true);
    expect(gpus.length).toBeGreaterThan(0);

    for (const gpu of gpus) {
      expect(gpu.uuid).toMatch(/^GPU-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-/);
      // The driver must report a coherent range.
      expect(gpu.minWatts).toBeGreaterThan(0);
      expect(gpu.maxWatts).toBeGreaterThanOrEqual(gpu.minWatts);
      expect(gpu.defaultWatts).toBeGreaterThanOrEqual(gpu.minWatts);
      expect(gpu.defaultWatts).toBeLessThanOrEqual(gpu.maxWatts);
      expect(gpu.currentWatts).toBeGreaterThanOrEqual(gpu.minWatts);
      expect(gpu.currentWatts).toBeLessThanOrEqual(gpu.maxWatts);
    }
  });

  it('rejects an invalid uuid with exit code 2', () => {
    const run = runHelper(['--uuid', 'GPU-xyz', '--watts', '180']);
    expect(run.status).toBe(2);
    const payload = JSON.parse(run.stdout) as { ok: boolean; error: { code: string; message: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a uuid that tries to escape the argument list', () => {
    const run = runHelper(['--uuid', '../../etc/passwd', '--watts', '180']);
    expect(run.status).toBe(2);
    const payload = JSON.parse(run.stdout) as { ok: boolean; error: { code: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a non integer watt value with exit code 2', () => {
    const gpu = firstGpu();
    const run = runHelper(['--uuid', gpu.uuid, '--watts', 'abc']);
    expect(run.status).toBe(2);
    const payload = JSON.parse(run.stdout) as { ok: boolean };
    expect(payload.ok).toBe(false);
  });

  it('rejects an out of range watt value with exit code 2 and changes nothing', () => {
    const before = readLimits();
    const gpu = before[0];
    // A value above the maximum the driver reports for this machine.
    const outOfRange = gpu.maxWatts + 1000;

    const run = runHelper(['--uuid', gpu.uuid, '--watts', String(outOfRange)]);
    expect(run.status).toBe(2);
    const payload = JSON.parse(run.stdout) as { ok: boolean; error: { code: string; message: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('VALIDATION_FAILED');
    expect(payload.error.message).toContain(`${gpu.minWatts}–${gpu.maxWatts} W`);

    const after = readLimits();
    expect(after).toEqual(before);
  });

  it('rejects unknown arguments with exit code 2', () => {
    const run = runHelper(['--watts', '180', '--unknown-flag']);
    expect(run.status).toBe(2);
  });

  it('rejects the combination of --reset and --watts with exit code 2', () => {
    const gpu = firstGpu();
    const run = runHelper(['--uuid', gpu.uuid, '--reset', '--watts', '180']);
    expect(run.status).toBe(2);
  });

  it('writes the human readable details to stderr', () => {
    const run = runHelper(['--print-limits']);
    expect(run.stderr).toContain('gpu-power-manager-helper');
  });
});
