// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../../src/shared/types';
import {
  formatRange,
  resolveDefaultWatts,
  resolveTargetWatts,
  toPowerLimitBounds,
} from '../../src/main/power/limits';

const GPU_4070 = 'GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1';
const GPU_5060 = 'GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646';

function bounds(min: number | null, max: number | null, defaultWatts: number | null, current: number | null) {
  return toPowerLimitBounds(GPU_5060, { min, max, defaultLimit: defaultWatts, current });
}

describe('limits: resolveTargetWatts', () => {
  it('accepts a value inside the range reported by the driver', () => {
    const resolution = resolveTargetWatts(165, bounds(150, 180, 180, 180));
    expect(resolution).toEqual({ ok: true, watts: 165 });
  });

  it('accepts the exact limits of the range', () => {
    expect(resolveTargetWatts(150, bounds(150, 180, 180, 180)).ok).toBe(true);
    expect(resolveTargetWatts(180, bounds(150, 180, 180, 180)).ok).toBe(true);
  });

  it('rejects a value above the range and names the allowed range', () => {
    const resolution = resolveTargetWatts(300, bounds(150, 180, 180, 180));
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.error.code).toBe(ErrorCode.ValidationFailed);
    expect(resolution.error.message).toContain('300 W');
    expect(resolution.error.message).toContain('150–180 W');
  });

  it('rejects a value below the range and names the allowed range', () => {
    const resolution = resolveTargetWatts(100, bounds(150, 180, 180, 180));
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.error.code).toBe(ErrorCode.ValidationFailed);
    expect(resolution.error.message).toContain('100 W');
    expect(resolution.error.message).toContain('150–180 W');
  });

  it('never clamps the value', () => {
    const resolution = resolveTargetWatts(9999, bounds(100, 285, 285, 285));
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.error.message).not.toContain('9999 W foi aplicado');
  });

  it('refuses to guess when the driver does not report a range', () => {
    const resolution = resolveTargetWatts(180, bounds(null, null, 180, 180));
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.error.code).toBe(ErrorCode.UnsupportedByDriver);
  });

  it('refuses to guess when only one side of the range is known', () => {
    const resolution = resolveTargetWatts(180, bounds(150, null, 180, 180));
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.error.code).toBe(ErrorCode.UnsupportedByDriver);
  });
});

describe('limits: resolveDefaultWatts', () => {
  it('returns the factory default reported by the driver', () => {
    const resolution = resolveDefaultWatts(bounds(150, 180, 180, 160));
    expect(resolution).toEqual({ ok: true, watts: 180 });
  });

  it('fails when the driver does not report a default', () => {
    const resolution = resolveDefaultWatts(bounds(150, 180, null, 180));
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.error.code).toBe(ErrorCode.UnsupportedByDriver);
  });
});

describe('limits: toPowerLimitBounds', () => {
  it('maps the driver values into the shared contract', () => {
    const mapped = toPowerLimitBounds(GPU_4070, {
      min: 100,
      max: 285,
      defaultLimit: 285,
      current: 285,
    });
    expect(mapped).toEqual({
      uuid: GPU_4070,
      minWatts: 100,
      maxWatts: 285,
      defaultWatts: 285,
      currentWatts: 285,
      adjustable: true,
    });
  });

  it('marks a fixed range as not adjustable', () => {
    const mapped = toPowerLimitBounds(GPU_4070, {
      min: 285,
      max: 285,
      defaultLimit: 285,
      current: 285,
    });
    expect(mapped.adjustable).toBe(false);
  });
});

describe('limits: formatRange', () => {
  it('formats the range the way the user sees it', () => {
    expect(formatRange(150, 180)).toBe('150–180 W');
  });
});
