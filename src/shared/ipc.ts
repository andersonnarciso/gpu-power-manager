/**
 * IPC channel catalogue.
 *
 * Every channel name is a constant so that the main process, the preload
 * bridge and the renderer can never drift apart. Payload shapes are described
 * by the service interfaces in `contracts.ts`.
 *
 * Channels are split in two families:
 *  - `invoke` channels: request/response, return a promise.
 *  - `on` channels: main -> renderer push notifications.
 */

export const IPC = {
  /* app */
  appInfo: 'app:info',

  /* gpu + telemetry */
  gpuList: 'gpu:list',
  telemetrySnapshot: 'telemetry:snapshot',
  telemetryPush: 'telemetry:push',
  telemetryError: 'telemetry:error',

  /* power limit */
  powerLimits: 'power:limits',
  powerApply: 'power:apply',
  powerApplyMany: 'power:apply-many',
  powerReset: 'power:reset',
  powerResetMany: 'power:reset-many',

  /* profiles */
  profilesList: 'profiles:list',
  profilesSave: 'profiles:save',
  profilesDelete: 'profiles:delete',
  profilesActivate: 'profiles:activate',
  profilesReset: 'profiles:reset',

  /* persistence (systemd) */
  persistenceStatus: 'persistence:status',
  persistenceInstall: 'persistence:install',
  persistenceUninstall: 'persistence:uninstall',
  persistenceToggle: 'persistence:toggle',
  persistenceApplyNow: 'persistence:apply-now',

  /* benchmark */
  benchmarkAdapters: 'benchmark:adapters',
  benchmarkStart: 'benchmark:start',
  benchmarkStop: 'benchmark:stop',
  benchmarkRuns: 'benchmark:runs',
  benchmarkRun: 'benchmark:run',

  /* optimizer */
  optimizerRecommend: 'optimizer:recommend',

  /* processes */
  processesList: 'processes:list',

  /* settings */
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** Channels the renderer is allowed to invoke. */
export const INVOKE_CHANNELS: readonly string[] = Object.values(IPC).filter(
  (c) => c !== IPC.telemetryPush && c !== IPC.telemetryError,
);

/** Channels the renderer is allowed to subscribe to. */
export const SUBSCRIBE_CHANNELS: readonly string[] = [IPC.telemetryPush, IPC.telemetryError];
