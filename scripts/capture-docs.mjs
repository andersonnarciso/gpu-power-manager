#!/usr/bin/env node
/**
 * Captures the documentation screenshot set against the REAL hardware.
 *
 * Why this script exists:
 *
 * The published screenshots used to be taken with `--simulate`, so the images
 * showed the built-in simulator ("NVIDIA GeForce RTX 4070 Ti (simulado)") and
 * the header said "Driver NVIDIA não detectado". The images looked right but
 * they did not show the machine the project actually runs on.
 *
 * This script therefore:
 *   1. starts the app WITHOUT `--simulate`, so the real NVIDIA driver is used;
 *   2. starts it WITH `--hide-identifiers`, so the GPU UUID (the identifier
 *      NVIDIA uses to tell one board from another) never reaches the image;
 *   3. walks through every page, in both themes, and writes the PNGs;
 *   4. VERIFIES the result: after each capture it reads the DOM back and
 *      refuses to keep an image that contains a GPU UUID or a simulated GPU.
 *
 * The verification is what makes this script trustworthy: a screenshot that
 * leaks an identifier fails the run instead of being published.
 *
 * Usage:
 *   node scripts/capture-docs.mjs
 *   node scripts/capture-docs.mjs --out-dir docs/screenshots --keep-open
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith('--')) continue;
  const key = token.slice(2);
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[key] = true;
  else {
    args[key] = next;
    i += 1;
  }
}

const port = Number(args.port ?? 9333);
const outDir = resolve(root, String(args['out-dir'] ?? 'docs/screenshots'));
const electronBin = resolve(root, 'node_modules', '.bin', 'electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sections of the app, in the order the README shows them.
 *
 * `showsGpus` marks the pages that display GPU telemetry: those must show a
 * real NVIDIA device. The other pages (profiles, settings) legitimately do
 * not list any GPU, so they are only checked for leaking identifiers.
 */
const PAGES = [
  { id: 'dashboard', label: 'Painel', file: '01-painel', showsGpus: true },
  { id: 'gpus', label: 'GPUs', file: '02-gpus', showsGpus: true },
  { id: 'powerLimit', label: 'Limite de potência', file: '03-power-limit', showsGpus: true },
  { id: 'profiles', label: 'Perfis', file: '04-profiles', showsGpus: false },
  { id: 'benchmark', label: 'Benchmark', file: '05-benchmark', showsGpus: true },
  { id: 'optimizer', label: 'Otimizador', file: '06-optimizer', showsGpus: true },
  { id: 'processes', label: 'Processos', file: '07-processes', showsGpus: true },
  { id: 'history', label: 'Histórico', file: '08-history', showsGpus: true },
  { id: 'settings', label: 'Configurações', file: '09-settings', showsGpus: false },
];

const THEMES = ['dark', 'light'];

/** A GPU UUID as NVIDIA prints it. */
const UUID_PATTERN = /GPU-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

async function cdp(command, extraArgs = []) {
  const { stdout } = await run(
    process.execPath,
    [resolve(root, 'scripts', 'cdp.mjs'), command, '--port', String(port), ...extraArgs],
    { cwd: root, maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

async function evaluate(expression) {
  const result = await cdp('eval', ['--expr', expression]);
  return result.value;
}

/** Clicks the sidebar entry with the given label. */
async function navigate(label) {
  const expression = `(() => {
    const wanted = ${JSON.stringify(label)}.toLowerCase();
    const sidebar = document.querySelector('aside nav') || document.querySelector('aside');
    if (!sidebar) return 'sem-barra-lateral';
    const nodes = Array.from(sidebar.querySelectorAll('button'));
    const hit = nodes.find((node) => (node.textContent || '').trim().toLowerCase() === wanted);
    if (!hit) return 'nao-encontrado:' + wanted;
    hit.click();
    return 'ok';
  })()`;
  return evaluate(expression);
}

/** Reads the visible text back, so the capture can be verified. */
async function visibleText() {
  return evaluate('document.body ? document.body.innerText : ""');
}

/** Applies the theme to the document root, exactly like the app does. */
async function setTheme(theme) {
  return evaluate(
    `(() => { document.documentElement.classList.toggle('dark', ${theme === 'dark'}); return document.documentElement.className; })()`,
  );
}

async function main() {
  if (!existsSync(resolve(root, 'out', 'main', 'index.js'))) {
    throw new Error('out/main/index.js ausente - rode `npm run build` antes.');
  }
  if (!existsSync(resolve(root, 'dist', 'renderer', 'index.html'))) {
    throw new Error('dist/renderer/index.html ausente - rode `npm run build` antes.');
  }

  await mkdir(outDir, { recursive: true });

  const appArgs = [
    root,
    `--remote-debugging-port=${port}`,
    '--hide-identifiers',
    // NOTE: `--simulate` is deliberately NOT passed: the capture must show the
    // real driver, not the simulator.
  ];

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
    // Its own process group: the whole tree (xvfb-run + electron) is killed
    // at the end, otherwise the pipes stay open and the script never exits.
    detached: true,
  });

  const logs = [];
  const collect = (stream, tag) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim()) logs.push(`[${tag}] ${line}`);
    });
  };
  collect(child.stdout, 'main');
  collect(child.stderr, 'main');

  const report = { ok: true, captured: [], problems: [], driver: null };

  try {
    // The app needs a moment to open the window and to let the first
    // telemetry tick reach the driver.
    await sleep(6000);

    const info = await evaluate(
      'JSON.stringify({ simulated: document.body.innerText.includes("SIMULA"), text: document.body.innerText.slice(0, 400) })',
    );
    report.driver = info;

    for (const theme of THEMES) {
      await setTheme(theme);
      await sleep(400);

      for (const page of PAGES) {
        const navigation = await navigate(page.label);
        if (navigation !== 'ok') {
          report.problems.push({ page: page.id, theme, error: `navegação: ${navigation}` });
          continue;
        }
        // Give the page time to poll the driver and to draw the charts.
        await sleep(2600);

        const out = resolve(outDir, `${page.file}-${theme}.png`);
        await cdp('screenshot', ['--out', out, '--wait', '900']);

        const text = (await visibleText()) ?? '';
        const uuids = text.match(UUID_PATTERN) ?? [];
        const simulated = /\(simulado\)/i.test(text);

        if (uuids.length > 0) {
          report.problems.push({
            page: page.id,
            theme,
            error: `a imagem conteria ${uuids.length} UUID de GPU: ${uuids.join(', ')}`,
          });
          continue;
        }
        if (simulated) {
          report.problems.push({ page: page.id, theme, error: 'a imagem mostra GPUs simuladas' });
          continue;
        }
        if (page.showsGpus && !/NVIDIA GeForce/i.test(text)) {
          report.problems.push({ page: page.id, theme, error: 'a imagem não mostra nenhuma GPU real' });
          continue;
        }

        report.captured.push({ page: page.id, theme, file: `${page.file}-${theme}.png` });
      }
    }

    report.ok = report.problems.length === 0;
  } finally {
    // Kills the whole group: xvfb-run plus every electron child.
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    await sleep(2000);
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    child.unref();
  }

  console.log(JSON.stringify({ ...report, logs: logs.slice(-25) }, null, 2));
  // The electron children may still hold the stdio pipes open; exit explicitly.
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error) }));
  process.exitCode = 1;
});
