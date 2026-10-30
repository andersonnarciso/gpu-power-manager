// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../../src/shared/types';
import { ExecFailure, type ExecRunner } from '../../src/main/privileged/exec';
import {
  HELPER_EXPECTED_MODE,
  HELPER_TARGET_PATH,
  POLICY_EXPECTED_MODE,
  POLICY_TARGET_PATH,
  describeDirectoryProblem,
  describeOwnershipProblem,
  installHelper,
  uninstallHelper,
} from '../../src/main/privileged/install-helper';
import type { FileProbe, FileStat } from '../../src/main/privileged/polkit';

const HELPER_SOURCE = '/app/helper/gpu-power-manager-helper.py';
const POLICY_SOURCE = '/app/resources/polkit/com.gpupowermanager.policy';
const PKEXEC = '/usr/bin/pkexec';
const INSTALL = '/usr/bin/install';
const RM = '/usr/bin/rm';

interface RecordedCall {
  file: string;
  args: string[];
}

/** Fake filesystem that also simulates the removal performed by `rm -f`. */
class FakeFs {
  readonly removed = new Set<string>();
  readonly stats = new Map<string, FileStat | null>();

  constructor(options: ProbeOptions = {}) {
    this.stats.set(HELPER_TARGET_PATH, options.helperStat === undefined ? stat(0, HELPER_EXPECTED_MODE) : options.helperStat);
    this.stats.set(POLICY_TARGET_PATH, options.policyStat === undefined ? stat(0, POLICY_EXPECTED_MODE) : options.policyStat);
    this.stats.set('/usr/local/libexec', options.dirStat === undefined ? stat(0, 0o755, true) : options.dirStat);
  }

  exists(path: string): boolean {
    if (this.removed.has(path)) return false;
    if (path === PKEXEC || path === INSTALL || path === RM) return true;
    if (path === HELPER_SOURCE || path === POLICY_SOURCE) return true;
    const value = this.stats.get(path);
    return value !== undefined && value !== null;
  }

  stat(path: string): FileStat | null {
    const value = this.stats.get(path);
    return value === undefined ? null : value;
  }

  probe(): FileProbe {
    return { exists: (path: string) => this.exists(path), stat: (path: string) => this.stat(path) };
  }
}

class FakeRunner implements ExecRunner {
  readonly calls: RecordedCall[] = [];
  failure: ExecFailure | null = null;

  constructor(private readonly fs?: FakeFs) {}

  async run(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.calls.push({ file, args: [...args] });
    if (this.failure !== null) throw this.failure;
    // `rm -f <target>` really removes the file.
    if (this.fs !== undefined && args[0] === RM) {
      const target = args[args.length - 1];
      if (target !== undefined) this.fs.removed.add(target);
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

function stat(uid: number, mode: number, isDirectory = false): FileStat {
  return { uid, gid: 0, mode, size: 10, isDirectory, isFile: !isDirectory };
}

interface ProbeOptions {
  helperStat?: FileStat | null;
  policyStat?: FileStat | null;
  dirStat?: FileStat | null;
  missing?: string[];
}

function probeWith(options: ProbeOptions = {}): FileProbe {
  return new FakeFs(options).probe();
}

function installOptions(runner: FakeRunner, probe: FileProbe) {
  return {
    runner,
    probe,
    helperSourcePath: HELPER_SOURCE,
    policySourcePath: POLICY_SOURCE,
    pkexecPath: PKEXEC,
    installPath: INSTALL,
    rmPath: RM,
    appRoot: '/app',
  };
}

describe('install-helper: security checks', () => {
  it('refuses to continue when the installed helper is not owned by root', async () => {
    const runner = new FakeRunner();
    const probe = probeWith({ helperStat: stat(1000, HELPER_EXPECTED_MODE) });
    const report = await installHelper(installOptions(runner, probe));
    expect(report.ok).toBe(false);
    expect(report.error?.code).toBe(ErrorCode.PermissionDenied);
    expect(report.error?.detail).toContain('root');
    // The policy must not be installed after the helper was refused.
    const policyCalls = runner.calls.filter((call) => call.args.includes(POLICY_TARGET_PATH));
    expect(policyCalls).toHaveLength(0);
  });

  it('refuses to continue when the installed helper has the wrong mode', async () => {
    const runner = new FakeRunner();
    const probe = probeWith({ helperStat: stat(0, 0o777) });
    const report = await installHelper(installOptions(runner, probe));
    expect(report.ok).toBe(false);
    expect(report.error?.code).toBe(ErrorCode.PermissionDenied);
    expect(report.error?.detail).toContain('0755');
  });

  it('refuses to continue when the policy is not owned by root', async () => {
    const runner = new FakeRunner();
    const probe = probeWith({ policyStat: stat(1000, POLICY_EXPECTED_MODE) });
    const report = await installHelper(installOptions(runner, probe));
    expect(report.ok).toBe(false);
    expect(report.error?.code).toBe(ErrorCode.PermissionDenied);
  });

  it('refuses to install into a directory that other users can write to', async () => {
    const runner = new FakeRunner();
    const probe = probeWith({ dirStat: stat(0, 0o777, true) });
    const report = await installHelper(installOptions(runner, probe));
    expect(report.ok).toBe(false);
    expect(report.error?.code).toBe(ErrorCode.PermissionDenied);
    expect(runner.calls).toHaveLength(0);
  });

  it('refuses to install into a directory that is not owned by root', async () => {
    const runner = new FakeRunner();
    const probe = probeWith({ dirStat: stat(1000, 0o755, true) });
    const report = await installHelper(installOptions(runner, probe));
    expect(report.ok).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });
});

describe('install-helper: installation', () => {
  it('installs the helper and the policy through pkexec with an argv array', async () => {
    const runner = new FakeRunner();
    const probe = probeWith();
    const report = await installHelper(installOptions(runner, probe));
    expect(report.ok).toBe(true);
    expect(report.steps.length).toBeGreaterThanOrEqual(4);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.file).toBe(PKEXEC);
    expect(runner.calls[0]?.args).toEqual([
      INSTALL,
      '-o',
      'root',
      '-g',
      'root',
      '-m',
      '0755',
      HELPER_SOURCE,
      HELPER_TARGET_PATH,
    ]);
    expect(runner.calls[1]?.args).toEqual([
      INSTALL,
      '-o',
      'root',
      '-g',
      'root',
      '-m',
      '0644',
      POLICY_SOURCE,
      POLICY_TARGET_PATH,
    ]);
    for (const call of runner.calls) {
      for (const arg of call.args) expect(arg).not.toMatch(/[;&|`$><]/);
    }
  });

  it('is idempotent', async () => {
    const runner = new FakeRunner();
    const probe = probeWith();
    const first = await installHelper(installOptions(runner, probe));
    const second = await installHelper(installOptions(runner, probe));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.steps.some((step) => step.detail.includes('Atualizado'))).toBe(true);
  });

  it('reports precisely what happened', async () => {
    const runner = new FakeRunner();
    const probe = probeWith();
    const report = await installHelper(installOptions(runner, probe));
    const labels = report.steps.map((step) => step.label);
    expect(labels).toContain('Utilitário privilegiado');
    expect(labels).toContain('Política do polkit');
    expect(report.steps.every((step) => step.ok)).toBe(true);
    expect(report.steps[0]?.detail).toContain(HELPER_TARGET_PATH);
  });

  it('fails when pkexec is not available', async () => {
    const runner = new FakeRunner();
    const probe: FileProbe = {
      exists: (path: string) => path === HELPER_SOURCE || path === POLICY_SOURCE,
      stat: () => null,
    };
    const report = await installHelper({ ...installOptions(runner, probe), pkexecPath: null });
    expect(report.ok).toBe(false);
    expect(report.error?.code).toBe(ErrorCode.AuthorizationUnavailable);
  });

  it('fails when the helper source is missing', async () => {
    const runner = new FakeRunner();
    const probe = probeWith();
    const report = await installHelper({
      ...installOptions(runner, probe),
      helperSourcePath: '/nowhere/helper.py',
    });
    expect(report.ok).toBe(false);
    expect(report.error?.code).toBe(ErrorCode.PrivilegedHelperMissing);
  });
});

describe('install-helper: uninstall', () => {
  it('removes both files through pkexec', async () => {
    const fs = new FakeFs();
    const runner = new FakeRunner(fs);
    const report = await uninstallHelper({
      runner,
      probe: fs.probe(),
      pkexecPath: PKEXEC,
      rmPath: RM,
    });
    expect(report.ok).toBe(true);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.args).toEqual([RM, '-f', HELPER_TARGET_PATH]);
    expect(runner.calls[1]?.args).toEqual([RM, '-f', POLICY_TARGET_PATH]);
  });

  it('is idempotent when the files are already gone', async () => {
    const fs = new FakeFs({ helperStat: null, policyStat: null });
    const runner = new FakeRunner(fs);
    const report = await uninstallHelper({
      runner,
      probe: fs.probe(),
      pkexecPath: PKEXEC,
      rmPath: RM,
    });
    expect(report.ok).toBe(true);
    expect(runner.calls).toHaveLength(0);
  });
});

describe('install-helper: helpers', () => {
  it('describes an ownership problem', () => {
    expect(describeOwnershipProblem(stat(0, 0o755), 0o755, 'Arquivo')).toBeNull();
    expect(describeOwnershipProblem(stat(1000, 0o755), 0o755, 'Arquivo')).toContain('root');
    expect(describeOwnershipProblem(stat(0, 0o777), 0o755, 'Arquivo')).toContain('0755');
    expect(describeOwnershipProblem(null, 0o755, 'Arquivo')).toContain('não existe');
  });

  it('describes a directory problem', () => {
    expect(describeDirectoryProblem(stat(0, 0o755, true), 'Diretório')).toBeNull();
    expect(describeDirectoryProblem(stat(0, 0o777, true), 'Diretório')).toContain('gravável');
    expect(describeDirectoryProblem(stat(0, 0o755, false), 'Diretório')).toContain('diretório');
  });
});
