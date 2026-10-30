#!/usr/bin/env node
/**
 * Launches the built Electron app headlessly (Xvfb), captures screenshots and
 * optionally evaluates JavaScript inside the running app.
 *
 * This is the real-application verification path: it exercises the actual
 * Electron main process, the preload bridge and the IPC layer against the
 * real NVIDIA driver on this machine.
 *
 * Usage:
 *   node scripts/capture-app.mjs --out /tmp/gpupm --eval "document.title"
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (token.startsWith('--')) {
    const key = token.slice(2);
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
}

const port = Number(args.port ?? 9333);
const outPrefix = args.out ?? '/tmp/gpupm';
const shots = Number(args.shots ?? 1);
const gap = Number(args.gap ?? 2500);

if (!existsSync(resolve(root, 'out', 'main', 'index.js'))) {
  console.error(JSON.stringify({ ok: false, error: 'out/main/index.js missing - run npm run build:main' }));
  process.exit(1);
}

const electronBin = resolve(root, 'node_modules', '.bin', 'electron');
const appArgs = [root, `--remote-debugging-port=${port}`, '--no-sandbox=false'];

const hasXvfb = existsSync('/usr/bin/xvfb-run');
const command = hasXvfb ? 'xvfb-run' : electronBin;
const commandArgs = hasXvfb
  ? ['-a', '--server-args=-screen 0 1920x1080x24', electronBin, ...appArgs]
  : appArgs;

const child = spawn(command, commandArgs, {
  cwd: root,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});

const logs = [];
const capture = (stream, tag) => {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      if (line.trim()) logs.push(`[${tag}] ${line}`);
    }
  });
};
capture(child.stdout, 'main');
capture(child.stderr, 'main');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cdp(argsList) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [resolve(root, 'scripts', 'cdp.mjs'), ...argsList], {
    cwd: root,
  });
  return JSON.parse(stdout);
}

async function waitForExitCode(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return child.exitCode;
    await sleep(300);
  }
  return null;
}

const results = [];
let exitCode = null;

try {
  await sleep(3500);

  for (let index = 0; index < shots; index += 1) {
    const out = `${outPrefix}-${index + 1}.png`;
    try {
      const shot = await cdp(['screenshot', '--port', String(port), '--out', out, '--wait', '600']);
      results.push(shot);
    } catch (error) {
      results.push({ ok: false, error: error.message });
    }
    if (index < shots - 1) await sleep(gap);
  }

  if (args.eval) {
    try {
      const evaluated = await cdp(['eval', '--port', String(port), '--expr', String(args.eval)]);
      results.push(evaluated);
    } catch (error) {
      results.push({ ok: false, error: error.message });
    }
  }
} finally {
  child.kill('SIGTERM');
  exitCode = await waitForExitCode(5000);
  if (exitCode === null) child.kill('SIGKILL');
}

console.log(JSON.stringify({ ok: true, results, exitCode, logs: logs.slice(-60) }, null, 2));
