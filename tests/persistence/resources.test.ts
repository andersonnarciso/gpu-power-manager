import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const RESOURCES_DIR = path.resolve(process.cwd(), 'resources', 'systemd');
const SCRIPT_PATH = path.join(RESOURCES_DIR, 'gpu-power-manager-apply.py');
const UNIT_PATH = path.join(RESOURCES_DIR, 'gpu-power-manager-persist.service');
// The application ships a single polkit policy that declares every action it
// needs. It lives in the sibling `polkit` folder.
const POLICY_PATH = path.resolve(
  process.cwd(),
  'resources',
  'polkit',
  'com.gpupowermanager.policy',
);

const GPU_4070 = 'GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1';
const GPU_5060 = 'GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646';

function hasPython(): boolean {
  const result = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

const pythonAvailable = hasPython();

let workspace: string;
let fakeSmi: string;
let recordFile: string;
let stateFile: string;

beforeEach(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'gpupm-helper-'));
  recordFile = path.join(workspace, 'calls.log');
  stateFile = path.join(workspace, 'profile.json');

  fakeSmi = path.join(workspace, 'nvidia-smi');
  fs.writeFileSync(
    fakeSmi,
    [
      '#!/bin/sh',
      'if [ "$1" = "-L" ]; then',
      '  echo "GPU 0: NVIDIA GeForce RTX 4070 Ti (UUID: ' + GPU_4070 + ')"',
      '  exit 0',
      'fi',
      'if [ "$1" = "--query-gpu=uuid,power.min_limit,power.max_limit,power.default_limit" ]; then',
      `  echo "${GPU_4070}, 100.00, 285.00, 285.00"`,
      `  echo "${GPU_5060}, 150.00, 180.00, 180.00"`,
      '  exit 0',
      'fi',
      'echo "$@" >> "$RECORD_FILE"',
      'exit 0',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o755 },
  );

  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        version: 1,
        profileId: 'builtin-balanced',
        profileName: 'Balanced',
        builtin: true,
        installedAt: 1_700_000_000_000,
        entries: [
          { uuid: GPU_4070, watts: null, strategy: 'ratio', ratio: 0.7 },
          { uuid: GPU_5060, watts: null, strategy: 'default' },
        ],
        lastAppliedAt: null,
        lastError: null,
      },
      null,
      2,
    ),
    'utf8',
  );
});

afterEach(async () => {
  await fsp.rm(workspace, { recursive: true, force: true });
});

describe('shipped systemd resources', () => {
  it('ships the unit, the helper and the polkit policy', () => {
    expect(fs.existsSync(UNIT_PATH)).toBe(true);
    expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
    expect(fs.existsSync(POLICY_PATH)).toBe(true);
  });

  it('starts the helper with python3', () => {
    const script = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(script.startsWith('#!/usr/bin/env python3')).toBe(true);
  });

  it('declares the polkit action used by the application', () => {
    const policy = fs.readFileSync(POLICY_PATH, 'utf8');
    expect(policy).toContain('com.gpupowermanager.manage-persistence');
    expect(policy).toContain('<allow_any>auth_admin</allow_any>');
  });

  it('ships one single polkit policy with every action the app needs', () => {
    const policy = fs.readFileSync(POLICY_PATH, 'utf8');
    expect(policy).toContain('com.gpupowermanager.set-power-limit');
    expect(policy).toContain('com.gpupowermanager.install-helper');
    expect(policy).toContain('com.gpupowermanager.manage-persistence');

    // There must not be a second, competing policy file.
    const shipped = fs
      .readdirSync(path.resolve(process.cwd(), 'resources', 'systemd'))
      .filter((name) => name.endsWith('.policy'));
    expect(shipped).toEqual([]);
  });

  it('does not depend on the Electron application', () => {
    const unit = fs.readFileSync(UNIT_PATH, 'utf8');
    expect(unit).not.toMatch(/electron/i);
    expect(unit).not.toMatch(/gpu-power-manager\b.*--no-sandbox/i);
    expect(unit).toContain('gpu-power-manager-apply.py');
  });
});

describe.skipIf(!pythonAvailable)('the privileged helper (python)', () => {
  it('is valid python', () => {
    const output = path.join(workspace, 'compiled.pyc');
    const result = spawnSync(
      'python3',
      [
        '-c',
        'import py_compile,sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)',
        SCRIPT_PATH,
        output,
      ],
      { encoding: 'utf8' },
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('waits for the driver, resolves the limits and applies them', () => {
    const result = spawnSync(
      'python3',
      [
        SCRIPT_PATH,
        '--state-file',
        stateFile,
        '--nvidia-smi',
        fakeSmi,
        '--poll-interval',
        '0.1',
      ],
      { encoding: 'utf8', env: { ...process.env, RECORD_FILE: recordFile } },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Driver NVIDIA disponível');

    const calls = fs.readFileSync(recordFile, 'utf8');
    expect(calls).toContain(`-i ${GPU_4070} -pl 230`);
    expect(calls).toContain(`-i ${GPU_5060} -pl 180`);

    // The state file records the last application.
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(typeof state.lastAppliedAt).toBe('number');
    expect(state.lastError).toBeNull();
  });

  it('does not touch the hardware on a dry run', () => {
    const result = spawnSync(
      'python3',
      [
        SCRIPT_PATH,
        '--state-file',
        stateFile,
        '--nvidia-smi',
        fakeSmi,
        '--poll-interval',
        '0.1',
        '--dry-run',
      ],
      { encoding: 'utf8', env: { ...process.env, RECORD_FILE: recordFile } },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('(dry-run)');
    expect(fs.existsSync(recordFile)).toBe(false);
  });

  it('gives up when the driver never shows up', () => {
    const brokenSmi = path.join(workspace, 'nvidia-smi-broken');
    fs.writeFileSync(brokenSmi, '#!/bin/sh\nexit 1\n', { encoding: 'utf8', mode: 0o755 });

    const result = spawnSync(
      'python3',
      [
        SCRIPT_PATH,
        '--state-file',
        stateFile,
        '--nvidia-smi',
        brokenSmi,
        '--timeout',
        '0.2',
        '--poll-interval',
        '0.1',
      ],
      { encoding: 'utf8', env: { ...process.env, RECORD_FILE: recordFile } },
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('não ficou disponível');
  });
});
