/**
 * Builds the payload that is persisted in the root owned state directory and
 * read by the privileged helper at boot.
 *
 * The payload keeps the **strategy** of every entry (and not the resolved
 * watt value), so the helper resolves it again against the limits the driver
 * reports at boot. A profile installed today therefore still behaves
 * correctly when the machine changes (another GPU, a different driver
 * range...).
 */

import type { PowerLimitBounds } from '../../shared/contracts';
import type { PowerProfile } from '../../shared/types';
import { buildProfileTargets } from '../profiles/profile-service';
import { PAYLOAD_VERSION, type ApplyPayload } from './apply-script';

export function buildPayloadFromProfile(
  profile: PowerProfile,
  bounds: PowerLimitBounds[],
  now: number,
): ApplyPayload {
  const targets = buildProfileTargets(profile, bounds);

  return {
    version: PAYLOAD_VERSION,
    profileId: profile.id,
    profileName: profile.name,
    builtin: profile.builtin,
    installedAt: now,
    entries: targets.map((target) => ({
      uuid: target.uuid,
      watts: target.watts,
      strategy: target.strategy,
      ratio: target.ratio,
    })),
    lastAppliedAt: null,
    lastError: null,
  };
}
