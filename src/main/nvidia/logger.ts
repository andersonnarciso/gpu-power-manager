/**
 * Tiny level-filtered logger.
 *
 * The main process must never pollute stdout (Electron uses it for IPC) and
 * library code must not call `console.log` directly, so every diagnostic goes
 * through this logger and lands on stderr.
 *
 * The level is resolved once from `GPUPM_LOG_LEVEL` and can be overridden per
 * logger instance, which keeps the tests quiet.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const KNOWN_LEVELS: readonly LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];

export interface Logger {
  error(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  debug(message: string, detail?: unknown): void;
}

/** Reads the level from the environment, falling back to `warn`. */
export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = (env['GPUPM_LOG_LEVEL'] ?? '').trim().toLowerCase();
  if ((KNOWN_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  return 'warn';
}

/** Formats an arbitrary detail value without throwing on cyclic objects. */
export function formatDetail(detail: unknown): string {
  if (detail === undefined) return '';
  if (detail instanceof Error) {
    return detail.stack ? `${detail.message}\n${detail.stack}` : detail.message;
  }
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail) ?? String(detail);
  } catch {
    return String(detail);
  }
}

/**
 * Creates a logger bound to a scope. Messages are prefixed with
 * `[gpu-pm:<scope>]` so the origin is obvious in the terminal.
 */
export function createLogger(scope: string, level: LogLevel = resolveLogLevel()): Logger {
  const threshold = LEVEL_WEIGHT[level];
  const prefix = `[gpu-pm:${scope}]`;

  const emit = (messageLevel: LogLevel, message: string, detail?: unknown): void => {
    if (LEVEL_WEIGHT[messageLevel] > threshold) return;
    const extra = formatDetail(detail);
    const line = extra ? `${prefix} ${message} :: ${extra}` : `${prefix} ${message}`;
    process.stderr.write(`${line}\n`);
  };

  return {
    error: (message, detail) => emit('error', message, detail),
    warn: (message, detail) => emit('warn', message, detail),
    info: (message, detail) => emit('info', message, detail),
    debug: (message, detail) => emit('debug', message, detail),
  };
}

/** A logger that swallows everything. Handy for tests and for `silent` mode. */
export const nullLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};
