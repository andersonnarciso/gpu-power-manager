import { describe, it, expect } from 'vitest';

import {
  applyProfilePayload,
  queryGpuLimits,
  waitForDriver,
  type ApplyPayload,
  type NvidiaSmiRunner,
} from '../../src/main/persistence/apply-script';

const GPU_4070 = 'GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1';
const GPU_5060 = 'GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646';

class FakeNvidiaSmi {
  readonly calls: string[][] = [];
  /** Number of `-L` probes that fail before the driver answers. */
  unavailableProbes = 0;
  failingApply = new Set<string>();
  lines: Array<[string, number, number, number]> = [
    [GPU_4070, 100, 285, 285],
    [GPU_5060, 150, 180, 180],
  ];

  readonly runner: NvidiaSmiRunner = async (args: string[]) => {
    this.calls.push(args);

    if (args[0] === '-L') {
      if (this.unavailableProbes > 0) {
        this.unavailableProbes -= 1;
        return { stdout: '', stderr: 'NVML: Driver not loaded' };
      }
      return { stdout: 'GPU 0: NVIDIA GeForce RTX 4070 Ti\n', stderr: '' };
    }

    if (args[0].startsWith('--query-gpu=')) {
      const stdout = this.lines
        .map(([uuid, min, max, def]) => `${uuid}, ${min}.00, ${max}.00, ${def}.00`)
        .join('\n');
      return { stdout: `${stdout}\n`, stderr: '' };
    }

    if (args[0] === '-i') {
      const uuid = args[1];
      if (this.failingApply.has(uuid)) {
        throw new Error('nvidia-smi: Insufficient Permissions');
      }
      return { stdout: '', stderr: '' };
    }

    return { stdout: '', stderr: '' };
  };

  get applyCalls(): string[][] {
    return this.calls.filter((args) => args[0] === '-i');
  }

  get probeCalls(): number {
    return this.calls.filter((args) => args[0] === '-L').length;
  }
}

function payload(overrides: Partial<ApplyPayload> = {}): ApplyPayload {
  return {
    version: 1,
    profileId: 'builtin-balanced',
    profileName: 'Balanced',
    builtin: true,
    installedAt: 1_700_000_000_000,
    entries: [],
    lastAppliedAt: null,
    lastError: null,
    ...overrides,
  };
}

describe('waitForDriver', () => {
  it('waits until the driver answers', async () => {
    const smi = new FakeNvidiaSmi();
    smi.unavailableProbes = 2;

    const result = await waitForDriver({
      runner: smi.runner,
      timeoutMs: 5_000,
      pollIntervalMs: 1,
    });

    expect(result.ready).toBe(true);
    expect(result.attempts).toBe(3);
    expect(smi.probeCalls).toBe(3);
  });

  it('gives up when the driver never shows up', async () => {
    const smi = new FakeNvidiaSmi();
    smi.unavailableProbes = Number.MAX_SAFE_INTEGER;

    const result = await waitForDriver({
      runner: smi.runner,
      timeoutMs: 25,
      pollIntervalMs: 5,
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toContain('driver NVIDIA');
  });
});

describe('queryGpuLimits', () => {
  it('reads the limits the driver reports', async () => {
    const smi = new FakeNvidiaSmi();
    const limits = await queryGpuLimits(smi.runner);

    expect(limits).toEqual([
      { uuid: GPU_4070, minWatts: 100, maxWatts: 285, defaultWatts: 285 },
      { uuid: GPU_5060, minWatts: 150, maxWatts: 180, defaultWatts: 180 },
    ]);
  });
});

describe('applyProfilePayload', () => {
  it('resolves the strategy against the live limits and applies it', async () => {
    const smi = new FakeNvidiaSmi();

    const outcome = await applyProfilePayload({
      payload: payload({
        entries: [
          { uuid: GPU_4070, watts: null, strategy: 'ratio', ratio: 0.7 },
          { uuid: GPU_5060, watts: null, strategy: 'min' },
        ],
      }),
      runner: smi.runner,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.applied).toEqual([
      { uuid: GPU_4070, watts: 230 },
      { uuid: GPU_5060, watts: 150 },
    ]);
    expect(smi.applyCalls).toEqual([
      ['-i', GPU_4070, '-pl', '230'],
      ['-i', GPU_5060, '-pl', '150'],
    ]);
  });

  it('never applies a value above the factory default', async () => {
    const smi = new FakeNvidiaSmi();
    smi.lines = [[GPU_4070, 100, 600, 450]];

    const outcome = await applyProfilePayload({
      payload: payload({
        entries: [{ uuid: GPU_4070, watts: null, strategy: 'ratio', ratio: 1 }],
      }),
      runner: smi.runner,
    });

    expect(outcome.applied).toEqual([{ uuid: GPU_4070, watts: 450 }]);
  });

  it('rejects a fixed value outside the range', async () => {
    const smi = new FakeNvidiaSmi();

    const outcome = await applyProfilePayload({
      payload: payload({
        entries: [{ uuid: GPU_4070, watts: 400, strategy: 'fixed' }],
      }),
      runner: smi.runner,
    });

    expect(outcome.applied).toEqual([]);
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0].reason).toContain('fora da faixa');
    expect(smi.applyCalls).toEqual([]);
  });

  it('skips a GPU that is not present anymore', async () => {
    const smi = new FakeNvidiaSmi();
    smi.lines = [[GPU_5060, 150, 180, 180]];

    const outcome = await applyProfilePayload({
      payload: payload({
        entries: [
          { uuid: GPU_5060, watts: null, strategy: 'default' },
          { uuid: GPU_4070, watts: 200, strategy: 'fixed' },
        ],
      }),
      runner: smi.runner,
    });

    expect(outcome.applied).toEqual([{ uuid: GPU_5060, watts: 180 }]);
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0].uuid).toBe(GPU_4070);
  });

  it('reports a failure without aborting the batch', async () => {
    const smi = new FakeNvidiaSmi();
    smi.failingApply.add(GPU_4070);

    const outcome = await applyProfilePayload({
      payload: payload({
        entries: [
          { uuid: GPU_4070, watts: 200, strategy: 'fixed' },
          { uuid: GPU_5060, watts: 160, strategy: 'fixed' },
        ],
      }),
      runner: smi.runner,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0].uuid).toBe(GPU_4070);
    expect(outcome.failed[0].reason).toContain('Insufficient Permissions');
    expect(outcome.applied).toEqual([{ uuid: GPU_5060, watts: 160 }]);
  });

  it('does not touch the hardware on a dry run', async () => {
    const smi = new FakeNvidiaSmi();

    const outcome = await applyProfilePayload({
      payload: payload({
        entries: [{ uuid: GPU_4070, watts: null, strategy: 'default' }],
      }),
      runner: smi.runner,
      dryRun: true,
    });

    expect(outcome.applied).toEqual([{ uuid: GPU_4070, watts: 285 }]);
    expect(smi.applyCalls).toEqual([]);
  });

  it('waits for the driver before applying anything', async () => {
    const smi = new FakeNvidiaSmi();
    smi.unavailableProbes = 1;

    const outcome = await applyProfilePayload({
      payload: payload({
        entries: [{ uuid: GPU_4070, watts: null, strategy: 'default' }],
      }),
      runner: smi.runner,
      wait: { runner: smi.runner, timeoutMs: 5_000, pollIntervalMs: 1 },
    });

    expect(outcome.ok).toBe(true);
    expect(smi.probeCalls).toBeGreaterThan(0);
    expect(smi.applyCalls).toEqual([['-i', GPU_4070, '-pl', '285']]);
  });

  it('does not apply anything when the driver never shows up', async () => {
    const smi = new FakeNvidiaSmi();
    smi.unavailableProbes = Number.MAX_SAFE_INTEGER;

    const outcome = await applyProfilePayload({
      payload: payload({
        entries: [{ uuid: GPU_4070, watts: null, strategy: 'default' }],
      }),
      runner: smi.runner,
      wait: { runner: smi.runner, timeoutMs: 25, pollIntervalMs: 5 },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('driver NVIDIA');
    expect(smi.applyCalls).toEqual([]);
  });
});
