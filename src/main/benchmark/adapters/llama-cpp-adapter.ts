/**
 * llama.cpp adapter.
 *
 * Talks to a llama.cpp server (default http://127.0.0.1:8080), OpenAI
 * compatible.
 *
 *  - detection: GET /health (or /props), then a MINIMAL completion request.
 *    A server that answers /health but cannot generate a token (an embedding
 *    only server, for instance) is NOT available: the benchmark needs tokens.
 *  - run:       POST /v1/completions, falling back to the native /completion
 *
 * The token count comes from the answer of the server (`usage.completion_tokens`
 * or `timings.predicted_n`). The rate prefers the server's own measurement
 * (`timings.predicted_per_second`) and only falls back to the wall clock when
 * the server does not report one.
 */

import { ErrorCode, type ThroughputResult, type WorkloadKind } from '../../../shared/types';
import {
  DEFAULT_LLAMA_CPP_URL,
  type AdapterEndpointsResolver,
} from '../../settings/settings-endpoints';
import { normalizeBaseUrl, requestJson } from './http';
import {
  AdapterError,
  readNumber,
  readObject,
  type AdapterDetection,
  type AdapterThroughputResult,
  type WorkloadAdapter,
  type WorkloadRunContext,
} from './types';

export { DEFAULT_LLAMA_CPP_URL };

const DEFAULT_PROMPT =
  'Responda em português com um parágrafo curto explicando o que é eficiência energética em GPUs.';
const DEFAULT_MAX_TOKENS = 128;

/** Probe of the completion capability: the smallest request that proves it. */
const PROBE_MAX_TOKENS = 1;
const PROBE_PROMPT = 'ok';

export interface LlamaCppAdapterOptions {
  /** Base URL of the llama.cpp server. Overrides the configured endpoint. */
  baseUrl?: string | null;
  /** Endpoints currently configured by the user. */
  endpoints?: AdapterEndpointsResolver;
  /** Prompt sent to the model. */
  prompt?: string;
  /** Number of tokens to generate. */
  maxTokens?: number;
  /** Sampling temperature. 0 keeps the benchmark reproducible. */
  temperature?: number;
  /** Timeout of a generation, in milliseconds. */
  timeoutMs?: number;
  /** Timeout of the detection probe, in milliseconds. */
  detectTimeoutMs?: number;
  /** Timeout of the completion capability probe, in milliseconds. */
  probeTimeoutMs?: number;
}

export class LlamaCppAdapter implements WorkloadAdapter {
  readonly id = 'llama-cpp';
  readonly name = 'llama.cpp';
  readonly workload: WorkloadKind = 'llm-inference';

  private readonly configuredBaseUrl: string | null;
  private readonly endpoints: AdapterEndpointsResolver | null;
  private readonly prompt: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly detectTimeoutMs: number;
  private readonly probeTimeoutMs: number;

  constructor(options: LlamaCppAdapterOptions = {}) {
    this.configuredBaseUrl = options.baseUrl ?? null;
    this.endpoints = options.endpoints ?? null;
    this.prompt = options.prompt ?? DEFAULT_PROMPT;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.temperature = options.temperature ?? 0;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.detectTimeoutMs = options.detectTimeoutMs ?? 2_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 30_000;
  }

  /**
   * The URL this adapter talks to.
   *
   * It is resolved on every use: the user may change the endpoint in the
   * settings while the application is running.
   */
  private get baseUrl(): string {
    const configured = this.endpoints?.().llamaCppUrl ?? null;
    const url = this.configuredBaseUrl ?? configured ?? DEFAULT_LLAMA_CPP_URL;
    return normalizeBaseUrl(url);
  }

  async detect(): Promise<AdapterDetection> {
    const health = await this.probe(`${this.baseUrl}/health`);
    if (!health.ok) {
      const props = await this.probe(`${this.baseUrl}/props`);
      if (!props.ok) {
        return {
          available: false,
          endpoint: this.baseUrl,
          hint: `Servidor llama.cpp não encontrado em ${this.baseUrl}. Inicie com "llama-server -m <modelo> --port 8080".`,
        };
      }
    }

    // The server answers, but it may be unable to produce a single token: an
    // embedding only server answers /health and refuses every completion.
    const completion = await this.probeCompletion();
    if (completion.ok) {
      return {
        available: true,
        endpoint: this.baseUrl,
        hint: `Servidor llama.cpp detectado em ${this.baseUrl}.`,
      };
    }

    return {
      available: false,
      endpoint: this.baseUrl,
      hint:
        `O servidor llama.cpp em ${this.baseUrl} responde, mas não gera tokens: ${completion.detail}. ` +
        'Se for um servidor de embeddings, reinicie-o sem --embedding.',
    };
  }

  async run(ctx: WorkloadRunContext): Promise<ThroughputResult> {
    const startedAt = performance.now();

    let payload: unknown;
    let source: string;
    try {
      payload = await requestJson(
        `${this.baseUrl}/v1/completions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: this.prompt,
            max_tokens: this.maxTokens,
            temperature: this.temperature,
            stream: false,
          }),
        },
        { timeoutMs: this.timeoutMs, signal: ctx.signal },
      );
      source = 'llama.cpp /v1/completions';
    } catch (error) {
      // Older llama.cpp builds do not expose the OpenAI compatible route.
      if (!(error instanceof AdapterError) || error.status === null) throw error;
      const original = error;
      try {
        payload = await requestJson(
          `${this.baseUrl}/completion`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt: this.prompt,
              n_predict: this.maxTokens,
              temperature: this.temperature,
              stream: false,
            }),
          },
          { timeoutMs: this.timeoutMs, signal: ctx.signal },
        );
        source = 'llama.cpp /completion';
      } catch (fallbackError) {
        // Both routes failed: the ORIGINAL error is the one that explains
        // why (an embedding only server refuses the completion route with a
        // message the fallback would hide).
        throw new AdapterError(
          original.code,
          `${original.message} (a rota alternativa /completion também falhou: ${describeError(
            fallbackError,
          )})`,
          original.status,
        );
      }
    }

    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    const timings = readObject(payload, 'timings');
    const usage = readObject(payload, 'usage');

    const tokens =
      (usage ? readNumber(usage, 'completion_tokens') : null) ??
      (timings ? readNumber(timings, 'predicted_n') : null) ??
      readNumber(payload, 'tokens_predicted');

    if (tokens === null || tokens <= 0) {
      throw new AdapterError(
        ErrorCode.BenchmarkFailed,
        'A resposta do llama.cpp não informou quantos tokens foram gerados (usage.completion_tokens).',
      );
    }

    const serverRate = timings ? readNumber(timings, 'predicted_per_second') : null;
    const perSecond = serverRate ?? (elapsedSeconds > 0 ? tokens / elapsedSeconds : null);

    const result: AdapterThroughputResult = {
      unit: 'token',
      count: tokens,
      label: 'tokens gerados',
      source,
      perSecond,
    };
    return result;
  }

  private async probe(url: string): Promise<{ ok: boolean }> {
    try {
      await requestJson(url, { method: 'GET' }, { timeoutMs: this.detectTimeoutMs });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Probes the completion capability of the server.
   *
   * A minimal completion is the only honest proof: `/health` answers "ok" on
   * an embedding only server, which cannot produce the tokens the benchmark
   * needs.
   */
  private async probeCompletion(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.postCompletion(
        `${this.baseUrl}/v1/completions`,
        { prompt: PROBE_PROMPT, max_tokens: PROBE_MAX_TOKENS },
        this.probeTimeoutMs,
      );
      return { ok: true, detail: '' };
    } catch (error) {
      const detail = describeError(error);
      // Older builds do not expose the OpenAI route: try the native one.
      if (error instanceof AdapterError && error.status === 404) {
        try {
          await this.postCompletion(
            `${this.baseUrl}/completion`,
            { prompt: PROBE_PROMPT, n_predict: PROBE_MAX_TOKENS },
            this.probeTimeoutMs,
          );
          return { ok: true, detail: '' };
        } catch {
          // The ORIGINAL error is the one that explains the failure.
          return { ok: false, detail };
        }
      }
      return { ok: false, detail };
    }
  }

  /** Sends a minimal completion request to one of the two routes. */
  private async postCompletion(
    url: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    return requestJson(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, temperature: 0, stream: false }),
      },
      { timeoutMs },
    );
  }
}

/** A short, user readable description of a failed request. */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message.trim();
  return String(error);
}
