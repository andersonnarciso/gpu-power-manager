#!/usr/bin/env node
/**
 * Development launcher.
 *
 * Starts three things concurrently:
 *   1. `tsc --watch` for the main + preload processes (CommonJS -> out/)
 *   2. `vite` for the renderer (ESM, HMR)
 *   3. `electron` pointed at the Vite dev server
 *
 * Electron is only spawned once Vite reports it is listening, and it is
 * always spawned as the current user - never as root.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_SERVER_URL = 'http://127.0.0.1:5273';

if (process.platform === 'win32') {
  console.error('[dev] Este projeto tem como alvo apenas Linux.');
  process.exit(1);
}

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.error(
    '[dev] Recusando executar como root. O app nunca deve rodar com privilégios administrativos.',
  );
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function run(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  const prefix = `[${name}]`;
  const pipe = (stream, target) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length > 0) target.write(`${prefix} ${line}\n`);
      }
    });
  };

  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`${prefix} exited with code ${code}. Shutting down.`);
      shutdown(code ?? 1);
    }
  });

  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 150);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// 1. main + preload compiler
run('tsc', 'npx', ['tsc', '-p', 'tsconfig.main.json', '--watch', '--preserveWatchOutput']);

// 2. renderer dev server
const vite = run('vite', 'npx', ['vite', '--host', '127.0.0.1', '--port', '5273', '--strictPort']);

// 3. electron, once the renderer server answers
const electronBinary = resolve(root, 'node_modules', '.bin', 'electron');
let electronStarted = false;

const tryStartElectron = () => {
  if (electronStarted) return;
  electronStarted = true;

  if (!existsSync(resolve(root, 'out', 'main', 'index.js'))) {
    console.error('[dev] out/main/index.js ainda não existe. Rode `npm run build:main` uma vez.');
    shutdown(1);
    return;
  }

  run('electron', electronBinary, ['.'], {
    VITE_DEV_SERVER_URL: DEV_SERVER_URL,
    NODE_ENV: 'development',
  });
};

vite.stdout.on('data', () => {
  // Vite prints "ready in" once the server accepts connections.
  setTimeout(tryStartElectron, 400);
});

setTimeout(() => {
  if (!electronStarted) {
    console.error('[dev] Timeout aguardando o servidor Vite.');
    shutdown(1);
  }
}, 45000);
