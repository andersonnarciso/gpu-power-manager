import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  GpuProcessService,
  detectFriendlyApp,
  isGraphicsOnlyApp,
  readProcCmdline,
  readProcCwd,
} from '../../src/main/processes/process-service';
import { NvidiaSmiClient, type ExecFileFn } from '../../src/main/nvidia/nvidia-smi';
import { nullLogger } from '../../src/main/nvidia/logger';
import { GPU_4070_UUID, REAL_COMPUTE_APPS_CSV } from '../nvidia/fixtures';

/** Builds an exec double that always answers with the same payload. */
function fixedExec(stdout: string): ExecFileFn {
  return async () => ({ stdout, stderr: '' });
}

/** Creates a fake /proc tree with a single process. */
function fakeProc(pid: number, cmdline: string, cwd?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpupm-proc-'));
  const dir = path.join(root, String(pid));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'cmdline'), cmdline.split(' ').join('\0') + '\0');
  if (cwd !== undefined) {
    // A symlink is what the kernel exposes for the working directory.
    fs.symlinkSync(cwd, path.join(dir, 'cwd'));
  }
  return root;
}

describe('processos: nome amigável', () => {
  it('reconhece o llama.cpp', () => {
    expect(detectFriendlyApp('llama-server')).toBe('llama.cpp');
    expect(detectFriendlyApp('llama-cli')).toBe('llama.cpp');
    expect(detectFriendlyApp('llama-bench')).toBe('llama.cpp');
    expect(detectFriendlyApp('/home/anderson/llama.cpp/build/bin/llama-server')).toBe(
      'llama.cpp',
    );
  });

  it('reconhece o Ollama', () => {
    expect(detectFriendlyApp('ollama')).toBe('Ollama');
    expect(detectFriendlyApp('ollama', 'ollama runner llama3:8b')).toBe('Ollama');
    // O Ollama traz o próprio llama-server: ele tem que ganhar do llama.cpp.
    expect(detectFriendlyApp('/usr/local/lib/ollama/llama-server')).toBe('Ollama');
  });

  it('reconhece o ComfyUI', () => {
    expect(detectFriendlyApp('python3', 'python3 main.py --listen', '/home/user/ComfyUI')).toBe(
      'ComfyUI',
    );
    expect(detectFriendlyApp('python3', '/opt/ComfyUI/main.py')).toBe('ComfyUI');
    expect(detectFriendlyApp('/opt/ComfyUI/run_webui.sh')).toBe('ComfyUI');
  });

  it('reconhece as demais famílias conhecidas', () => {
    expect(detectFriendlyApp('/usr/bin/python3')).toBe('Python');
    expect(detectFriendlyApp('python3.12')).toBe('Python');
    expect(detectFriendlyApp('/usr/bin/firefox')).toBe('Firefox');
    expect(detectFriendlyApp('/usr/bin/sunshine')).toBe('Sunshine');
    expect(detectFriendlyApp('/usr/bin/nvidia-smi')).toBe('NVIDIA');
    expect(detectFriendlyApp('/usr/bin/chromium-browser')).toBe('Chrome');
    expect(detectFriendlyApp('/opt/brave.com/brave-nightly/brave')).toBe('Brave');
    expect(detectFriendlyApp('/usr/bin/python3', 'python3 train.py --unsloth')).toBe('Unsloth');
    expect(detectFriendlyApp('/usr/libexec/gnome-remote-desktop-daemon')).toBe(
      'GNOME Remote Desktop',
    );
    expect(detectFriendlyApp('/usr/bin/nautilus')).toBe('Nautilus');
    expect(detectFriendlyApp('/usr/bin/ptyxis')).toBe('Ptyxis');
    expect(detectFriendlyApp('/usr/libexec/xdg-desktop-portal-gnome')).toBe('XDG Desktop Portal');
  });

  it('devolve null para um processo desconhecido', () => {
    expect(detectFriendlyApp('mystery-binary')).toBeNull();
    expect(detectFriendlyApp('')).toBeNull();
    expect(detectFriendlyApp('/usr/bin/systemd')).toBeNull();
  });

  it('classifica as aplicações que só desenham', () => {
    expect(isGraphicsOnlyApp('/usr/bin/nautilus')).toBe(true);
    expect(isGraphicsOnlyApp('/usr/libexec/gnome-remote-desktop-daemon')).toBe(true);
    expect(isGraphicsOnlyApp('/usr/bin/python')).toBe(false);
    // Os auxiliares de GPU do Chromium/Electron só desenham.
    expect(
      isGraphicsOnlyApp('/opt/app/antigravity', 'antigravity --type=gpu-process --ozone-platform'),
    ).toBe(true);
  });
});

describe('processos: leitura do /proc', () => {
  it('lê a linha de comando', () => {
    const root = fakeProc(4242, 'python3 main.py --listen 8188');
    expect(readProcCmdline(4242, root)).toBe('python3 main.py --listen 8188');
    expect(readProcCmdline(4242, path.join(root, 'inexistente'))).toBeNull();
  });

  it('lê o diretório de trabalho', () => {
    const root = fakeProc(4243, 'python3 main.py', '/home/user/ComfyUI');
    expect(readProcCwd(4243, root)).toBe('/home/user/ComfyUI');
  });

  it('degrada sem quebrar quando o processo some no meio da leitura', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpupm-proc-'));
    expect(readProcCmdline(999999, root)).toBeNull();
    expect(readProcCwd(999999, root)).toBeNull();
  });
});

describe('processos: listagem', () => {
  it('lê os processos reais do driver', async () => {
    const client = new NvidiaSmiClient({
      binaryPath: '/usr/bin/nvidia-smi',
      exec: fixedExec(REAL_COMPUTE_APPS_CSV),
      logger: nullLogger,
    });
    const service = new GpuProcessService({ client, procRoot: '/proc' });
    const processes = await service.list();

    expect(processes.length).toBeGreaterThan(0);
    const llama = processes.find((process) => process.pid === 2973);
    expect(llama?.gpuUuid).toBe(GPU_4070_UUID);
    expect(llama?.friendlyApp).toBe('llama.cpp');
    expect(llama?.usedMemoryMiB).toBe(768);
    expect(llama?.type).toBe('compute');

    const python = processes.find((process) => process.pid === 403545);
    expect(python?.friendlyApp).toBe('Python');

    const sunshine = processes.find((process) => process.pid === 296489);
    expect(sunshine?.friendlyApp).toBe('Sunshine');
  });

  it('usa o /proc para descobrir o ComfyUI', async () => {
    const root = fakeProc(7777, 'python3 main.py --listen', '/home/user/ComfyUI');
    const client = new NvidiaSmiClient({
      binaryPath: '/usr/bin/nvidia-smi',
      exec: fixedExec(
        `7777, python3, 512, ${GPU_4070_UUID}\n`,
      ),
      logger: nullLogger,
    });
    const service = new GpuProcessService({ client, procRoot: root });
    const processes = await service.list();
    expect(processes[0]?.friendlyApp).toBe('ComfyUI');
  });

  it('degrada sem quebrar quando o /proc não existe', async () => {
    const client = new NvidiaSmiClient({
      binaryPath: '/usr/bin/nvidia-smi',
      exec: fixedExec(REAL_COMPUTE_APPS_CSV),
      logger: nullLogger,
    });
    const service = new GpuProcessService({
      client,
      procRoot: '/proc/nao-existe-gpupm',
    });
    const processes = await service.list();
    expect(processes.length).toBeGreaterThan(0);
    // Sem /proc o nome vem do driver, então a detecção ainda funciona.
    expect(processes.find((process) => process.pid === 2973)?.friendlyApp).toBe('llama.cpp');
  });

  it('devolve uma lista vazia quando não há processos', async () => {
    const client = new NvidiaSmiClient({
      binaryPath: '/usr/bin/nvidia-smi',
      exec: fixedExec(''),
      logger: nullLogger,
    });
    const service = new GpuProcessService({ client });
    await expect(service.list()).resolves.toEqual([]);
  });
});

describe('processos: somente leitura', () => {
  it('o módulo nunca envia sinais nem mata processos', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/main/processes/process-service.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/process\.kill/);
    expect(source).not.toMatch(/SIGKILL|SIGTERM|SIGINT/);
    expect(source).not.toMatch(/writeFile|appendFile|unlink|rmdir/);
  });
});
