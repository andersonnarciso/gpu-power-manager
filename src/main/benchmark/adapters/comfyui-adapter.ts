/**
 * ComfyUI image generation adapter.
 *
 * The user points to a workflow file (JSON). The adapter sends it to
 * /prompt, waits for /history to report the prompt as finished and counts the
 * images the workflow produced.
 *
 * The image count is read from the real history. When the workflow file is
 * missing or unreadable the adapter fails with a precise message instead of
 * guessing.
 */

import { readFile } from 'node:fs/promises';
import { ErrorCode, type ThroughputResult, type WorkloadKind } from '../../../shared/types';
import { ComfyUiClient, type ComfyUiClientOptions, type ComfyUiOutputs } from './comfyui-client';
import {
  AdapterError,
  type AdapterDetection,
  type AdapterThroughputResult,
  type WorkloadAdapter,
  type WorkloadRunContext,
} from './types';

export interface ComfyUiAdapterOptions extends ComfyUiClientOptions {
  /** Absolute path of the workflow JSON file. */
  workflowPath?: string | null;
}

export class ComfyUiAdapter implements WorkloadAdapter {
  readonly id = 'comfyui';
  readonly name = 'ComfyUI';
  readonly workload: WorkloadKind = 'image-generation';

  private readonly client: ComfyUiClient;
  private readonly workflowPath: string | null;

  constructor(options: ComfyUiAdapterOptions = {}) {
    this.client = new ComfyUiClient(options);
    this.workflowPath = options.workflowPath ?? null;
  }

  async detect(): Promise<AdapterDetection> {
    return this.client.detect();
  }

  async run(ctx: WorkloadRunContext): Promise<ThroughputResult> {
    const prompt = await this.loadPrompt();
    const startedAt = performance.now();

    const promptId = await this.client.submitPrompt(prompt, ctx.signal);
    const entry = await this.client.waitForCompletion(promptId, ctx.signal);
    const elapsedSeconds = (performance.now() - startedAt) / 1000;

    const images = countImages(entry.outputs);
    const result: AdapterThroughputResult = {
      unit: 'image',
      count: images,
      label: 'imagens geradas',
      source: 'comfyui /history',
      perSecond: elapsedSeconds > 0 ? images / elapsedSeconds : null,
    };
    return result;
  }

  /** Reads and validates the workflow file. */
  private async loadPrompt(): Promise<unknown> {
    if (!this.workflowPath) {
      throw new AdapterError(
        ErrorCode.ValidationFailed,
        'Nenhum arquivo de workflow do ComfyUI foi configurado para esta medição.',
      );
    }

    let content: string;
    try {
      content = await readFile(this.workflowPath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        throw new AdapterError(
          ErrorCode.ProfileNotFound,
          `Arquivo de workflow do ComfyUI não encontrado: ${this.workflowPath}`,
        );
      }
      if (code === 'EACCES') {
        throw new AdapterError(
          ErrorCode.PermissionDenied,
          `Sem permissão para ler o arquivo de workflow do ComfyUI: ${this.workflowPath}`,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new AdapterError(
        ErrorCode.PersistenceFailed,
        `Não foi possível ler o arquivo de workflow do ComfyUI (${this.workflowPath}): ${message}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new AdapterError(
        ErrorCode.ValidationFailed,
        `O arquivo de workflow do ComfyUI não contém JSON válido: ${this.workflowPath}`,
      );
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AdapterError(
        ErrorCode.ValidationFailed,
        `O arquivo de workflow do ComfyUI não contém um objeto de grafo: ${this.workflowPath}`,
      );
    }

    const container = parsed as Record<string, unknown>;

    if (container.prompt && typeof container.prompt === 'object') {
      return container.prompt;
    }

    if (Array.isArray(container.nodes)) {
      throw new AdapterError(
        ErrorCode.ValidationFailed,
        'O workflow do ComfyUI está no formato da interface. Exporte-o no formato API (JSON com os nós em \"id\": { \"class_type\": ... }).',
      );
    }

    return container;
  }
}

/** Counts the images produced by every output node of the workflow. */
export function countImages(outputs: ComfyUiOutputs): number {
  let total = 0;
  for (const nodeOutput of Object.values(outputs ?? {})) {
    if (!nodeOutput || typeof nodeOutput !== 'object') continue;
    const images = (nodeOutput as Record<string, unknown>).images;
    if (Array.isArray(images)) total += images.length;
  }
  return total;
}
