/**
 * Injectable clock.
 *
 * The telemetry engine must be testable without real timers, so every time
 * dependent collaborator goes through this interface.
 */

/** Opaque handle returned by {@link Clock.setInterval}. */
export type TimerHandle = unknown;

export interface Clock<THandle = TimerHandle> {
  /** Epoch milliseconds. */
  now(): number;
  setInterval(handler: () => void, ms: number): THandle;
  clearInterval(handle: THandle): void;
}

/** The real clock, backed by `Date.now` and `setInterval`. */
export const systemClock: Clock<ReturnType<typeof setInterval>> = {
  now: () => Date.now(),
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle),
};
