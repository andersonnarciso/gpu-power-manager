import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyUiAdapter } from '../../src/main/benchmark/adapters/comfyui-adapter';
import { LlamaCppAdapter } from '../../src/main/benchmark/adapters/llama-cpp-adapter';
import { ManualAdapter } from '../../src/main/benchmark/adapters/manual-adapter';
import { OllamaAdapter } from '../../src/main/benchmark/adapters/ollama-adapter';
import { UnslothAdapter } from '../../src/main/benchmark/adapters/unsloth-adapter';
import { CudaSyntheticAdapter } from '../../src/main/benchmark/adapters/cuda-synthetic-adapter';
import type { AdapterThroughputResult } from '../../src/main/benchmark/adapters/types';

const GPU_A = 'GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1';

const CONTEXT = {
  uuids: [GPU_A],
  signal: new AbortController().signal,
  durationLimitSeconds: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: unknown, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ManualAdapter', () => {
  it('is always available and never invents a throughput', async () => {
    const adapter = new ManualAdapter();

    const detection = await adapter.detect();
    expect(detection.available).toBe(true);
    expect(detection.endpoint).toBeNull();

    const result = await adapter.run(CONTEXT);
    expect(result.unit).toBe('unknown');
    expect(result.count).toBe(0);
  });
});

describe('OllamaAdapter', () => {
  it('computes the throughput from the real answer of the server', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/tags')) {
        return jsonResponse({ models: [{ name: 'qwen2.5:3b' }] });
      }
      if (url.endsWith('/api/generate')) {
        return jsonResponse({
          model: 'qwen2.5:3b',
          eval_count: 128,
          eval_duration: 2_000_000_000,
          done: true,
        });
      }
      return jsonResponse({}, 404);
    });

    const adapter = new OllamaAdapter();
    const detection = await adapter.detect();
    expect(detection.available).toBe(true);
    expect(detection.endpoint).toBe('http://127.0.0.1:11434');

    const result = (await adapter.run(CONTEXT)) as AdapterThroughputResult;
    expect(result.unit).toBe('token');
    expect(result.count).toBe(128);
    expect(result.perSecond).toBeCloseTo(64, 6);
    expect(result.source).toBe('ollama /api/generate');
  });

  it('sends the model, the prompt and the token budget', async () => {
    const fetchMock = mockFetch((url) => {
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'tiny' }] });
      return jsonResponse({ eval_count: 4, eval_duration: 1_000_000_000 });
    });

    const adapter = new OllamaAdapter({ model: 'tiny', numPredict: 32 });
    await adapter.run(CONTEXT);

    const call = fetchMock.mock.calls.find(
      (entry) => String(entry[0]).endsWith('/api/generate'),
    );
    expect(call).toBeDefined();
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as {
      model: string;
      stream: boolean;
      options: { num_predict: number };
    };
    expect(body.model).toBe('tiny');
    expect(body.stream).toBe(false);
    expect(body.options.num_predict).toBe(32);
  });

  it('fails with a clear error when the server is unreachable', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });

    const adapter = new OllamaAdapter();
    const detection = await adapter.detect();
    expect(detection.available).toBe(false);
    expect(detection.hint).toMatch(/ollama serve/i);

    await expect(adapter.run(CONTEXT)).rejects.toThrow(/Não foi possível conectar/i);
  });

  it('fails when the answer does not report the generated tokens', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'tiny' }] });
      return jsonResponse({ done: true });
    });

    const adapter = new OllamaAdapter();
    await expect(adapter.run(CONTEXT)).rejects.toThrow(/tokens/i);
  });
});

describe('LlamaCppAdapter', () => {
  it('uses the token count reported by the server', async () => {
    mockFetch((url) => {
      if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
      if (url.endsWith('/v1/completions')) {
        return jsonResponse({
          choices: [{ text: 'olá' }],
          usage: { completion_tokens: 42, prompt_tokens: 11 },
        });
      }
      return jsonResponse({}, 404);
    });

    const adapter = new LlamaCppAdapter();
    const detection = await adapter.detect();
    expect(detection.available).toBe(true);

    const result = (await adapter.run(CONTEXT)) as AdapterThroughputResult;
    expect(result.count).toBe(42);
    expect(result.unit).toBe('token');
    expect(result.source).toBe('llama.cpp /v1/completions');
    expect(result.perSecond).toBeGreaterThan(0);
  });

  it('prefers the rate reported by the server timings', async () => {
    mockFetch((url) => {
      if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
      return jsonResponse({
        choices: [{ text: 'olá' }],
        usage: { completion_tokens: 100 },
        timings: { predicted_n: 100, predicted_per_second: 55.5 },
      });
    });

    const adapter = new LlamaCppAdapter();
    const result = (await adapter.run(CONTEXT)) as AdapterThroughputResult;
    expect(result.perSecond).toBeCloseTo(55.5, 6);
  });

  it('fails when the server does not report the generated tokens', async () => {
    mockFetch((url) => {
      if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
      return jsonResponse({ choices: [{ text: 'olá' }] });
    });

    const adapter = new LlamaCppAdapter();
    await expect(adapter.run(CONTEXT)).rejects.toThrow(/tokens/i);
  });

  it('is unavailable when no server answers', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });

    const adapter = new LlamaCppAdapter();
    const detection = await adapter.detect();
    expect(detection.available).toBe(false);
    expect(detection.hint).toMatch(/llama-server/i);
  });

  it('reports an embedding only server as unavailable', async () => {
    // The server answers /health, but refuses every completion because it
    // was started with --embedding.
    mockFetch((url) => {
      if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
      return jsonResponse(
        { error: { message: 'the current context does not logits computation. skipping' } },
        500,
      );
    });

    const adapter = new LlamaCppAdapter();
    const detection = await adapter.detect();

    expect(detection.available).toBe(false);
    expect(detection.hint).toMatch(/não gera tokens/i);
    // The message of the server is not thrown away.
    expect(detection.hint).toMatch(/does not logits computation/i);
    expect(detection.hint).toMatch(/embedding/i);
  });

  it('reports the original error when the fallback route also fails', async () => {
    mockFetch((url) => {
      if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
      return jsonResponse(
        { error: { message: 'the current context does not logits computation. skipping' } },
        500,
      );
    });

    const adapter = new LlamaCppAdapter();
    await expect(adapter.run(CONTEXT)).rejects.toThrow(/does not logits computation/i);
  });

  it('detects a server that really generates tokens', async () => {
    mockFetch((url) => {
      if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
      return jsonResponse({ choices: [{ text: 'ok' }], usage: { completion_tokens: 1 } });
    });

    const adapter = new LlamaCppAdapter();
    const detection = await adapter.detect();

    expect(detection.available).toBe(true);
    expect(detection.endpoint).toBe('http://127.0.0.1:8080');
  });
});

describe('ComfyUiAdapter', () => {
  it('counts the images produced by the workflow', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gpupm-comfy-'));
    const workflowPath = join(directory, 'workflow.json');
    await writeFile(
      workflowPath,
      JSON.stringify({ '3': { class_type: 'KSampler' }, '9': { class_type: 'SaveImage' } }),
      'utf8',
    );

    mockFetch((url) => {
      if (url.endsWith('/system_stats')) return jsonResponse({ system: {} });
      if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'abc-123' });
      if (url.includes('/history/abc-123')) {
        return jsonResponse({
          'abc-123': {
            outputs: {
              '9': { images: [{ filename: 'a.png' }, { filename: 'b.png' }] },
              '12': { images: [{ filename: 'c.png' }] },
            },
            status: { status_str: 'success' },
          },
        });
      }
      return jsonResponse({}, 404);
    });

    const adapter = new ComfyUiAdapter({ workflowPath });
    const detection = await adapter.detect();
    expect(detection.available).toBe(true);

    const result = (await adapter.run(CONTEXT)) as AdapterThroughputResult;
    expect(result.unit).toBe('image');
    expect(result.count).toBe(3);
    expect(result.source).toBe('comfyui /history');

    await rm(directory, { recursive: true, force: true });
  });

  it('fails with a precise error when the workflow file is missing', async () => {
    const adapter = new ComfyUiAdapter({
      workflowPath: '/tmp/nao-existe-workflow-12345.json',
    });

    await expect(adapter.run(CONTEXT)).rejects.toThrow(
      /não encontrado.*nao-existe-workflow-12345\.json/i,
    );
  });

  it('fails when no workflow file is configured', async () => {
    const adapter = new ComfyUiAdapter();
    await expect(adapter.run(CONTEXT)).rejects.toThrow(/workflow/i);
  });
});

describe('UnslothAdapter', () => {
  it('parses the JSON line printed by the command', async () => {
    const adapter = new UnslothAdapter({
      command: 'node',
      args: ['-e', 'console.log(JSON.stringify({tokens: 100, duration_s: 4}))'],
    });

    const result = (await adapter.run(CONTEXT)) as AdapterThroughputResult;
    expect(result.count).toBe(100);
    expect(result.perSecond).toBeCloseTo(25, 6);
    expect(result.source).toContain('node');
  });

  it('fails with a clear error when the output cannot be parsed', async () => {
    const adapter = new UnslothAdapter({
      command: 'node',
      args: ['-e', 'console.log("isto nao e json")'],
    });

    await expect(adapter.run(CONTEXT)).rejects.toThrow(/JSON esperado/i);
  });

  it('is unavailable when no command is configured', async () => {
    const adapter = new UnslothAdapter();
    const detection = await adapter.detect();

    expect(detection.available).toBe(false);
    expect(detection.hint).toMatch(/Configure o comando/i);
    await expect(adapter.run(CONTEXT)).rejects.toThrow(/comando/i);
  });
});

describe('CudaSyntheticAdapter', () => {
  it('reports honestly whether the CUDA toolchain is available', async () => {
    const adapter = new CudaSyntheticAdapter();
    const detection = await adapter.detect();

    expect(typeof detection.available).toBe('boolean');
    if (!detection.available) {
      expect(detection.hint).toMatch(/nvcc|CUDA/i);
      await expect(adapter.run(CONTEXT)).rejects.toThrow(/nvcc/i);
    }
  });
});
