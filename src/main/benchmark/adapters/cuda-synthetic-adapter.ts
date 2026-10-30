/**
 * Reproducible local CUDA load.
 *
 * The adapter compiles a small CUDA kernel with `nvcc` and runs it on the GPU.
 * The kernel reports how many iterations it executed and how long the GPU took,
 * so the measurement is real and repeatable.
 *
 * When the CUDA toolchain is not installed the adapter reports itself as
 * unavailable with a hint. It never pretends to have run.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode, type ThroughputResult, type WorkloadKind } from '../../../shared/types';
import { findExecutable, runCommand } from './command';
import {
  AdapterError,
  type AdapterDetection,
  type AdapterThroughputResult,
  type WorkloadAdapter,
  type WorkloadRunContext,
} from './types';

export interface CudaSyntheticAdapterOptions {
  /** Number of iterations executed by each thread of the synthetic kernel. */
  iterations?: number;
  /** Timeout of the compilation, in milliseconds. */
  compileTimeoutMs?: number;
  /** Timeout of the execution, in milliseconds. */
  runTimeoutMs?: number;
  /** Path of the nvcc binary. When null it is looked up in the PATH. */
  nvccPath?: string | null;
}

const DEFAULT_ITERATIONS = 20_000_000;

/** Kernel used for the synthetic load. It is intentionally simple and stable. */
const CUDA_SOURCE = `#include <cstdio>
#include <cstdlib>
#include <chrono>
#include <cuda_runtime.h>

__global__ void burn_kernel(float* out, unsigned long long iters_per_thread, float seed) {
  const unsigned long long index =
      (unsigned long long)blockIdx.x * (unsigned long long)blockDim.x + (unsigned long long)threadIdx.x;
  const unsigned long long threads = (unsigned long long)gridDim.x * (unsigned long long)blockDim.x;
  if (index >= threads) return;

  float x = seed + (float)index * 1e-7f;
  for (unsigned long long k = 0; k < iters_per_thread; ++k) {
    x = fmaf(x, 1.0000001f, 0.0001f);
    x = fmaf(x, 0.5f, 0.25f);
  }
  if (x == 1234.5678f) out[index] = x;
}

int main(int argc, char** argv) {
  // The argument is the number of iterations executed by each thread.
  const unsigned long long iters_per_thread =
      argc > 1 ? strtoull(argv[1], nullptr, 10) : 20000000ULL;
  const int threads_per_block = 256;
  const int blocks = 1024;
  const unsigned long long total_threads =
      (unsigned long long)blocks * (unsigned long long)threads_per_block;

  float* device = nullptr;
  if (cudaMalloc(&device, sizeof(float) * total_threads) != cudaSuccess) {
    fprintf(stderr, "cudaMalloc falhou\\n");
    return 2;
  }

  // Warm up: the first launch pays for the module loading.
  burn_kernel<<<blocks, threads_per_block>>>(device, iters_per_thread, 1.0f);
  if (cudaDeviceSynchronize() != cudaSuccess) {
    fprintf(stderr, "falha na execucao do kernel\\n");
    return 3;
  }

  const auto start = std::chrono::steady_clock::now();
  burn_kernel<<<blocks, threads_per_block>>>(device, iters_per_thread, 2.0f);
  if (cudaDeviceSynchronize() != cudaSuccess) {
    fprintf(stderr, "falha na execucao do kernel\\n");
    return 4;
  }
  const auto end = std::chrono::steady_clock::now();
  const double seconds = std::chrono::duration<double>(end - start).count();

  printf("{\\"iterations\\": %llu, \\"seconds\\": %.6f}\\n", iters_per_thread * total_threads, seconds);

  cudaFree(device);
  return 0;
}
`;

export class CudaSyntheticAdapter implements WorkloadAdapter {
  readonly id = 'cuda-synthetic';
  readonly name = 'Carga sintética CUDA';
  readonly workload: WorkloadKind = 'cuda-synthetic';

  private readonly iterations: number;
  private readonly compileTimeoutMs: number;
  private readonly runTimeoutMs: number;
  private readonly nvccPath: string | null;

  constructor(options: CudaSyntheticAdapterOptions = {}) {
    this.iterations = options.iterations ?? DEFAULT_ITERATIONS;
    this.compileTimeoutMs = options.compileTimeoutMs ?? 180_000;
    this.runTimeoutMs = options.runTimeoutMs ?? 600_000;
    this.nvccPath = options.nvccPath ?? null;
  }

  async detect(): Promise<AdapterDetection> {
    const nvcc = this.resolveNvcc();
    if (!nvcc) {
      return {
        available: false,
        endpoint: null,
        hint: 'nvcc não encontrado. Instale o CUDA Toolkit (pacote nvidia-cuda-toolkit) para habilitar a carga sintética.',
      };
    }
    return {
      available: true,
      endpoint: nvcc,
      hint: `nvcc encontrado em ${nvcc}. A carga sintética será compilada e executada na GPU.`,
    };
  }

  async run(ctx: WorkloadRunContext): Promise<ThroughputResult> {
    const nvcc = this.resolveNvcc();
    if (!nvcc) {
      throw new AdapterError(
        ErrorCode.AdapterUnavailable,
        'nvcc não encontrado: instale o CUDA Toolkit para executar a carga sintética.',
      );
    }

    const workdir = await mkdtemp(join(tmpdir(), 'gpu-pm-cuda-'));
    const sourcePath = join(workdir, 'burn.cu');
    const binaryPath = join(workdir, 'burn');

    try {
      await writeFile(sourcePath, CUDA_SOURCE, 'utf8');
      await this.compile(nvcc, sourcePath, binaryPath, ctx.signal);

      const startedAt = Date.now();
      const result = await runCommand(
        binaryPath,
        [String(this.iterations)],
        {
          timeoutMs: this.runTimeoutMs,
          signal: ctx.signal,
          maxBuffer: 1024 * 1024,
        },
      );
      const wallSeconds = (Date.now() - startedAt) / 1000;

      const parsed = parseKernelResult(result.stdout);
      if (parsed === null) {
        throw new AdapterError(
          ErrorCode.BenchmarkFailed,
          'A carga sintética CUDA não devolveu o resultado esperado ({"iterations": N, "seconds": X}).',
        );
      }

      const perSecond = parsed.seconds > 0 ? parsed.iterations / parsed.seconds : null;
      const throughput: AdapterThroughputResult = {
        unit: 'unknown',
        count: parsed.iterations,
        label: 'iterações da carga sintética',
        source: 'nvcc (carga sintética CUDA)',
        perSecond: perSecond ?? (wallSeconds > 0 ? parsed.iterations / wallSeconds : null),
      };
      return throughput;
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Compiles the kernel, falling back to the default architecture. */
  private async compile(
    nvcc: string,
    sourcePath: string,
    binaryPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const attempts: string[][] = [
      ['-O2', '-arch=native', '-o', binaryPath, sourcePath],
      ['-O2', '-o', binaryPath, sourcePath],
    ];

    let lastError: unknown = null;
    for (const args of attempts) {
      try {
        await runCommand(nvcc, args, {
          timeoutMs: this.compileTimeoutMs,
          signal,
          maxBuffer: 4 * 1024 * 1024,
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new AdapterError(
      ErrorCode.CommandFailed,
      `Falha ao compilar a carga sintética CUDA com nvcc: ${message}`,
    );
  }

  private resolveNvcc(): string | null {
    if (this.nvccPath) return this.nvccPath;
    return findExecutable('nvcc');
  }
}

/** Parses the JSON line printed by the synthetic kernel. */
function parseKernelResult(stdout: string): { iterations: number; seconds: number } | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') continue;
      const record = parsed as Record<string, unknown>;
      const iterations = record.iterations;
      const seconds = record.seconds;
      if (
        typeof iterations === 'number' &&
        Number.isFinite(iterations) &&
        typeof seconds === 'number' &&
        Number.isFinite(seconds)
      ) {
        return { iterations, seconds };
      }
    } catch {
      continue;
    }
  }
  return null;
}
