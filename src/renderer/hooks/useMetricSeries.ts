import { useMemo } from 'react';
import type { GpuDevice } from '@shared/types';
import type { ChartSeries } from '@renderer/components/charts/LiveChart';
import { SERIES_COLORS } from '@renderer/components/charts/seriesColors';
import { framesInWindow, useTelemetryStore, type TelemetryPoint } from '@renderer/store/telemetry';
import type { ChartPoint } from '@renderer/lib/series';

export interface MetricSeriesSet {
  power: ChartSeries[];
  temperature: ChartSeries[];
  utilization: ChartSeries[];
  vram: ChartSeries[];
  clock: ChartSeries[];
}

type Picker = (point: TelemetryPoint) => number | null;

/** Builds one series per GPU for every charted metric, limited to the window. */
export function useMetricSeries(): MetricSeriesSet {
  const history = useTelemetryStore((state) => state.history);
  const devices = useTelemetryStore((state) => state.devices);
  const windowMinutes = useTelemetryStore((state) => state.windowMinutes);

  const frames = useMemo(() => framesInWindow(history, windowMinutes), [history, windowMinutes]);

  return useMemo(() => {
    const build = (pick: Picker): ChartSeries[] =>
      devices.map((device: GpuDevice, index: number) => {
        const data: ChartPoint[] = [];
        for (const frame of frames) {
          const point = frame.byUuid[device.uuid];
          if (!point) continue;
          const value = pick(point);
          if (value === null) continue;
          data.push({ at: frame.at, value });
        }
        return {
          key: device.uuid,
          label: device.name,
          color: SERIES_COLORS[index % SERIES_COLORS.length],
          data,
        };
      });

    return {
      power: build((point) => point.powerW),
      temperature: build((point) => point.temperatureC),
      utilization: build((point) => point.utilizationPct),
      vram: build((point) => point.vramMiB),
      clock: build((point) => point.smMHz),
    };
  }, [devices, frames]);
}
