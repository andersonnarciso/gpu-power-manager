/**
 * Ollama adapter.
 *
 * Talks to a local Ollama server (default http://127.0.0.1:11434).
 *
 *  - detection: GET /api/tags
 *  - run:       POST /api/generate with stream disabled
 *
 * The throughput comes from the real answer of the server: `eval_count` is the
 * number of generated tokens and `eval_duration` is the time the server spent
 * generating them, in nanoseconds.
 */

import { ErrorCode, type ThroughputResult, type WorkloadKind } from '../../../shared/types';
import {
  DEFAULT_OLLAMA_URL,
  type AdapterEndpointsResolver,
} from '../../settings/settings-endpoints';
import { normalizeBaseUrl, requestJson } from './http';
import {
  AdapterError,
  readNumber,
  type AdapterDetection,
  type AdapterThroughputResult,
  type WorkloadAdapter,
  type WorkloadRunContext,
} from './types';

export { DEFAULT_OLLAMA_URL };

const DEFAULT_PROMPT =
  'Responda em português com um parágrafo curto explicando o que é eficiência energética em GPUs.';
const DEFAULT_NUM_PREDICT = 128;

export interface OllamaAdapterOptions {
  /** Base URL of the Ollama server. Overrides the configured endpoint. */
  baseUrl?: string | null;
  /** Endpoints currently configured by the user. */
  endpoints?: AdapterEndpointsResolver;
  /** Model to use. When null the first model of /api/tags is used. */
  model?: string | null;
  /** Prompt sent to the model. */
  prompt?: string;
  /** Number of tokens to generate. */
  numPredict?: number;
  /** Timeout of a generation, in milliseconds. */
  timeoutMs?: number;
  /** Timeout of the detection probe, in milliseconds. */
  detectTimeoutMs?: number;
}

export class OllamaAdapter implements WorkloadAdapter {
  readonly id = 'ollama';
  readonly name = 'Ollama';
  readonly workload: WorkloadKind = 'llm-inference';

  private readonly configuredBaseUrl: string | null;
  private readonly endpoints: AdapterEndpointsResolver | null;
  private readonly model: string | null;
  private readonly prompt: string;
  private readonly numPredict: number;
  private readonly timeoutMs: number;
  private readonly detectTimeoutMs: number;

  constructor(options: OllamaAdapterOptions = {}) {
    this.configuredBaseUrl = options.baseUrl ?? null;
    this.endpoints = options.endpoints ?? null;
    this.model = options.model ?? null;
    this.prompt = options.prompt ?? DEFAULT_PROMPT;
    this.numPredict = options.numPredict ?? DEFAULT_NUM_PREDICT;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.detectTimeoutMs = options.detectTimeoutMs ?? 2_000;
  }

  /**
   * The URL this adapter talks to.
   *
   * It is resolved on every use: the user may change the endpoint in the
   * settings while the application is running.
   */
  private get baseUrl(): string {
    const configured = this.endpoints?.().ollamaUrl ?? null;
    const url = this.configuredBaseUrl ?? configured ?? DEFAULT_OLLAMA_URL;
    return normalizeBaseUrl(url);
  }

  async detect(): Promise<AdapterDetection> {
    try {
      const payload = await requestJson(
        `${this.baseUrl}/api/tags`,
        { method: 'GET' },
        { timeoutMs: this.detectTimeoutMs },
      );
      const models = readModelNames(payload);
      const hint =
        models.length > 0
          ? `Ollama detectado em ${this.baseUrl} (${models.length} modelo(s) instalado(s)).`
          : `Ollama detectado em ${this.baseUrl}, mas nenhum modelo está instalado.`;
      return { available: true, endpoint: this.baseUrl, hint };
    } catch {
      return {
        available: false,
        endpoint: this.baseUrl,
        hint: `Ollama não respondeu em ${this.baseUrl}. Inicie o servidor com "ollama serve".`,
      };
    }
  }

  async run(ctx: WorkloadRunContext): Promise<ThroughputResult> {
    const model = await this.resolveModel(ctx.signal);

    const body = {
      model,
      prompt: this.prompt,
      stream: false,
      options: { num_predict: this.numPredict },
      keep_alive: '5m',
    };

    const payload = await requestJson(
      `${this.baseUrl}/api/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      { timeoutMs: this.timeoutMs, signal: ctx.signal },
    );

    const evalCount = readNumber(payload, 'eval_count');
    if (evalCount === null || evalCount <= 0) {
      throw new AdapterError(
        ErrorCode.BenchmarkFailed,
        'A resposta do Ollama não informou quantos tokens foram gerados (eval_count).',
      );
    }

    const evalDuration = readNumber(payload, 'eval_duration');
    const perSecond =
      evalDuration !== null && evalDuration > 0 ? evalCount / (evalDuration / 1e9) : null;

    const result: AdapterThroughputResult = {
      unit: 'token',
      count: evalCount,
      label: 'tokens gerados',
      source: 'ollama /api/generate',
      perSecond,
    };
    return result;
  }

  /** Uses the configured model, or the first model reported by the server. */
  private async resolveModel(signal: AbortSignal): Promise<string> {
    if (this.model && this.model.trim().length > 0) return this.model;

    const payload = await requestJson(
      `${this.baseUrl}/api/tags`,
      { method: 'GET' },
      { timeoutMs: this.detectTimeoutMs, signal },
    );
    const models = readModelNames(payload);
    if (models.length === 0) {
      throw new AdapterError(
        ErrorCode.AdapterUnavailable,
        'Nenhum modelo está instalado no Ollama. Rode "ollama pull <modelo>" antes do benchmark.',
      );
    }
    return models[0];
  }
}

/** Extracts the model names from an /api/tags payload. */
function readModelNames(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const models = (payload as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];
  const names: string[] = [];
  for (const entry of models) {
    if (!entry || typeof entry !== 'object') continue;
    const name = (entry as Record<string, unknown>).name;
    if (typeof name === 'string' && name.length > 0) names.push(name);
  }
  return names;
}
