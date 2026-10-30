// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../../src/shared/types';
import { AppErrorException } from '../../src/main/privileged/errors';
import { ExecFailure, type ExecRunner } from '../../src/main/privileged/exec';
import { HelperClient, helperCandidates } from '../../src/main/privileged/helper-client';
import type { FileProbe } from '../../src/main/privileged/polkit';

const HELPER_PATH = '/usr/local/libexec/gpu-power-manager-helper';
const PKEXEC_PATH = '/usr/bin/pkexec';
const GPU_5060 = 'GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646';

interface RecordedCall {
  file: string;
  args: string[];
}

class FakeRunner implements ExecRunner {
  readonly calls: RecordedCall[] = [];
  stdout = '';
  stderr = '';
  failure: ExecFailure | null = null;

  async run(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.calls.push({ file, args: [...args] });
    if (this.failure !== null) throw this.failure;
    return { stdout: this.stdout, stderr: this.stderr, exitCode: 0 };
  }
}

function probeWith(paths: string[]): FileProbe {
  return {
    exists: (path: string) => paths.includes(path),
    stat: () => null,
  };
}

function clientWith(runner: FakeRunner, options: { helperPath?: string | null; pkexecPath?: string | null } = {}): HelperClient {
  return new HelperClient({
    runner,
    probe: probeWith([]),
    helperPath: options.helperPath === undefined ? HELPER_PATH : options.helperPath,
    pkexecPath: options.pkexecPath === undefined ? PKEXEC_PATH : options.pkexecPath,
    appRoot: '/opt/gpu-power-manager',
  });
}

describe('HelperClient: argv construction', () => {
  it('invokes the helper through pkexec with an argv array', async () => {
    const runner = new FakeRunner();
    runner.stdout = JSON.stringify({ ok: true, uuid: GPU_5060, appliedWatts: 160, verified: true });
    const client = clientWith(runner);
    await client.setPowerLimit(GPU_5060, 160);
    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0];
    expect(call?.file).toBe(PKEXEC_PATH);
    expect(Array.isArray(call?.args)).toBe(true);
    expect(call?.args).toEqual([HELPER_PATH, '--uuid', GPU_5060, '--watts', '160']);
  });

  it('never builds a shell command string', async () => {
    const runner = new FakeRunner();
    runner.stdout = JSON.stringify({ ok: true, uuid: GPU_5060, appliedWatts: 160, verified: true });
    const client = clientWith(runner);
    await client.setPowerLimit(GPU_5060, 160);
    const call = runner.calls[0];
    expect(call).toBeDefined();
    for (const arg of call?.args ?? []) {
      expect(arg).not.toMatch(/[;&|`$><]/);
    }
    // The arguments are separate entries, never a single concatenated string.
    expect(call?.args.length).toBeGreaterThan(1);
  });

  it('refuses a malicious uuid before spawning anything', async () => {
    const runner = new FakeRunner();
    const client = clientWith(runner);
    for (const value of ['GPU-xyz', '../../etc/passwd', 'rm -rf /', 'GPU-0000; id']) {
      await expect(client.setPowerLimit(value, 160)).rejects.toMatchObject({
        appError: { code: ErrorCode.ValidationFailed },
      });
    }
    expect(runner.calls).toHaveLength(0);
  });

  it('refuses a malicious watt value before spawning anything', async () => {
    const runner = new FakeRunner();
    const client = clientWith(runner);
    await expect(client.setPowerLimit(GPU_5060, 1.5)).rejects.toMatchObject({
      appError: { code: ErrorCode.ValidationFailed },
    });
    expect(runner.calls).toHaveLength(0);
  });

  it('passes the reset flag as its own argument', async () => {
    const runner = new FakeRunner();
    runner.stdout = JSON.stringify({ ok: true, uuid: GPU_5060, appliedWatts: 180, verified: true });
    const client = clientWith(runner);
    await client.resetPowerLimit(GPU_5060);
    expect(runner.calls[0]?.args).toEqual([HELPER_PATH, '--uuid', GPU_5060, '--reset']);
  });
});

describe('HelperClient: helper lookup', () => {
  it('searches the system paths in priority order', () => {
    const probe = probeWith(['/usr/local/libexec/gpu-power-manager-helper']);
    const client = new HelperClient({ probe, appRoot: '/opt/app' });
    expect(client.locateHelper()).toBe('/usr/local/libexec/gpu-power-manager-helper');
  });

  it('falls back to the other system paths', () => {
    const probe = probeWith(['/usr/lib/gpu-power-manager/helper']);
    const client = new HelperClient({ probe, appRoot: '/opt/app' });
    expect(client.locateHelper()).toBe('/usr/lib/gpu-power-manager/helper');
  });

  it('falls back to the bundled copy used while developing from source', () => {
    const probe = probeWith(['/opt/app/helper/gpu-power-manager-helper.py']);
    const client = new HelperClient({ probe, appRoot: '/opt/app' });
    expect(client.locateHelper()).toBe('/opt/app/helper/gpu-power-manager-helper.py');
  });

  it('exposes every candidate location', () => {
    const candidates = helperCandidates('/opt/app');
    expect(candidates[0]).toBe('/usr/local/libexec/gpu-power-manager-helper');
    expect(candidates[1]).toBe('/usr/libexec/gpu-power-manager-helper');
    expect(candidates[2]).toBe('/usr/lib/gpu-power-manager/helper');
    expect(candidates).toContain('/opt/app/resources/helper/gpu-power-manager-helper');
  });
});

describe('HelperClient: failure mapping', () => {
  it('maps a missing helper to PrivilegedHelperMissing with instructions', async () => {
    const runner = new FakeRunner();
    const client = clientWith(runner, { helperPath: null });
    const probe = probeWith([]);
    const searching = new HelperClient({ runner, probe, appRoot: '/opt/app', pkexecPath: PKEXEC_PATH });
    await expect(searching.setPowerLimit(GPU_5060, 160)).rejects.toMatchObject({
      appError: {
        code: ErrorCode.PrivilegedHelperMissing,
        detail: expect.stringContaining('/usr/local/libexec/gpu-power-manager-helper'),
      },
    });
    expect(runner.calls).toHaveLength(0);
    expect(client).toBeDefined();
  });

  it('maps a missing pkexec to AuthorizationUnavailable', async () => {
    const runner = new FakeRunner();
    const probe = probeWith([]);
    const client = new HelperClient({ runner, probe, appRoot: '/opt/app', helperPath: HELPER_PATH });
    await expect(client.setPowerLimit(GPU_5060, 160)).rejects.toMatchObject({
      appError: { code: ErrorCode.AuthorizationUnavailable },
    });
  });

  it('maps exit 126 (dialog dismissed) to AuthorizationDenied with cancelled', async () => {
    const runner = new FakeRunner();
    runner.failure = new ExecFailure('falhou', {
      exitCode: 126,
      stdout: '',
      stderr: 'Error executing command as another user: Request dismissed',
      errno: null,
      timedOut: false,
    });
    const client = clientWith(runner);
    await expect(client.setPowerLimit(GPU_5060, 160)).rejects.toMatchObject({
      appError: { code: ErrorCode.AuthorizationDenied, cancelled: true },
    });
  });

  it('maps exit 127 (authorization not obtained) to AuthorizationUnavailable', async () => {
    const runner = new FakeRunner();
    runner.failure = new ExecFailure('falhou', {
      exitCode: 127,
      stdout: '',
      stderr: 'Error executing command as another user: Not authorized',
      errno: null,
      timedOut: false,
    });
    const client = clientWith(runner);
    await expect(client.setPowerLimit(GPU_5060, 160)).rejects.toMatchObject({
      appError: { code: ErrorCode.AuthorizationUnavailable },
    });
  });

  it('maps a missing pkexec binary (ENOENT) to AuthorizationUnavailable', async () => {
    const runner = new FakeRunner();
    runner.failure = new ExecFailure('falhou', {
      exitCode: null,
      stdout: '',
      stderr: '',
      errno: 'ENOENT',
      timedOut: false,
    });
    const client = clientWith(runner);
    await expect(client.setPowerLimit(GPU_5060, 160)).rejects.toMatchObject({
      appError: { code: ErrorCode.AuthorizationUnavailable },
    });
  });

  it('maps a timeout to Timeout', async () => {
    const runner = new FakeRunner();
    runner.failure = new ExecFailure('timeout', {
      exitCode: null,
      stdout: '',
      stderr: '',
      errno: null,
      timedOut: true,
    });
    const client = clientWith(runner);
    await expect(client.setPowerLimit(GPU_5060, 160)).rejects.toMatchObject({
      appError: { code: ErrorCode.Timeout },
    });
  });

  it('maps an unexpected exit code to CommandFailed', async () => {
    const runner = new FakeRunner();
    runner.failure = new ExecFailure('falhou', {
      exitCode: 9,
      stdout: '',
      stderr: 'boom',
      errno: null,
      timedOut: false,
    });
    const client = clientWith(runner);
    await expect(client.setPowerLimit(GPU_5060, 160)).rejects.toMatchObject({
      appError: { code: ErrorCode.CommandFailed },
    });
  });

  it('uses the JSON error printed by the helper when there is one', async () => {
    const runner = new FakeRunner();
    runner.failure = new ExecFailure('falhou', {
      exitCode: 3,
      stdout: JSON.stringify({
        ok: false,
        error: { code: ErrorCode.UnsupportedByDriver, message: 'Esta GPU não suporta o ajuste.' },
      }),
      stderr: '',
      errno: null,
      timedOut: false,
    });
    const client = clientWith(runner);
    await expect(client.setPowerLimit(GPU_5060, 160)).rejects.toMatchObject({
      appError: { code: ErrorCode.UnsupportedByDriver, message: 'Esta GPU não suporta o ajuste.' },
    });
  });

  it('rejects an invalid answer from the helper', async () => {
    const runner = new FakeRunner();
    runner.stdout = 'isto nao e json';
    const client = clientWith(runner);
    await expect(client.setPowerLimit(GPU_5060, 160)).rejects.toMatchObject({
      appError: { code: ErrorCode.CommandFailed },
    });
  });
});

describe('HelperClient: successful answers', () => {
  it('parses the answer of the helper', async () => {
    const runner = new FakeRunner();
    runner.stdout = JSON.stringify({ ok: true, uuid: GPU_5060, appliedWatts: 160, verified: true });
    const client = clientWith(runner);
    const outcome = await client.setPowerLimit(GPU_5060, 160);
    expect(outcome.ok).toBe(true);
    expect(outcome.uuid).toBe(GPU_5060);
    expect(outcome.appliedWatts).toBe(160);
    expect(outcome.verified).toBe(true);
  });

  it('parses the limits printed by the helper', async () => {
    const runner = new FakeRunner();
    runner.stdout = JSON.stringify({
      ok: true,
      gpus: [
        {
          uuid: GPU_5060,
          name: 'NVIDIA GeForce RTX 5060 Ti',
          minWatts: 150,
          defaultWatts: 180,
          maxWatts: 180,
          currentWatts: 180,
        },
      ],
    });
    const client = clientWith(runner);
    const outcome = await client.printLimits();
    expect(outcome.limits).toHaveLength(1);
    expect(outcome.limits[0]?.minWatts).toBe(150);
    expect(outcome.limits[0]?.maxWatts).toBe(180);
  });

  it('throws an AppErrorException, never a bare Error', async () => {
    const runner = new FakeRunner();
    runner.failure = new ExecFailure('falhou', {
      exitCode: 126,
      stdout: '',
      stderr: '',
      errno: null,
      timedOut: false,
    });
    const client = clientWith(runner);
    await expect(client.setPowerLimit(GPU_5060, 160)).rejects.toBeInstanceOf(AppErrorException);
  });
});
