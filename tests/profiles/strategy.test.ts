import { describe, it, expect } from 'vitest';
import {
  effectiveMaxWatts,
  resolveStrategyWatts,
} from '../../src/main/profiles/strategy';

const RANGE_4070 = { minWatts: 100, maxWatts: 285, defaultWatts: 285 };
const RANGE_5060 = { minWatts: 150, maxWatts: 180, defaultWatts: 180 };

describe('resolveStrategyWatts', () => {
  it('resolves the "default" strategy to the factory default of the GPU', () => {
    const result = resolveStrategyWatts({ strategy: 'default', watts: null }, RANGE_4070);
    expect(result).toEqual({ ok: true, watts: 285 });

    const second = resolveStrategyWatts({ strategy: 'default', watts: null }, RANGE_5060);
    expect(second).toEqual({ ok: true, watts: 180 });
  });

  it('fails when the driver does not report the factory default', () => {
    const result = resolveStrategyWatts(
      { strategy: 'default', watts: null },
      { minWatts: 100, maxWatts: 285, defaultWatts: null },
    );
    expect(result.ok).toBe(false);
  });

  it('resolves the "min" strategy to the lowest accepted limit', () => {
    expect(resolveStrategyWatts({ strategy: 'min', watts: null }, RANGE_4070)).toEqual({
      ok: true,
      watts: 100,
    });
    expect(resolveStrategyWatts({ strategy: 'min', watts: null }, RANGE_5060)).toEqual({
      ok: true,
      watts: 150,
    });
  });

  it('resolves the "ratio" strategy to 70% of the allowed range', () => {
    // 100 + 0.7 * (285 - 100) = 229.5 -> 230
    expect(
      resolveStrategyWatts({ strategy: 'ratio', ratio: 0.7, watts: null }, RANGE_4070),
    ).toEqual({ ok: true, watts: 230 });

    // 150 + 0.7 * (180 - 150) = 171
    expect(
      resolveStrategyWatts({ strategy: 'ratio', ratio: 0.7, watts: null }, RANGE_5060),
    ).toEqual({ ok: true, watts: 171 });
  });

  it('clamps the "ratio" strategy to the allowed range', () => {
    expect(
      resolveStrategyWatts({ strategy: 'ratio', ratio: 0, watts: null }, RANGE_4070).ok,
    ).toBe(false);

    const high = resolveStrategyWatts({ strategy: 'ratio', ratio: 1, watts: null }, RANGE_4070);
    expect(high).toEqual({ ok: true, watts: 285 });
  });

  it('resolves the "fixed" strategy to the exact value', () => {
    expect(resolveStrategyWatts({ strategy: 'fixed', watts: 220 }, RANGE_4070)).toEqual({
      ok: true,
      watts: 220,
    });
  });

  it('rejects a "fixed" value outside the allowed range', () => {
    const below = resolveStrategyWatts({ strategy: 'fixed', watts: 99 }, RANGE_4070);
    expect(below.ok).toBe(false);
    expect(below.ok === false && below.reason).toContain('fora da faixa');

    const above = resolveStrategyWatts({ strategy: 'fixed', watts: 400 }, RANGE_4070);
    expect(above.ok).toBe(false);
  });

  it('never goes above the factory default, even when the driver allows more', () => {
    const range = { minWatts: 100, maxWatts: 600, defaultWatts: 450 };
    expect(effectiveMaxWatts(range)).toBe(450);

    const ratio = resolveStrategyWatts({ strategy: 'ratio', ratio: 1, watts: null }, range);
    expect(ratio).toEqual({ ok: true, watts: 450 });

    const fixed = resolveStrategyWatts({ strategy: 'fixed', watts: 500 }, range);
    expect(fixed.ok).toBe(false);
  });
});
