/**
 * Video generation adapter.
 *
 * Runs a ComfyUI workflow that produces video and tries to determine how many
 * seconds of video were produced from the history metadata.
 *
 * When the workflow does not expose the duration (very common: the history
 * only stores the generated files), the adapter reports `unit: 'unknown'`
 * instead of inventing a duration.
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

export interface VideoGenerationAdapterOptions extends ComfyUiClientOptions {
  /** Absolute path of the workflow JSON file. */
  workflowPath?: string | null;
}

/** Keys ComfyUI uses to store animated outputs. */
const VIDEO_KEYS = ['videos', 'gifs', 'animations', 'video'] as const;

export class VideoGenerationAdapter implements WorkloadAdapter {
  readonly id = 'comfyui-video';
  readonly name = 'ComfyUI (vídeo)';
  readonly workload: WorkloadKind = 'video-generation';

  private readonly client: ComfyUiClient;
  private readonly workflowPath: string | null;

  constructor(options: VideoGenerationAdapterOptions = {}) {
    this.client = new ComfyUiClient(options);
    this.workflowPath = options.workflowPath ?? null;
  }

  async detect(): Promise<AdapterDetection> {
    const detection = await this.client.detect();
    if (!detection.available) return detection;
    return {
      ...detection,
      hint: `${detection.hint} A duração do vídeo só é medida se o workflow expuser a duração no histórico.`,
    };
  }

  async run(ctx: WorkloadRunContext): Promise<ThroughputResult> {
    if (!this.workflowPath) {
      throw new AdapterError(
        ErrorCode.ValidationFailed,
        'Nenhum arquivo de workflow do ComfyUI foi configurado para esta medição de vídeo.',
      );
    }

    const prompt = await loadWorkflowPrompt(this.workflowPath);
    const startedAt = performance.now();

    const promptId = await this.client.submitPrompt(prompt, ctx.signal);
    const entry = await this.client.waitForCompletion(promptId, ctx.signal);
    const elapsedSeconds = (performance.now() - startedAt) / 1000;

    const seconds = countVideoSeconds(entry.outputs);

    if (seconds === null) {
      const result: AdapterThroughputResult = {
        unit: 'unknown',
        count: 0,
        label: 'vídeo gerado (duração não exposta pelo workflow)',
        source: 'comfyui /history',
        perSecond: null,
      };
      return result;
    }

    const result: AdapterThroughputResult = {
      unit: 'video-second',
      count: seconds,
      label: 'segundos de vídeo',
      source: 'comfyui /history',
      perSecond: elapsedSeconds > 0 ? seconds / elapsedSeconds : null,
    };
    return result;
  }
}

/**
 * Reads the duration of every animated output of the workflow.
 *
 * Returns null when no duration can be found: an unknown duration is not 0.
 */
export function countVideoSeconds(outputs: ComfyUiOutputs): number | null {
  let total = 0;
  let found = false;

  for (const nodeOutput of Object.values(outputs ?? {})) {
    if (!nodeOutput || typeof nodeOutput !== 'object') continue;
    const record = nodeOutput as Record<string, unknown>;

    for (const key of VIDEO_KEYS) {
      const list = record[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const seconds = readVideoSeconds(item as Record<string, unknown>);
        if (seconds === null) continue;
        total += seconds;
        found = true;
      }
    }
  }

  return found ? total : null;
}

/** Reads the duration of a single video entry, in seconds. */
function readVideoSeconds(entry: Record<string, unknown>): number | null {
  for (const key of ['duration', 'duration_s', 'duration_seconds', 'seconds']) {
    const value = entry[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }

  const frameCount = entry.frame_count ?? entry.frames;
  const fps = entry.fps ?? entry.frames_per_second;
  if (
    typeof frameCount === 'number' &&
    Number.isFinite(frameCount) &&
    typeof fps === 'number' &&
    Number.isFinite(fps) &&
    fps > 0
  ) {
    return frameCount / fps;
  }

  return null;
}

/** Reads the workflow file and extracts the prompt graph. */
async function loadWorkflowPrompt(path: string): Promise<unknown> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      throw new AdapterError(
        ErrorCode.ProfileNotFound,
        `Arquivo de workflow do ComfyUI não encontrado: ${path}`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AdapterError(
      ErrorCode.PersistenceFailed,
      `Não foi possível ler o arquivo de workflow do ComfyUI (${path}): ${message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new AdapterError(
      ErrorCode.ValidationFailed,
      `O arquivo de workflow do ComfyUI não contém JSON válido: ${path}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AdapterError(
      ErrorCode.ValidationFailed,
      `O arquivo de workflow do ComfyUI não contém um objeto de grafo: ${path}`,
    );
  }

  const container = parsed as Record<string, unknown>;
  if (container.prompt && typeof container.prompt === 'object') return container.prompt;
  if (Array.isArray(container.nodes)) {
    throw new AdapterError(
      ErrorCode.ValidationFailed,
      'O workflow do ComfyUI está no formato da interface. Exporte-o no formato API (JSON com os nós em \"id\": { \"class_type\": ... }).',
    );
  }
  return container;
}
