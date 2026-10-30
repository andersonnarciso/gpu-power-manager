// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  PKEXEC_CANDIDATES,
  POLKIT_POLICY_PATH,
  detectPolkit,
  findPkexec,
  isPolkitAvailable,
  policyInstalled,
} from '../../src/main/privileged/polkit';
import type { FileProbe } from '../../src/main/privileged/polkit';

function probeWith(paths: string[]): FileProbe {
  return {
    exists: (path: string) => paths.includes(path),
    stat: () => null,
  };
}

describe('polkit detection', () => {
  it('finds pkexec in the standard location', () => {
    expect(findPkexec(probeWith(['/usr/bin/pkexec']))).toBe('/usr/bin/pkexec');
  });

  it('returns null when pkexec is absent', () => {
    expect(findPkexec(probeWith([]))).toBeNull();
    expect(isPolkitAvailable(probeWith([]))).toBe(false);
  });

  it('knows the candidate locations of pkexec', () => {
    expect(PKEXEC_CANDIDATES).toContain('/usr/bin/pkexec');
  });

  it('detects the installed policy file', () => {
    expect(policyInstalled(probeWith([POLKIT_POLICY_PATH]))).toBe(true);
    expect(policyInstalled(probeWith([]))).toBe(false);
  });

  it('summarizes the state of the system', () => {
    const status = detectPolkit(probeWith(['/usr/bin/pkexec', POLKIT_POLICY_PATH]));
    expect(status).toEqual({
      available: true,
      pkexecPath: '/usr/bin/pkexec',
      policyInstalled: true,
    });
  });

  it('reports a system without polkit', () => {
    const status = detectPolkit(probeWith([]));
    expect(status.available).toBe(false);
    expect(status.pkexecPath).toBeNull();
  });
});
