/**
 * Location of the per-user JSON stores.
 *
 * `app.getPath('userData')` is resolved lazily so that the module can be
 * imported (and unit tested) outside of an Electron process.
 */

import { app } from 'electron';
import * as path from 'node:path';

export const PROFILES_FILE_NAME = 'profiles.json';
export const SETTINGS_FILE_NAME = 'settings.json';

/** Absolute path of a file inside the Electron user data directory. */
export function userDataFilePath(fileName: string): string {
  return path.join(app.getPath('userData'), fileName);
}
