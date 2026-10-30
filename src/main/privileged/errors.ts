/**
 * Error plumbing shared by the power service and the privileged helper client.
 *
 * Everything that can fail in the main process ends up as an `AppError`: a
 * machine readable code plus a message a human can act on. The messages are
 * written in Brazilian Portuguese because they are shown verbatim in the
 * renderer.
 */

import { ErrorCode, type AppError, type ErrorCodeValue } from '../../shared/types';
import { toAppError } from '../../shared/validation';

/** Error that carries a fully built `AppError` payload. */
export class AppErrorException extends Error {
  readonly appError: AppError;

  constructor(appError: AppError) {
    super(appError.message);
    this.name = 'AppErrorException';
    this.appError = appError;
  }
}

export interface AppErrorDetails {
  detail?: string;
  cancelled?: boolean;
}

/** Builds an `AppErrorException` with an optional detail and cancellation flag. */
export function fail(
  code: ErrorCodeValue | string,
  message: string,
  details?: AppErrorDetails,
): AppErrorException {
  const appError: AppError = { code, message };
  if (details?.detail !== undefined) appError.detail = details.detail;
  if (details?.cancelled !== undefined) appError.cancelled = details.cancelled;
  return new AppErrorException(appError);
}

/**
 * Normalises any thrown value into an `AppError`.
 *
 * `AppErrorException` keeps its payload; anything else falls back to the
 * shared `toAppError` helper so validation errors keep their code.
 */
export function asAppError(error: unknown): AppError {
  if (error instanceof AppErrorException) return error.appError;
  return toAppError(error);
}

/** Convenience wrapper for the "driver is not usable" situation. */
export function driverUnavailable(detail?: string): AppErrorException {
  return fail(
    ErrorCode.DriverUnavailable,
    'Não foi possível conversar com o driver NVIDIA. Verifique se o driver está instalado e carregado.',
    detail === undefined ? undefined : { detail },
  );
}
