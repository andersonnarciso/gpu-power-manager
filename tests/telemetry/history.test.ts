import { describe, expect, it } from 'vitest';

import { TelemetryHistory, downsample } from '../../src/main/telemetry/history';
import type { TelemetrySample } from '../../src/shared/types';

function sample(at: number, value = 0): TelemetrySample {
  return { at, gpus: [] as never[] } as unknown as TelemetrySample;
}

function series(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

describe('history: downsample', () => {
  it('preserva o primeiro e o último ponto', () => {
    const points = series(100);
    const reduced = downsample(points, 10);
    expect(reduced[0]).toBe(0);
    expect(reduced[reduced.length - 1]).toBe(99);
  });

  it('nunca ultrapassa o número máximo de pontos', () => {
    for (const max of [2, 3, 5, 10, 25, 50]) {
      expect(downsample(series(1000), max).length).toBeLessThanOrEqual(max);
    }
  });

  it('devolve tudo quando a série já é curta', () => {
    const points = series(10);
    expect(downsample(points, 10)).toEqual(points);
    expect(downsample(points, 50)).toEqual(points);
  });

  it('trata limites degenerados', () => {
    expect(downsample(series(10), 0)).toEqual([]);
    expect(downsample(series(10), 1)).toEqual([0]);
    expect(downsample(series(10), 2)).toEqual([0, 9]);
    expect(downsample([], 5)).toEqual([]);
  });

  it('mantém os picos com o algoritmo de maior triângulo', () => {
    const points = [0, 1, 2, 3, 100, 5, 6, 7, 8, 9];
    const reduced = downsample(points, 4, (value) => value);
    expect(reduced).toHaveLength(4);
    expect(reduced[0]).toBe(0);
    expect(reduced[reduced.length - 1]).toBe(9);
    expect(reduced).toContain(100);
  });

  it('funciona com uma série de amostras de telemetria', () => {
    const samples = series(3600).map((index) => sample(index * 1000, index));
    const reduced = downsample(samples, 120, (item) => item.at);
    expect(reduced).toHaveLength(120);
    expect(reduced[0]?.at).toBe(0);
    expect(reduced[reduced.length - 1]?.at).toBe(3599 * 1000);
  });
});

describe('history: buffer circular', () => {
  it('mantém no máximo o número configurado de amostras', () => {
    const history = new TelemetryHistory({ maxSamples: 5, retentionMinutes: 0 });
    for (let index = 0; index < 20; index += 1) {
      history.push(sample(index));
    }
    expect(history.size()).toBe(5);
    const kept = history.list();
    expect(kept[0]?.at).toBe(15);
    expect(kept[kept.length - 1]?.at).toBe(19);
  });

  it('devolve a amostra mais recente', () => {
    const history = new TelemetryHistory({ retentionMinutes: 0 });
    history.push(sample(1));
    history.push(sample(2));
    expect(history.latest()?.at).toBe(2);
  });

  it('descarta o que está fora da janela de retenção', () => {
    let now = 1_000_000;
    const history = new TelemetryHistory({ retentionMinutes: 1, now: () => now });
    history.push(sample(now));
    now += 30_000;
    history.push(sample(now));
    expect(history.size()).toBe(2);
    now += 120_000;
    history.push(sample(now));
    expect(history.size()).toBe(1);
    expect(history.latest()?.at).toBe(now);
  });

  it('limpa o buffer', () => {
    const history = new TelemetryHistory({ retentionMinutes: 0 });
    history.push(sample(1));
    history.clear();
    expect(history.size()).toBe(0);
    expect(history.latest()).toBeNull();
  });

  it('muda a janela de retenção e poda na hora', () => {
    let now = 5_000_000;
    const history = new TelemetryHistory({ retentionMinutes: 60, now: () => now });
    history.push(sample(now));
    now += 10 * 60_000;
    history.setRetentionMinutes(1);
    expect(history.size()).toBe(0);
  });
});
