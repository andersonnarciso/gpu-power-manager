import { useMemo } from 'react';
import { Download, History as HistoryIcon } from 'lucide-react';
import type { GpuDevice } from '@shared/types';
import { getLocale, useT, useSamplesLabel } from '@renderer/lib/i18n';
import { formatInt } from '@renderer/lib/format';
import { framesInWindow, useTelemetryStore } from '@renderer/store/telemetry';
import { useUiStore } from '@renderer/store/ui';
import { PageHeader, EmptyState } from '@renderer/components/common/PageStates';
import { Button } from '@renderer/components/ui/button';
import { Card, CardContent } from '@renderer/components/ui/card';
import { LiveChart } from '@renderer/components/charts/LiveChart';
import { WindowSelector } from '@renderer/components/charts/WindowSelector';
import { useMetricSeries } from '@renderer/hooks/useMetricSeries';

export function HistoryPage(): React.JSX.Element {
  const t = useT();
  const locale = getLocale();
  const history = useTelemetryStore((state) => state.history);
  const devices = useTelemetryStore((state) => state.devices);
  const windowMinutes = useTelemetryStore((state) => state.windowMinutes);
  const pushToast = useUiStore((state) => state.pushToast);
  const series = useMetricSeries();

  const frames = useMemo(
    () => framesInWindow(history, windowMinutes),
    [history, windowMinutes],
  );

  const samplesLabel = useSamplesLabel(frames.length);

  const exportCsv = (): void => {
    if (frames.length === 0) {
      pushToast({ variant: 'info', title: t('hist.exportEmpty') });
      return;
    }
    const csv = buildCsv(frames, devices, t);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `gpu-power-manager-${windowMinutes}min.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    pushToast({ variant: 'success', title: t('hist.exported') });
  };

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={t('hist.title')}
        description={t('hist.subtitle')}
        actions={
          <>
            <WindowSelector />
            <Button
              variant="outline"
              size="sm"
              disabled={frames.length === 0}
              onClick={exportCsv}
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {t('hist.exportCsv')}
            </Button>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span>{samplesLabel}</span>
        <span>·</span>
        <span>{t('hist.retention')}: {t('hist.retentionValue', { minutes: windowMinutes })}</span>
        <span>·</span>
        <span className="max-w-xl">{t('hist.exportInfo')}</span>
      </div>

      {frames.length === 0 ? (
        <EmptyState
          icon={<HistoryIcon className="h-5 w-5" aria-hidden="true" />}
          title={t('hist.chartEmpty')}
          description={t('dashboard.noGpus.description')}
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-3">
          <LiveChart
            className="lg:col-span-2"
            title={t('charts.power')}
            unit="W"
            series={series.power}
            locale={locale}
            height={196}
            formatValue={(value) => `${formatInt(locale, value)} W`}
            emptyLabel={t('charts.empty')}
          />
          <LiveChart
            title={t('charts.temperature')}
            unit="°C"
            series={series.temperature}
            locale={locale}
            formatValue={(value) => `${formatInt(locale, value)} °C`}
            emptyLabel={t('charts.empty')}
          />
          <LiveChart
            title={t('charts.utilization')}
            unit="%"
            series={series.utilization}
            locale={locale}
            formatValue={(value) => `${formatInt(locale, value)} %`}
            emptyLabel={t('charts.empty')}
          />
          <LiveChart
            title={t('charts.vram')}
            unit="MiB"
            series={series.vram}
            locale={locale}
            formatValue={(value) => `${formatInt(locale, value)} MiB`}
            emptyLabel={t('charts.empty')}
          />
          <LiveChart
            title={t('charts.clock')}
            unit="MHz"
            series={series.clock}
            locale={locale}
            formatValue={(value) => `${formatInt(locale, value)} MHz`}
            emptyLabel={t('charts.empty')}
          />
        </div>
      )}
    </div>
  );
}

type Translate = (key: 'hist.csvTimestamp' | 'hist.csvGpu' | 'hist.csvUuid' | 'hist.csvPower' | 'hist.csvTemperature' | 'hist.csvUtilization' | 'hist.csvVram' | 'hist.csvClock') => string;

function escapeCsv(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function buildCsv(
  frames: { at: number; byUuid: Record<string, { at: number; powerW: number | null; temperatureC: number | null; utilizationPct: number; vramMiB: number; smMHz: number | null }> }[],
  devices: GpuDevice[],
  t: Translate,
): string {
  const header = [
    t('hist.csvTimestamp'),
    t('hist.csvGpu'),
    t('hist.csvUuid'),
    t('hist.csvPower'),
    t('hist.csvTemperature'),
    t('hist.csvUtilization'),
    t('hist.csvVram'),
    t('hist.csvClock'),
  ];
  const rows: string[] = [header.map(escapeCsv).join(',')];

  for (const frame of frames) {
    for (const device of devices) {
      const point = frame.byUuid[device.uuid];
      if (!point) continue;
      rows.push(
        [
          new Date(frame.at).toISOString(),
          escapeCsv(device.name),
          escapeCsv(device.uuid),
          point.powerW === null ? '' : String(point.powerW),
          point.temperatureC === null ? '' : String(point.temperatureC),
          String(point.utilizationPct),
          String(point.vramMiB),
          point.smMHz === null ? '' : String(point.smMHz),
        ].join(','),
      );
    }
  }

  return rows.join('\n');
}
