/**
 * ComfyUI HTTP client.
 *
 * Shared by the image generation adapter and by the video generation adapter:
 * both submit a workflow to /prompt and wait for it in /history.
 */

import { ErrorCode } from '../../../shared/types';
import {
  DEFAULT_COMFYUI_URL,
  type AdapterEndpointsResolver,
} from '../../settings/settings-endpoints';
import { delay, normalizeBaseUrl, requestJson } from './http';
import { AdapterError, readObject, type AdapterDetection } from './types';

export { DEFAULT_COMFYUI_URL };

export interface ComfyUiClientOptions {
  /** Base URL of the ComfyUI server. Overrides the configured endpoint. */
  baseUrl?: string | null;
  /** Endpoints currently configured by the user. */
  endpoints?: AdapterEndpointsResolver;
  /** Timeout of a single HTTP request, in milliseconds. */
  requestTimeoutMs?: number;
  /** Timeout of the detection probe, in milliseconds. */
  detectTimeoutMs?: number;
  /** Interval between two history polls, in milliseconds. */
  pollIntervalMs?: number;
  /** Maximum time waiting for the workflow to finish, in milliseconds. */
  completionTimeoutMs?: number;
}

/** The `outputs` map of a finished ComfyUI prompt. */
export type ComfyUiOutputs = Record<string, unknown>;

export interface ComfyUiHistoryEntry {
  outputs: ComfyUiOutputs;
  status: Record<string, unknown> | null;
}

export class ComfyUiClient {
  private readonly configuredBaseUrl: string | null;
  private readonly endpoints: AdapterEndpointsResolver | null;
  private readonly requestTimeoutMs: number;
  private readonly detectTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly completionTimeoutMs: number;

  constructor(options: ComfyUiClientOptions = {}) {
    this.configuredBaseUrl = options.baseUrl ?? null;
    this.endpoints = options.endpoints ?? null;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.detectTimeoutMs = options.detectTimeoutMs ?? 2_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.completionTimeoutMs = options.completionTimeoutMs ?? 600_000;
  }

  /**
   * The URL this client talks to.
   *
   * It is resolved on every use: the user may change the endpoint in the
   * settings while the application is running.
   */
  get baseUrl(): string {
    const configured = this.endpoints?.().comfyUiUrl ?? null;
    const url = this.configuredBaseUrl ?? configured ?? DEFAULT_COMFYUI_URL;
    return normalizeBaseUrl(url);
  }

  async detect(): Promise<AdapterDetection> {
    try {
      await requestJson(
        `${this.baseUrl}/system_stats`,
        { method: 'GET' },
        { timeoutMs: this.detectTimeoutMs },
      );
      return {
        available: true,
        endpoint: this.baseUrl,
        hint: `ComfyUI detectado em ${this.baseUrl}.`,
      };
    } catch {
      try {
        await requestJson(
          `${this.baseUrl}/object_info`,
          { method: 'GET' },
          { timeoutMs: this.detectTimeoutMs },
        );
        return {
          available: true,
          endpoint: this.baseUrl,
          hint: `ComfyUI detectado em ${this.baseUrl} (via /object_info).`,
        };
      } catch {
        return {
          available: false,
          endpoint: this.baseUrl,
          hint: `ComfyUI não respondeu em ${this.baseUrl}. Inicie o servidor do ComfyUI para habilitar esta medição.`,
        };
      }
    }
  }

  /** Sends the workflow to /prompt and returns the prompt id. */
  async submitPrompt(prompt: unknown, signal?: AbortSignal): Promise<string> {
    const payload = await requestJson(
      `${this.baseUrl}/prompt`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      },
      { timeoutMs: this.requestTimeoutMs, signal },
    );

    const raw =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>).prompt_id
        : undefined;
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new AdapterError(
        ErrorCode.BenchmarkFailed,
        'O ComfyUI não devolveu um prompt_id ao receber o workflow.',
      );
    }
    return raw;
  }

  /** Polls /history until the prompt finishes. */
  async waitForCompletion(
    promptId: string,
    signal?: AbortSignal,
  ): Promise<ComfyUiHistoryEntry> {
    const deadline = Date.now() + this.completionTimeoutMs;

    for (;;) {
      if (signal?.aborted) {
        throw new AdapterError(ErrorCode.CommandFailed, 'Medição cancelada pelo usuário.');
      }

      const payload = await requestJson(
        `${this.baseUrl}/history/${encodeURIComponent(promptId)}`,
        { method: 'GET' },
        { timeoutMs: this.requestTimeoutMs, signal },
      );

      const entry = readHistoryEntry(payload, promptId);
      if (entry) {
        const error = readStatusError(entry.status);
        if (error) {
          throw new AdapterError(
            ErrorCode.BenchmarkFailed,
            `O ComfyUI reportou erro na execução do workflow: ${error}`,
          );
        }
        return entry;
      }

      if (Date.now() >= deadline) {
        throw new AdapterError(
          ErrorCode.Timeout,
          `Tempo esgotado (${Math.round(this.completionTimeoutMs / 1000)} s) aguardando o ComfyUI concluir o workflow.`,
        );
      }

      await delay(this.pollIntervalMs, signal);
    }
  }
}

/** Extracts the history entry of a prompt from the /history payload. */
function readHistoryEntry(payload: unknown, promptId: string): ComfyUiHistoryEntry | null {
  if (!payload || typeof payload !== 'object') return null;
  const container = payload as Record<string, unknown>;
  const raw = container[promptId] ?? container[Object.keys(container)[0] ?? ''];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const entry = raw as Record<string, unknown>;
  const outputs = entry.outputs;
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return null;

  return {
    outputs: outputs as ComfyUiOutputs,
    status: readObject(entry, 'status'),
  };
}

/** Turns the ComfyUI status block into a readable error message. */
function readStatusError(status: Record<string, unknown> | null): string | null {
  if (!status) return null;
  const statusStr = status.status_str;
  if (typeof statusStr !== 'string') return null;
  if (statusStr === 'success' || statusStr === 'completed') return null;

  const messages = status.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const text = (message as Record<string, unknown>).message;
      if (typeof text === 'string' && text.trim().length > 0) return text.trim();
    }
  }
  return statusStr;
}
