import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ErrorCode } from '../../src/shared/types';
import {
  SystemdManager,
  renderServiceUnit,
  type SystemdAvailability,
} from '../../src/main/persistence/systemd-manager';
import type { ApplyPayload } from '../../src/main/persistence/apply-script';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  // The same mock instance must be exposed as the named export and as the
  // default export: node builtins are CommonJS and the SSR interop may pick
  // either one.
  const execFileMock = vi.fn();
  const mocked = { ...actual, execFile: execFileMock };
  return { ...mocked, default: mocked };
});

type ExecHandler = (
  file: string,
  args: string[],
) => { stdout?: string; stderr?: string; error?: Error };

const RESOURCES_DIR = path.resolve(process.cwd(), 'resources', 'systemd');

const GPU_4070 = 'GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1';

function useExecMock(handler: ExecHandler): string[][] {
  const calls: string[][] = [];
  vi.mocked(execFile).mockImplementation(
    ((
      file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push([file, ...args]);
      const result = handler(file, args);
      callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '');
      return undefined as never;
    }) as unknown as typeof execFile,
  );
  return calls;
}

/** Simulates the privileged commands inside the temporary directory. */
function createSystemHandler(options: { enabled?: boolean; failStderr?: string } = {}): ExecHandler {
  return (file, args) => {
    const isPkexec = file.endsWith('pkexec');
    const tool = isPkexec ? args[0] : file;
    const toolArgs = isPkexec ? args.slice(1) : args;
    const name = path.basename(tool);

    if (name === 'install') {
      const modeIndex = toolArgs.indexOf('-m');
      const mode = modeIndex >= 0 ? Number.parseInt(toolArgs[modeIndex + 1], 8) : 0o644;
      const isDirectory = toolArgs.includes('-d');
      const destination = toolArgs[toolArgs.length - 1];

      if (isDirectory) {
        fs.mkdirSync(destination, { recursive: true });
        fs.chmodSync(destination, mode);
        return {};
      }

      const source = toolArgs[toolArgs.length - 2];
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, mode);
      return {};
    }

    if (name === 'rm') {
      for (const argument of toolArgs) {
        if (argument.startsWith('-')) continue;
        fs.rmSync(argument, { force: true });
      }
      return {};
    }

    if (name === 'rmdir') {
      for (const argument of toolArgs) {
        if (argument.startsWith('-')) continue;
        try {
          fs.rmdirSync(argument);
        } catch {
          // The folder may not be empty; that is not an error for the test.
        }
      }
      return {};
    }

    if (name === 'systemctl') {
      const command = toolArgs[0];
      if (command === 'is-enabled') {
        return { stdout: options.enabled === false ? 'disabled\n' : 'enabled\n' };
      }
      if (options.failStderr !== undefined) {
        return {
          error: new Error('Command failed'),
          stderr: options.failStderr,
        };
      }
      return {};
    }

    return {};
  };
}

function payload(): ApplyPayload {
  return {
    version: 1,
    profileId: 'builtin-balanced',
    profileName: 'Balanced',
    builtin: true,
    installedAt: 1_700_000_000_000,
    entries: [{ uuid: GPU_4070, watts: null, strategy: 'ratio', ratio: 0.7 }],
    lastAppliedAt: null,
    lastError: null,
  };
}

let workspace: string;
let unitPath: string;
let scriptPath: string;
let policyPath: string;
let stateDir: string;
let stateFile: string;

beforeEach(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'gpupm-systemd-'));
  unitPath = path.join(workspace, 'etc', 'gpu-power-manager-persist.service');
  scriptPath = path.join(workspace, 'lib', 'gpu-power-manager-apply.py');
  policyPath = path.join(workspace, 'actions', 'com.gpupowermanager.policy');
  stateDir = path.join(workspace, 'var', 'gpu-power-manager');
  stateFile = path.join(stateDir, 'profile.json');

  vi.mocked(execFile).mockReset();
});

afterEach(async () => {
  await fsp.rm(workspace, { recursive: true, force: true });
});

function createManager(options: { available?: boolean } = {}): SystemdManager {
  const availability: SystemdAvailability =
    options.available === false
      ? { available: false, message: 'Este computador não usa systemd.' }
      : { available: true, message: '' };

  return new SystemdManager({
    unitPath,
    scriptPath,
    scriptDir: path.dirname(scriptPath),
    policyPath,
    stateDir,
    stateFile,
    resourcesDir: RESOURCES_DIR,
    pkexecPath: '/usr/bin/pkexec',
    systemctlPath: '/usr/bin/systemctl',
    payloadProvider: {
      buildPayload: async () => payload(),
    },
    systemdProbe: async () => availability,
  });
}

describe('SystemdManager', () => {
  it('installs the unit, the helper and the state file with the right modes', async () => {
    const calls = useExecMock(createSystemHandler());
    const manager = createManager();

    const result = await manager.install('builtin-balanced');

    expect(result.ok).toBe(true);

    expect(fs.existsSync(unitPath)).toBe(true);
    expect(fs.statSync(unitPath).mode & 0o777).toBe(0o644);
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.statSync(scriptPath).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(policyPath)).toBe(true);
    expect(fs.statSync(policyPath).mode & 0o777).toBe(0o644);
    expect(fs.existsSync(stateFile)).toBe(true);
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o644);

    // The payload keeps the strategy, the watt value is resolved at boot.
    const written = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(written.profileId).toBe('builtin-balanced');
    expect(written.entries[0]).toEqual({
      uuid: GPU_4070,
      watts: null,
      strategy: 'ratio',
      ratio: 0.7,
    });

    // Every privileged command goes through pkexec with an argv array.
    for (const call of calls) {
      expect(call[0]).toBe('/usr/bin/pkexec');
      expect(call.length).toBeGreaterThan(1);
    }

    // The files are owned by root.
    const installCalls = calls.filter((call) => call.includes('/usr/bin/install'));
    expect(installCalls.length).toBeGreaterThan(0);
    for (const call of installCalls) {
      expect(call).toContain('-o');
      expect(call).toContain('root');
      expect(call).toContain('-g');
    }
  });

  it('installs a unit that points to the helper and to the state file', async () => {
    useExecMock(createSystemHandler());
    const manager = createManager();
    await manager.install('builtin-balanced');

    const unit = fs.readFileSync(unitPath, 'utf8');
    expect(unit).toContain(`ExecStart=${scriptPath}`);
    expect(unit).toContain(`ConditionPathExists=${stateFile}`);
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('RemainAfterExit=yes');
    expect(unit).toContain('StandardError=journal');
    expect(unit).toContain('Restart=no');
  });

  it('reports the status after the installation', async () => {
    useExecMock(createSystemHandler());
    const manager = createManager();

    expect((await manager.status()).installed).toBe(false);

    await manager.install('builtin-balanced');
    const status = await manager.status();

    expect(status.installed).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.unitPath).toBe(unitPath);
    expect(status.profileId).toBe('builtin-balanced');
    expect(status.polkitInstalled).toBe(true);
    expect(status.helperInstalled).toBe(true);
    expect(status.lastAppliedAt).toBeNull();
    expect(status.lastError).toBeNull();
  });

  it('reports a disabled unit', async () => {
    useExecMock(createSystemHandler({ enabled: false }));
    const manager = createManager();
    await manager.install('builtin-balanced');

    const status = await manager.status();
    expect(status.installed).toBe(true);
    expect(status.enabled).toBe(false);
  });

  it('removes everything on uninstall', async () => {
    useExecMock(createSystemHandler());
    const manager = createManager();
    await manager.install('builtin-balanced');

    const result = await manager.uninstall();

    expect(result.ok).toBe(true);
    expect(fs.existsSync(unitPath)).toBe(false);
    expect(fs.existsSync(scriptPath)).toBe(false);
    expect(fs.existsSync(policyPath)).toBe(false);
    expect(fs.existsSync(stateFile)).toBe(false);

    const status = await manager.status();
    expect(status.installed).toBe(false);
    expect(status.profileId).toBeNull();
  });

  it('enables and disables the unit', async () => {
    const calls = useExecMock(createSystemHandler());
    const manager = createManager();
    await manager.install('builtin-balanced');

    calls.length = 0;

    expect((await manager.setEnabled(false)).ok).toBe(true);
    expect(calls.some((call) => call.includes('disable'))).toBe(true);

    calls.length = 0;
    expect((await manager.setEnabled(true)).ok).toBe(true);
    expect(calls.some((call) => call.includes('enable') && call.includes('--now'))).toBe(true);
  });

  it('applies now through the same path the unit uses', async () => {
    const calls = useExecMock(createSystemHandler());
    const manager = createManager();
    await manager.install('builtin-balanced');

    calls.length = 0;
    const result = await manager.applyNow();

    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.includes('restart'))).toBe(true);
  });

  it('refuses to apply now when the service is not installed', async () => {
    useExecMock(createSystemHandler());
    const manager = createManager();

    const result = await manager.applyNow();

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('ainda não foi instalada');
  });

  it('returns a clear error on a machine without systemd', async () => {
    useExecMock(createSystemHandler());
    const manager = createManager({ available: false });

    const result = await manager.install('builtin-balanced');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.AdapterUnavailable);
    expect(result.error?.message).toContain('systemd');
  });

  it('surfaces the stderr of a failing systemctl', async () => {
    useExecMock(
      createSystemHandler({ failStderr: 'Failed to enable unit: Unit file is masked.' }),
    );
    const manager = createManager();

    const result = await manager.install('builtin-balanced');

    expect(result.ok).toBe(false);
    expect(result.error?.detail).toContain('Unit file is masked');
    expect(result.error?.message).toContain('Não foi possível');
  });

  it('never builds a shell command out of the profile id', async () => {
    const calls = useExecMock(createSystemHandler());
    const manager = createManager();

    await manager.install('builtin-balanced');

    for (const call of calls) {
      for (const argument of call) {
        expect(argument).not.toMatch(/[;&|`$><]/);
      }
    }
  });
});

describe('renderServiceUnit', () => {
  it('matches the shipped unit file', () => {
    const shipped = fs.readFileSync(
      path.join(RESOURCES_DIR, 'gpu-power-manager-persist.service'),
      'utf8',
    );

    expect(
      renderServiceUnit({
        unitName: 'gpu-power-manager-persist.service',
        scriptPath: '/usr/local/lib/gpu-power-manager/gpu-power-manager-apply.py',
        stateFile: '/var/lib/gpu-power-manager/profile.json',
      }),
    ).toBe(shipped);
  });
});
