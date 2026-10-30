// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../../src/shared/types';
import {
  NvidiasmiBackend,
  parseNvidiaSmiCsv,
  parseWattValue,
} from '../../src/main/power/nvidia-smi-backend';
import type { ExecRunner } from '../../src/main/privileged/exec';
import { HelperClient } from '../../src/main/privileged/helper-client';
import { AppErrorException } from '../../src/main/privileged/errors';

const REAL_CSV = [
  'GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1, NVIDIA GeForce RTX 4070 Ti, 100.00, 285.00, 285.00, 285.00',
  'GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646, NVIDIA GeForce RTX 5060 Ti, 150.00, 180.00, 180.00, 180.00',
].join('\n');

class RecordingRunner implements ExecRunner {
  readonly calls: { file: string; args: string[] }[] = [];
  stdout = '';
  stderr = '';
  exitCode = 0;

  async run(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.calls.push({ file, args: [...args] });
    return { stdout: this.stdout, stderr: this.stderr, exitCode: this.exitCode };
  }
}

describe('nvidia-smi backend: CSV parsing', () => {
  it('parses the real output of the reference machine', () => {
    const gpus = parseNvidiaSmiCsv(REAL_CSV);
    expect(gpus).toHaveLength(2);
    expect(gpus[0]).toEqual({
      uuid: 'GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1',
      name: 'NVIDIA GeForce RTX 4070 Ti',
      minWatts: 100,
      defaultWatts: 285,
      maxWatts: 285,
      currentWatts: 285,
    });
    expect(gpus[1]).toEqual({
      uuid: 'GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646',
      name: 'NVIDIA GeForce RTX 5060 Ti',
      minWatts: 150,
      defaultWatts: 180,
      maxWatts: 180,
      currentWatts: 180,
    });
  });

  it('ignores empty lines and unknown devices', () => {
    expect(parseNvidiaSmiCsv('\n\nnot a gpu line\n')).toEqual([]);
  });

  it('treats N/A as an unknown value', () => {
    expect(parseWattValue('[N/A]')).toBeNull();
    expect(parseWattValue('N/A')).toBeNull();
    expect(parseWattValue('180.00')).toBe(180);
  });
});

describe('nvidia-smi backend: privileged changes', () => {
  it('reads the limits with a read only query', async () => {
    const runner = new RecordingRunner();
    runner.stdout = REAL_CSV;
    const backend = new NvidiasmiBackend({
      runner,
      nvidiaSmiPath: '/usr/bin/nvidia-smi',
      helperClient: new HelperClient({ runner, helperPath: '/usr/local/libexec/gpu-power-manager-helper' }),
    });
    const bounds = await backend.bounds('GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646');
    expect(bounds).toEqual({ min: 150, max: 180, defaultLimit: 180, current: 180 });
    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0];
    expect(call?.file).toBe('/usr/bin/nvidia-smi');
    expect(call?.args.some((arg) => arg.includes('-pl'))).toBe(false);
  });

  it('never runs nvidia-smi -pl from the main process', async () => {
    const runner = new RecordingRunner();
    runner.stdout = REAL_CSV;
    const helperClient = new HelperClient({
      runner,
      helperPath: '/usr/local/libexec/gpu-power-manager-helper',
      pkexecPath: '/usr/bin/pkexec',
    });
    const backend = new NvidiasmiBackend({
      runner,
      nvidiaSmiPath: '/usr/bin/nvidia-smi',
      helperClient,
    });
    await backend.apply('GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646', 160).catch(() => undefined);
    for (const call of runner.calls) {
      expect(call.args.some((arg) => arg === '-pl')).toBe(false);
    }
  });

  it('is never simulated', () => {
    const backend = new NvidiasmiBackend({ runner: new RecordingRunner() });
    expect(backend.isSimulated()).toBe(false);
  });

  it('reports a missing driver', async () => {
    const runner: ExecRunner = {
      run: async () => {
        throw new AppErrorException({ code: ErrorCode.DriverUnavailable, message: 'nvidia-smi ausente' });
      },
    };
    const backend = new NvidiasmiBackend({ runner, nvidiaSmiPath: '/usr/bin/nvidia-smi' });
    await expect(backend.bounds('GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646')).rejects.toMatchObject({
      appError: { code: ErrorCode.DriverUnavailable },
    });
  });
});
