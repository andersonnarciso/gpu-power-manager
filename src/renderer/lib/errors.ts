/**
 * Error normalisation.
 *
 * Backend failures are always surfaced as a readable message. Raw stack traces
 * never reach the UI.
 */

import { ErrorCode, type AppError } from '@shared/types';
import type { TranslationKey } from './i18n';

const ERROR_KEYS: Record<string, TranslationKey> = {
  [ErrorCode.ValidationFailed]: 'error.validationFailed',
  [ErrorCode.GpuNotFound]: 'error.gpuNotFound',
  [ErrorCode.UnsupportedByDriver]: 'error.unsupportedByDriver',
  [ErrorCode.PermissionDenied]: 'error.permissionDenied',
  [ErrorCode.AuthorizationDenied]: 'error.authorizationDenied',
  [ErrorCode.AuthorizationUnavailable]: 'error.authorizationUnavailable',
  [ErrorCode.PrivilegedHelperMissing]: 'error.privilegedHelperMissing',
  [ErrorCode.DriverUnavailable]: 'error.driverUnavailable',
  [ErrorCode.CommandFailed]: 'error.commandFailed',
  [ErrorCode.Timeout]: 'error.timeout',
  [ErrorCode.ProfileNotFound]: 'error.profileNotFound',
  [ErrorCode.ProfileInvalid]: 'error.profileInvalid',
  [ErrorCode.PersistenceFailed]: 'error.persistenceFailed',
  [ErrorCode.BenchmarkFailed]: 'error.benchmarkFailed',
  [ErrorCode.AdapterUnavailable]: 'error.adapterUnavailable',
  [ErrorCode.Unknown]: 'error.unknown',
};

export interface NormalisedError {
  code: string;
  /** Translated, human readable summary. */
  message: string;
  /** Optional extra context coming from the backend. */
  detail?: string;
  cancelled: boolean;
}

/** Map an `AppError` code to its translation key. */
export function errorKeyFor(code: string): TranslationKey {
  return ERROR_KEYS[code] ?? 'error.unknown';
}

/** Turn anything thrown by the bridge into a displayable error. */
export function normaliseError(error: unknown): NormalisedError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const appError = error as AppError;
    return {
      code: appError.code,
      message: appError.message,
      detail: appError.detail,
      cancelled: appError.cancelled === true,
    };
  }
  if (error instanceof Error) {
    return {
      code: ErrorCode.Unknown,
      message: error.message,
      detail: undefined,
      cancelled: false,
    };
  }
  if (typeof error === 'string') {
    return { code: ErrorCode.Unknown, message: error, detail: undefined, cancelled: false };
  }
  return { code: ErrorCode.Unknown, message: '', detail: undefined, cancelled: false };
}

/** True when the error was caused by the user cancelling an authorisation. */
export function isCancellation(error: unknown): boolean {
  return normaliseError(error).cancelled;
}
