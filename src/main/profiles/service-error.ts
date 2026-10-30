/**
 * Errors that carry a structured `AppError` across the service boundary.
 *
 * The IPC layer (owned by another worker) is expected to catch this error and
 * forward `error.appError` to the renderer.
 */

import { ErrorCode, type AppError } from '../../shared/types';

export class ServiceError extends Error {
  readonly appError: AppError;

  constructor(appError: AppError) {
    super(appError.message);
    this.name = 'ServiceError';
    this.appError = appError;
  }

  static create(code: string, message: string, detail?: string): ServiceError {
    const appError: AppError = { code, message };
    if (detail !== undefined) {
      appError.detail = detail;
    }
    return new ServiceError(appError);
  }

  static notFound(profileId: string): ServiceError {
    return ServiceError.create(
      ErrorCode.ProfileNotFound,
      `O perfil "${profileId}" não foi encontrado.`,
    );
  }

  toAppError(): AppError {
    return this.appError;
  }
}
