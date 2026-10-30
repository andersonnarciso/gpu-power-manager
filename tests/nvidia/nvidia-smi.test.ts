import { describe, expect, it } from 'vitest';

import {
  NVIDIA_SMI_FALLBACK_PATHS,
  NvidiaGpuSource,
  NvidiaSmiClient,
  NvidiaSmiError,
  locateNvidiaSmi,
  type ExecFileFn,
  type ExecFileOptions,
} from '../../src/main/nvidia/nvidia-smi';
import { nullLogger } from '../../src/main/nvidia/logger';
import { GPU_QUERY_FIELDS } from '../../src/main/nvidia/parse';
import {
  GPU_4070_UUID,
  GPU_5060_UUID,
  REAL_COMPUTE_APPS_CSV,
  REAL_GPU_CSV,
  REAL_PERFORMANCE_OUTPUT,
  REAL_THROTTLE_CSV,
} from './fixtures';

interface ExecCall {
  file: string;
  args: readonly string[];
  options: ExecFileOptions;
}

interface FakeExec {
  fn: ExecFileFn;
  calls: ExecCall[];
}

/** Builds an exec double that answers with the given payloads. */
function fakeExec(responses: Array<{ stdout?: string; stderr?: string; error?: Error }>): FakeExec {
  const calls: ExecCall[] = [];
  let index = 0;
  const fn: ExecFileFn = async (file, args, options) => {
    calls.push({ file, args: [...args], options });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!response) return { stdout: '', stderr: '' };
    if (response.error) throw response.error;
    return { stdout: response.stdout ?? '', stderr: response.stderr ?? '' };
  };
  return { fn, calls };
}

/** Builds a client that never writes to stderr during the tests. */
function createClient(exec?: ExecFileFn): NvidiaSmiClient {
  return new NvidiaSmiClient({
    binaryPath: '/usr/bin/nvidia-smi',
    exec,
    logger: nullLogger,
  });
}

/** Builds a CSV with `count` valid GPU rows, based on the real capture. */
function gpuCsvWithCount(count: number): string {
  const template = REAL_GPU_CSV.split('\n')[0] as string;
  const rows: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const uuid = `GPU-0000000${i}-1111-2222-3333-44444444444${i}`;
    rows.push(template.replace(GPU_4070_UUID, uuid).replace(/^0,/, `${i},`));
  }
  return rows.join('\n');
}

describe('nvidia-smi: localização do binário', () => {
  it('encontra o binário no PATH', () => {
    const found = locateNvidiaSmi({
      pathEnv: '/opt/empty:/opt/gpu/bin',
      isExecutable: (candidate) => candidate === '/opt/gpu/bin/nvidia-smi',
    });
    expect(found).toBe('/opt/gpu/bin/nvidia-smi');
  });

  it('cai para os caminhos padrão quando o PATH não tem o binário', () => {
    const found = locateNvidiaSmi({
      pathEnv: '/opt/empty',
      isExecutable: (candidate) => candidate === '/usr/bin/nvidia-smi',
    });
    expect(found).toBe('/usr/bin/nvidia-smi');
  });

  it('devolve null quando o driver não existe', () => {
    const found = locateNvidiaSmi({ pathEnv: '/opt/empty', isExecutable: () => false });
    expect(found).toBeNull();
  });

  it('mantém a lista de caminhos padrão do Linux', () => {
    expect(NVIDIA_SMI_FALLBACK_PATHS).toContain('/usr/bin/nvidia-smi');
    expect(NVIDIA_SMI_FALLBACK_PATHS).toContain('/usr/lib/wsl/lib/nvidia-smi');
    expect(NVIDIA_SMI_FALLBACK_PATHS).toContain('/usr/lib/x86_64-linux-gnu/nvidia-smi');
  });
});

describe('nvidia-smi: uma execução por ciclo', () => {
  it('usa exatamente um processo para 2 GPUs', async () => {
    const exec = fakeExec([{ stdout: REAL_GPU_CSV }]);
    const client = createClient(exec.fn);
    const devices = await client.queryGpuList();
    expect(devices).toHaveLength(2);
    expect(exec.calls).toHaveLength(1);
  });

  it('usa exatamente um processo para 8 GPUs', async () => {
    const exec = fakeExec([{ stdout: gpuCsvWithCount(8) }]);
    const client = createClient(exec.fn);
    const devices = await client.queryGpuList();
    expect(devices).toHaveLength(8);
    expect(exec.calls).toHaveLength(1);
  });

  it('mantém um processo por ciclo durante vários ciclos', async () => {
    const exec = fakeExec([{ stdout: REAL_GPU_CSV }]);
    const client = createClient(exec.fn);
    const source = new NvidiaGpuSource({ client });
    await source.poll();
    await source.poll();
    await source.poll();
    expect(exec.calls).toHaveLength(3);
  });

  it('passa os argumentos como array e nunca monta um comando de shell', async () => {
    const exec = fakeExec([{ stdout: REAL_GPU_CSV }]);
    const client = createClient(exec.fn);
    await client.queryGpuList();
    const call = exec.calls[0];
    expect(call?.file).toBe('/usr/bin/nvidia-smi');
    expect(Array.isArray(call?.args)).toBe(true);
    expect(call?.args[0]).toBe(`--query-gpu=${GPU_QUERY_FIELDS.join(',')}`);
    expect(call?.args[1]).toBe('--format=csv,noheader,nounits');
    // Nenhum argumento pode conter um separador de shell.
    for (const argument of call?.args ?? []) {
      expect(argument).not.toMatch(/[;&|`$><]/);
    }
    expect(call?.options.timeout).toBeGreaterThan(0);
  });
});

describe('nvidia-smi: falhas do driver', () => {
  it('converte ENOENT em driver indisponível', async () => {
    const error = new Error('spawn nvidia-smi ENOENT');
    (error as NodeJS.ErrnoException).code = 'ENOENT';
    const exec = fakeExec([{ error }]);
    const client = createClient(exec.fn);
    await expect(client.queryGpuList()).rejects.toBeInstanceOf(NvidiaSmiError);
    await expect(client.queryGpuList()).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
  });

  it('converte uma saída não zero em comando falho', async () => {
    const error = new Error('Command failed: nvidia-smi');
    (error as { code?: string | number }).code = 2;
    const exec = fakeExec([{ error }]);
    const client = createClient(exec.fn);
    await expect(client.queryGpuList()).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  });

  it('converte um processo morto por tempo limite em timeout', async () => {
    const error = new Error('killed');
    (error as { killed?: boolean }).killed = true;
    const exec = fakeExec([{ error }]);
    const client = createClient(exec.fn);
    await expect(client.queryGpuList()).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('propaga erro de parse quando a saída é lixo', async () => {
    const exec = fakeExec([{ stdout: 'isto não é um CSV de GPU' }]);
    const client = createClient(exec.fn);
    await expect(client.queryGpuList()).rejects.toThrow(/campos/);
  });
});

describe('nvidia-smi: versão do CUDA', () => {
  it('lê a versão do banner', async () => {
    const exec = fakeExec([{ stdout: '| NVIDIA-SMI 595.84   CUDA Version: 13.2     |' }]);
    const client = createClient(exec.fn);
    await expect(client.queryCudaVersion()).resolves.toBe('13.2');
  });

  it('devolve null quando o banner não tem versão do CUDA', async () => {
    const exec = fakeExec([{ stdout: 'sem banner' }]);
    const client = createClient(exec.fn);
    await expect(client.queryCudaVersion()).resolves.toBeNull();
  });

  it('reutiliza a versão em cache sem chamar o driver de novo', async () => {
    const exec = fakeExec([{ stdout: 'CUDA Version: 13.2' }, { stdout: REAL_GPU_CSV }]);
    const client = createClient(exec.fn);
    await client.queryCudaVersion();
    expect(client.getCachedCudaVersion()).toBe('13.2');
    const devices = await client.queryGpuList();
    expect(devices[0]?.cudaVersion).toBe('13.2');
    expect(exec.calls).toHaveLength(2);
  });
});

describe('nvidia-smi: motivos de throttling', () => {
  it('usa a query quando o driver suporta os campos', async () => {
    const exec = fakeExec([{ stdout: REAL_THROTTLE_CSV }]);
    const client = createClient(exec.fn);
    const result = await client.queryThrottleReasons();
    expect(result.supported).toBe(true);
    expect(result.readings).toHaveLength(2);
    expect(exec.calls).toHaveLength(1);
  });

  it('cai para -q -d PERFORMANCE quando a query é recusada', async () => {
    const error = new Error('Field "clocks_event_reasons.sw_power_cap" is not a valid field');
    const exec = fakeExec([{ error }, { stdout: REAL_PERFORMANCE_OUTPUT }]);
    const client = createClient(exec.fn);
    const result = await client.queryThrottleReasons();
    expect(result.supported).toBe(true);
    expect(result.readings[0]?.busId).toBe('00000000:01:00.0');
    expect(exec.calls).toHaveLength(2);
  });

  it('devolve "não suportado" em vez de lançar quando tudo falha', async () => {
    const error = new Error('boom');
    const exec = fakeExec([{ error }]);
    const client = createClient(exec.fn);
    const result = await client.queryThrottleReasons();
    expect(result.supported).toBe(false);
    expect(result.readings).toEqual([]);
  });
});

describe('nvidia-smi: processos', () => {
  it('lê as aplicações de compute com o UUID da GPU', async () => {
    const exec = fakeExec([{ stdout: REAL_COMPUTE_APPS_CSV }]);
    const client = createClient(exec.fn);
    const rows = await client.queryGpuProcesses();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.gpuUuid === GPU_4070_UUID)).toBe(true);
    expect(rows.some((row) => row.gpuUuid === GPU_5060_UUID)).toBe(true);
  });

  it('cai para a consulta sem gpu_uuid quando o campo é recusado', async () => {
    const error = new Error('Field "gpu_uuid" is not a valid field to query.');
    const exec = fakeExec([
      { error },
      { stdout: '2973, /home/anderson/llama.cpp/build/bin/llama-server, 768\n' },
    ]);
    const client = createClient(exec.fn);
    const rows = await client.queryGpuProcesses();
    expect(rows[0]?.pid).toBe(2973);
    expect(rows[0]?.gpuUuid).toBeNull();
    expect(rows[0]?.usedMemoryMiB).toBe(768);
  });

  it('cai para o pmon quando as aplicações contabilizadas não são suportadas', async () => {
    const error = new Error('Field "gpu_utilization" is not a valid field to query.');
    const exec = fakeExec([
      { stdout: REAL_COMPUTE_APPS_CSV },
      { error },
      { stdout: '# gpu  pid  type  sm  mem  enc  dec  jpg  ofa  command\n    0  2973     C   -   -   -   -   -   -   llama-server\n' },
    ]);
    const client = createClient(exec.fn);
    const rows = await client.queryGpuProcesses();
    expect(rows.some((row) => row.processName === 'llama-server')).toBe(true);
  });

  it('devolve uma lista vazia quando não há processos', async () => {
    const exec = fakeExec([{ stdout: '' }]);
    const client = createClient(exec.fn);
    await expect(client.queryGpuProcesses()).resolves.toEqual([]);
  });
});

describe('nvidia-smi: fonte real', () => {
  it('não é simulada', () => {
    const source = new NvidiaGpuSource({
      client: createClient(),
    });
    expect(source.isSimulated()).toBe(false);
  });

  it('faz o bootstrap da versão do CUDA fora do ciclo', async () => {
    const exec = fakeExec([{ stdout: 'CUDA Version: 13.2' }, { stdout: REAL_GPU_CSV }]);
    const source = new NvidiaGpuSource({
      client: createClient(exec.fn),
    });
    await source.prime();
    await source.poll();
    expect(exec.calls).toHaveLength(2);
  });
});
