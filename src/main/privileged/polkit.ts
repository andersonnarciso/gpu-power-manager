/**
 * Detection of the polkit infrastructure of the host system.
 *
 * The app never requires root: every privileged operation goes through
 * `pkexec`, which asks polkit for authorization. This module only answers
 * whether that infrastructure is usable, it never changes anything.
 */

import fs from 'fs';

/** Minimal file metadata the app needs to reason about ownership and mode. */
export interface FileStat {
  uid: number;
  gid: number;
  /** Permission bits, already masked (e.g. 0o755). */
  mode: number;
  size: number;
  isDirectory: boolean;
  isFile: boolean;
}

/** Injectable filesystem probe so the helpers can be unit tested. */
export interface FileProbe {
  exists(path: string): boolean;
  stat(path: string): FileStat | null;
}

/** Probe backed by the real filesystem. */
export const nodeFileProbe: FileProbe = {
  exists(path: string): boolean {
    try {
      return fs.existsSync(path);
    } catch {
      return false;
    }
  },
  stat(path: string): FileStat | null {
    try {
      const stats = fs.statSync(path);
      return {
        uid: stats.uid,
        gid: stats.gid,
        mode: stats.mode & 0o7777,
        size: stats.size,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
      };
    } catch {
      return null;
    }
  },
};

/** Canonical location of the policy file installed by `install-helper.ts`. */
export const POLKIT_POLICY_PATH = '/usr/share/polkit-1/actions/com.gpupowermanager.policy';

/** Where `pkexec` is normally installed. */
export const PKEXEC_CANDIDATES: readonly string[] = ['/usr/bin/pkexec', '/bin/pkexec', '/usr/local/bin/pkexec'];

export interface PolkitStatus {
  /** True when a polkit capable `pkexec` is present. */
  available: boolean;
  /** Absolute path of `pkexec`, null when it was not found. */
  pkexecPath: string | null;
  /** True when the GPU Power Manager policy file is installed. */
  policyInstalled: boolean;
}

/** Absolute path of `pkexec`, or null when polkit is not usable. */
export function findPkexec(probe: FileProbe = nodeFileProbe): string | null {
  for (const candidate of PKEXEC_CANDIDATES) {
    if (probe.exists(candidate)) return candidate;
  }
  return null;
}

/** True when the polkit policy of this app is installed on the system. */
export function policyInstalled(probe: FileProbe = nodeFileProbe): boolean {
  return probe.exists(POLKIT_POLICY_PATH);
}

/** True when the host can authorize privileged operations through polkit. */
export function isPolkitAvailable(probe: FileProbe = nodeFileProbe): boolean {
  return findPkexec(probe) !== null;
}

/** Full snapshot of the polkit infrastructure. */
export function detectPolkit(probe: FileProbe = nodeFileProbe): PolkitStatus {
  const pkexecPath = findPkexec(probe);
  return {
    available: pkexecPath !== null,
    pkexecPath,
    policyInstalled: policyInstalled(probe),
  };
}
