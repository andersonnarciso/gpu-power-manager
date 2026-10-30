#!/usr/bin/env node
/**
 * Dependency-free Chrome DevTools Protocol client.
 *
 * Connects to an already running Electron/Chromium instance that was started
 * with `--remote-debugging-port=<port>` and can:
 *   - capture a PNG screenshot of the page
 *   - evaluate arbitrary JavaScript in the page and print the JSON result
 *
 * Node 22 ships a global `WebSocket`, so this needs no npm dependency.
 *
 * Usage:
 *   node scripts/cdp.mjs screenshot --port 9333 --out /tmp/shot.png [--wait 1500]
 *   node scripts/cdp.mjs eval --port 9333 --expr "document.title"
 */
import { writeFile } from 'node:fs/promises';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function findPageTarget(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no target list';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
      lastError = `targets without page: ${JSON.stringify(targets.map((t) => t.type))}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Could not find a page target on port ${port}: ${lastError}`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;

    socket.addEventListener('open', () => {
      resolve({
        socket,
        send(method, params = {}) {
          const id = nextId;
          nextId += 1;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.close();
        },
      });
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(JSON.stringify(message.error)));
        else res(message.result);
      }
    });

    socket.addEventListener('error', (event) => reject(new Error(String(event.message ?? 'ws error'))));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const port = Number(args.port ?? 9333);

  const target = await findPageTarget(port);
  const client = await connect(target.webSocketDebuggerUrl);

  try {
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    if (command === 'screenshot') {
      const wait = Number(args.wait ?? 1200);
      await new Promise((resolve) => setTimeout(resolve, wait));
      const result = await client.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });
      const out = args.out ?? '/tmp/gpupm-screenshot.png';
      await writeFile(out, Buffer.from(result.data, 'base64'));
      console.log(JSON.stringify({ ok: true, out, title: target.title, url: target.url }));
    } else if (command === 'eval') {
      const expression = args.expr;
      if (!expression) throw new Error('--expr is required for eval');
      const result = await client.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      console.log(JSON.stringify({ ok: true, value: result.result?.value }, null, 2));
    } else {
      throw new Error(`Unknown command "${command}". Use "screenshot" or "eval".`);
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
