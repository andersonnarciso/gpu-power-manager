/**
 * Endpoints of the workload adapters.
 *
 * The adapters used to carry their endpoints in code, which made a server that
 * listens on another port invisible to the application: the llama.cpp server
 * of this machine listens on :8088 and the application reported it as
 * unavailable.
 *
 * The endpoints are part of the settings now, and they reach the adapters by
 * INJECTION: an adapter never reads a global, it receives the URL it must talk
 * to. The settings service publishes the endpoints it holds and the benchmark
 * module injects them into the adapters it creates.
 *
 * A user who configures nothing keeps the very same ports as before.
 */

import type { AppSettings } from '../../shared/types';

/** Default endpoint of the Ollama server. */
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
/** Default endpoint of the llama.cpp server. */
export const DEFAULT_LLAMA_CPP_URL = 'http://127.0.0.1:8080';
/** Default endpoint of the ComfyUI server. */
export const DEFAULT_COMFYUI_URL = 'http://127.0.0.1:8188';

/** The endpoints and the command the adapters must use. */
export interface AdapterEndpoints {
  /** Base URL of the Ollama server. */
  ollamaUrl: string;
  /** Base URL of the llama.cpp server. */
  llamaCppUrl: string;
  /** Base URL of the ComfyUI server. */
  comfyUiUrl: string;
  /** Executable of the Unsloth benchmark. Null when it is not configured. */
  unslothCommand: string | null;
  /** Arguments of the Unsloth command. */
  unslothArgs: string[];
}

/** The endpoints used when the user configures nothing. */
export const DEFAULT_ADAPTER_ENDPOINTS: AdapterEndpoints = {
  ollamaUrl: DEFAULT_OLLAMA_URL,
  llamaCppUrl: DEFAULT_LLAMA_CPP_URL,
  comfyUiUrl: DEFAULT_COMFYUI_URL,
  unslothCommand: null,
  unslothArgs: [],
};

/** Resolves the endpoints that are configured right now. */
export type AdapterEndpointsResolver = () => AdapterEndpoints;

function trimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

/**
 * Reads the endpoints of a settings object.
 *
 * A field the user never configured falls back to the default of the adapter:
 * the application keeps working exactly as before.
 */
export function adapterEndpointsOf(
  settings: AppSettings | null | undefined,
): AdapterEndpoints {
  const unslothArgs = Array.isArray(settings?.unslothArgs)
    ? settings.unslothArgs.filter((arg): arg is string => typeof arg === 'string')
    : [];

  return {
    ollamaUrl: trimmed(settings?.ollamaUrl) ?? DEFAULT_OLLAMA_URL,
    llamaCppUrl: trimmed(settings?.llamaCppUrl) ?? DEFAULT_LLAMA_CPP_URL,
    comfyUiUrl: trimmed(settings?.comfyUiUrl) ?? DEFAULT_COMFYUI_URL,
    unslothCommand: trimmed(settings?.unslothCommand),
    unslothArgs,
  };
}

let provider: AdapterEndpointsResolver | null = null;

/**
 * Registers the source of the endpoints that are configured.
 *
 * The settings service registers itself when it is created, so the benchmark
 * module always reads the settings that are really in effect.
 */
export function registerAdapterEndpointsProvider(next: AdapterEndpointsResolver | null): void {
  provider = next;
}

/**
 * The endpoints that are configured right now.
 *
 * The defaults when nothing was registered: the adapters then talk to the
 * ports they always used.
 */
export function resolveAdapterEndpoints(): AdapterEndpoints {
  const endpoints = provider ? provider() : null;
  if (!endpoints) {
    return { ...DEFAULT_ADAPTER_ENDPOINTS, unslothArgs: [] };
  }
  return { ...endpoints, unslothArgs: [...endpoints.unslothArgs] };
}
