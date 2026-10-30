/**
 * Runtime validation for every value that crosses the IPC boundary.
 *
 * The renderer is untrusted input. Nothing is forwarded to `nvidia-smi`, to the
 * privileged helper or to the filesystem before it has passed through here.
 *
 * The validators are hand written on purpose: no extra runtime dependency, and
 * every rule is directly unit testable.
 */

import { ErrorCode, type AppError } from './types';

export class ValidationError extends Error {
  readonly code = ErrorCode.ValidationFailed;
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }

  toAppError(): AppError {
    return { code: this.code, message: this.message, detail: `Campo inválido: ${this.field}` };
  }
}

/** NVIDIA GPU UUIDs look like `GPU-8c1c4f4a-1f1a-4d4c-9d3f-3f2a1b0c9d8e`. */
const UUID_RE = /^GPU-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isValidGpuUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function assertGpuUuid(value: unknown, field = 'uuid'): string {
  if (!isValidGpuUuid(value)) {
    throw new ValidationError(field, 'Identificador de GPU inválido.');
  }
  return value;
}

/** Power limits are whole watts. */
export function assertWatts(value: unknown, field = 'watts'): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ValidationError(field, 'O limite de potência deve ser um número inteiro em watts.');
  }
  if (n < 1 || n > 5000) {
    throw new ValidationError(field, 'O limite de potência está fora de qualquer faixa plausível.');
  }
  return n;
}

export function assertString(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== 'string') {
    throw new ValidationError(field, `Campo "${field}" deve ser texto.`);
  }
  if (value.length > maxLength) {
    throw new ValidationError(field, `Campo "${field}" excede o tamanho máximo permitido.`);
  }
  return value;
}

export function assertNonEmptyString(value: unknown, field: string, maxLength = 512): string {
  const s = assertString(value, field, maxLength);
  if (s.trim().length === 0) {
    throw new ValidationError(field, `Campo "${field}" não pode ficar vazio.`);
  }
  return s;
}

export function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(field, `Campo "${field}" deve ser booleano.`);
  }
  return value;
}

export function assertPlainObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(field, `Campo "${field}" deve ser um objeto.`);
  }
  return value as Record<string, unknown>;
}

export function assertArray(value: unknown, field: string, maxItems = 64): unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(field, `Campo "${field}" deve ser uma lista.`);
  }
  if (value.length > maxItems) {
    throw new ValidationError(field, `Campo "${field}" excede o número máximo de itens.`);
  }
  return value;
}

export function assertOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(field, `Campo "${field}" inválido.`);
  }
  return value as T;
}

export function assertIntRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ValidationError(field, `Campo "${field}" deve ser um número inteiro.`);
  }
  if (n < min || n > max) {
    throw new ValidationError(field, `Campo "${field}" deve estar entre ${min} e ${max}.`);
  }
  return n;
}

export function assertNumberRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new ValidationError(field, `Campo "${field}" deve ser um número.`);
  }
  if (n < min || n > max) {
    throw new ValidationError(field, `Campo "${field}" deve estar entre ${min} e ${max}.`);
  }
  return n;
}

/** Reject anything that could be interpreted as a shell fragment. */
export function assertNoShellMetacharacters(value: string, field: string): string {
  if (/[;&|`$><\n\r\\]/.test(value)) {
    throw new ValidationError(field, `Campo "${field}" contém caracteres não permitidos.`);
  }
  return value;
}

export function toAppError(error: unknown): AppError {
  if (error instanceof ValidationError) {
    return error.toAppError();
  }
  // Services may throw an error that already carries a structured payload.
  if (error && typeof error === 'object' && 'appError' in error) {
    const candidate = (error as { appError?: unknown }).appError;
    if (candidate && typeof candidate === 'object' && 'code' in candidate && 'message' in candidate) {
      return candidate as AppError;
    }
  }
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    return error as AppError;
  }
  if (error instanceof Error) {
    return { code: ErrorCode.Unknown, message: error.message };
  }
  return { code: ErrorCode.Unknown, message: 'Erro desconhecido.' };
}
