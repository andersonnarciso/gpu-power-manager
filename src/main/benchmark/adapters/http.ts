/**
 * Tiny HTTP helper shared by the adapters.
 *
 * It uses the global `fetch` of Node 22 (no extra dependency) and always
 * enforces a timeout, so a dead server can never freeze the benchmark engine.
 */

import { ErrorCode } from '../../../shared/types';
import { AdapterError } from './types';

export interface HttpRequestOptions {
  /** Hard timeout in milliseconds. */
  timeoutMs?: number;
  /** External abort signal (the benchmark being stopped). */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Performs a request and returns the parsed JSON body.
 *
 * Throws `AdapterError` with a user readable message for every failure mode:
 * unreachable host, timeout, non 2xx status, malformed JSON.
 */
export async function requestJson(
  url: string,
  init: RequestInit = {},
  options: HttpRequestOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (options.signal) signals.push(options.signal);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError') {
      throw new AdapterError(
        ErrorCode.Timeout,
        `Tempo esgotado (${timeoutMs} ms) ao falar com ${url}.`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AdapterError(
      ErrorCode.CommandFailed,
      `Não foi possível conectar em ${url}: ${message}`,
    );
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const detail = extractErrorDetail(text);
    throw new AdapterError(
      ErrorCode.CommandFailed,
      `${url} respondeu ${response.status} ${response.statusText}`.trim() +
        (detail === '' ? '' : `: ${detail}`),
      response.status,
    );
  }

  if (payload === null && text.length > 0) {
    throw new AdapterError(
      ErrorCode.CommandFailed,
      `${url} respondeu com um corpo que não é JSON válido.`,
      response.status,
    );
  }

  return payload;
}

/** Normalises a base URL, removing the trailing slash. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Extracts the message the server sent with an error.
 *
 * The body of a failed request is the only place where the server explains
 * itself ("the current context does not logits computation"), so it must not
 * be thrown away.
 */
export function extractErrorDetail(body: string): string {
  const text = (body ?? '').trim();
  if (text === '') return '';

  try {
    const payload = JSON.parse(text) as unknown;
    if (payload && typeof payload === 'object') {
      const error = (payload as Record<string, unknown>).error;
      if (typeof error === 'string' && error.trim() !== '') return error.trim();
      if (error && typeof error === 'object') {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === 'string' && message.trim() !== '') return message.trim();
      }
      const message = (payload as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim() !== '') return message.trim();
    }
  } catch {
    // The body is not JSON: the raw text is the best detail available.
  }

  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

/** Waits for the given amount of milliseconds. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AdapterError(ErrorCode.CommandFailed, 'Operação cancelada.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AdapterError(ErrorCode.CommandFailed, 'Operação cancelada.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
