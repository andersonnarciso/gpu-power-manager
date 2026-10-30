/**
 * GPU process monitor.
 *
 * This module is **read only**. It never sends a signal, never kills and
 * never writes anything: it only reads the driver output and the `/proc`
 * entries of the processes that use the GPU.
 *
 * The friendly name detection is what makes the process panel useful: the
 * driver only knows paths, the user cares about "ComfyUI" or "Ollama".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { GpuProcess } from '../../shared/types';
import type { ProcessService } from '../../shared/contracts';
import { createLogger, nullLogger, type Logger } from '../nvidia/logger';
import { NvidiaSmiClient } from '../nvidia/nvidia-smi';

/* --------------------------------------------------------------- detection */

/** Applications that only use the GPU for drawing, not for computing. */
const GRAPHICS_APP_PATTERNS: readonly RegExp[] = [
  /gnome-shell/,
  /gnome-remote-desktop/,
  /xdg-desktop-portal/,
  /kwin_x11/,
  /kwin_wayland/,
  /kwayland/,
  /plasmashell/,
  /xwayland/,
  /\bxorg\b/,
  /nautilus/,
  /telegram-desktop/,
  /brave/,
  /chrome/,
  /chromium/,
  /firefox/,
  /electron/,
  /ptyxis/,
  /weston/,
  /mutter/,
  // Chromium/Electron spawn a helper process dedicated to the GPU.
  /--type=gpu-process/,
];

/**
 * Detects the application family of a process.
 *
 * Both the process name and the full command line are inspected, because
 * the command line carries the information the name does not (the model of
 * an Ollama runner, the working directory of a ComfyUI instance, ...).
 *
 * Returns `null` when the process is not recognised.
 */
export function detectFriendlyApp(
  processName: string,
  cmdline?: string | null,
  cwd?: string | null,
): string | null {
  const name = (processName ?? '').toLowerCase();
  const cmd = (cmdline ?? '').toLowerCase();
  const dir = (cwd ?? '').toLowerCase();
  const haystack = `${name} ${cmd}`;

  // ComfyUI: a python process running `main.py` from a ComfyUI checkout.
  if (isComfyUi(name, cmd, dir)) return 'ComfyUI';
  // Ollama ships its own `llama-server`, so it has to win over llama.cpp.
  if (haystack.includes('ollama')) return 'Ollama';
  if (haystack.includes('llama.cpp') || /llama-(server|cli|bench|runner)/.test(haystack)) {
    return 'llama.cpp';
  }
  if (haystack.includes('unsloth')) return 'Unsloth';
  if (isPython(name, cmd)) return 'Python';
  if (haystack.includes('chromium') || haystack.includes('chrome')) return 'Chrome';
  if (haystack.includes('brave')) return 'Brave';
  if (haystack.includes('firefox')) return 'Firefox';
  if (haystack.includes('edge')) return 'Edge';
  if (haystack.includes('sunshine')) return 'Sunshine';
  if (haystack.includes('nvidia')) return 'NVIDIA';
  if (haystack.includes('gnome-shell')) return 'GNOME Shell';
  if (haystack.includes('gnome-remote-desktop')) return 'GNOME Remote Desktop';
  if (haystack.includes('xdg-desktop-portal')) return 'XDG Desktop Portal';
  if (haystack.includes('xwayland') || /\bxorg\b/.test(haystack)) return 'Xorg';
  if (haystack.includes('kwin') || haystack.includes('kwayland')) return 'KWin';
  if (haystack.includes('plasmashell')) return 'Plasma Shell';
  if (haystack.includes('nautilus')) return 'Nautilus';
  if (haystack.includes('ptyxis')) return 'Ptyxis';
  return null;
}

/** True for a ComfyUI server: python running `main.py` in a ComfyUI folder. */
function isComfyUi(name: string, cmd: string, dir: string): boolean {
  const mentionsMain = cmd.includes('main.py') || name.includes('main.py');
  const mentionsComfy = cmd.includes('comfyui') || dir.includes('comfyui') || name.includes('comfyui');
  if (mentionsComfy) return true;
  return mentionsMain && dir.includes('comfy');
}

/** True for a python interpreter. */
function isPython(name: string, cmd: string): boolean {
  const basename = name.split('/').pop() ?? '';
  if (/^python[0-9.]*$/.test(basename)) return true;
  return /(?:^|\s)python[0-9.]*(?:\s|$)/.test(cmd);
}

/** True when the process is a known drawing-only application. */
export function isGraphicsOnlyApp(processName: string, cmdline?: string | null): boolean {
  const haystack = `${processName ?? ''} ${cmdline ?? ''}`.toLowerCase();
  return GRAPHICS_APP_PATTERNS.some((pattern) => pattern.test(haystack));
}

/* ------------------------------------------------------------------- /proc */

/** Reads `/proc/<pid>/cmdline`, returning the arguments joined by spaces. */
export function readProcCmdline(pid: number, procRoot = '/proc'): string | null {
  try {
    const raw = fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8');
    const parts = raw.split('\0').filter((part) => part !== '');
    return parts.length > 0 ? parts.join(' ') : null;
  } catch {
    return null;
  }
}

/** Reads `/proc/<pid>/cwd`. Fails silently when the process is gone. */
export function readProcCwd(pid: number, procRoot = '/proc'): string | null {
  try {
    return fs.readlinkSync(path.join(procRoot, String(pid), 'cwd'));
  } catch {
    return null;
  }
}

/** Reads `/proc/<pid>/comm`. Fails silently when the process is gone. */
export function readProcComm(pid: number, procRoot = '/proc'): string | null {
  try {
    const raw = fs.readFileSync(path.join(procRoot, String(pid), 'comm'), 'utf8');
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- service */

export interface ProcessServiceOptions {
  /** Driver client used to list the GPU processes. */
  client?: NvidiaSmiClient;
  /** Root of the proc filesystem. Defaults to `/proc`. */
  procRoot?: string;
  /** Injectable logger. */
  logger?: Logger;
}

export class GpuProcessService implements ProcessService {
  private readonly client: NvidiaSmiClient;
  private readonly procRoot: string;
  private readonly logger: Logger;

  constructor(options: ProcessServiceOptions = {}) {
    this.client = options.client ?? new NvidiaSmiClient();
    this.procRoot = options.procRoot ?? '/proc';
    this.logger = options.logger ?? nullLogger;
  }

  /**
   * Lists every process that uses a GPU.
   *
   * A process that disappears between the driver query and the `/proc` read
   * is still reported, with the information the driver gave us.
   */
  async list(): Promise<GpuProcess[]> {
    const rows = await this.client.queryGpuProcesses();
    const processes: GpuProcess[] = [];

    for (const row of rows) {
      const cmdline = readProcCmdline(row.pid, this.procRoot);
      const cwd = readProcCwd(row.pid, this.procRoot);
      const name =
        row.processName !== ''
          ? row.processName
          : (readProcComm(row.pid, this.procRoot) ?? `pid ${row.pid}`);
      const friendlyApp = detectFriendlyApp(name, cmdline, cwd);
      const type =
        row.type === 'compute' && isGraphicsOnlyApp(name, cmdline) ? 'graphics' : row.type;

      processes.push({
        pid: row.pid,
        name,
        gpuUuid: row.gpuUuid,
        usedMemoryMiB: row.usedMemoryMiB,
        type,
        friendlyApp,
      });
    }

    this.logger.debug(`${processes.length} processos usando a GPU.`);
    return processes.sort(compareProcesses);
  }
}

/** Heaviest user first, then by pid, so the order is stable. */
function compareProcesses(a: GpuProcess, b: GpuProcess): number {
  const memoryA = a.usedMemoryMiB ?? -1;
  const memoryB = b.usedMemoryMiB ?? -1;
  if (memoryA !== memoryB) return memoryB - memoryA;
  return a.pid - b.pid;
}
