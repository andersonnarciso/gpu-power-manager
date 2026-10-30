import { Cpu, Radio } from 'lucide-react';
import { useT } from '@renderer/lib/i18n';
import { getLocale } from '@renderer/lib/i18n';
import { formatClockTime, formatInt } from '@renderer/lib/format';
import { useTelemetryStore } from '@renderer/store/telemetry';
import { PageHeader, EmptyState } from '@renderer/components/common/PageStates';
import { GpuCard } from '@renderer/components/gpu/GpuCard';
import { LiveChart } from '@renderer/components/charts/LiveChart';
import { WindowSelector } from '@renderer/components/charts/WindowSelector';
import { useMetricSeries } from '@renderer/hooks/useMetricSeries';
import { Badge } from '@renderer/components/ui/badge';

export function DashboardPage(): React.JSX.Element {
  const t = useT();
  const locale = getLocale();
  const devices = useTelemetryStore((state) => state.devices);
  const lastUpdateAt = useTelemetryStore((state) => state.lastUpdateAt);
  const connected = useTelemetryStore((state) => state.connected);
  const series = useMetricSeries();

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.subtitle')}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={connected ? 'success' : 'muted'} className="gap-1.5">
              <Radio
                className={cnPulse(connected)}
                aria-hidden="true"
              />
              {connected ? t('dashboard.live') : t('dashboard.paused')}
            </Badge>
            <WindowSelector />
          </div>
        }
      />

      {lastUpdateAt !== null && (
        <p className="mb-3 text-[10px] text-muted-foreground">
          {t('dashboard.lastUpdate', { time: formatClockTime(locale, lastUpdateAt) })}
        </p>
      )}

      {devices.length === 0 ? (
        <EmptyState
          icon={<Cpu className="h-5 w-5" aria-hidden="true" />}
          title={t('dashboard.noGpus.title')}
          description={t('dashboard.noGpus.description')}
        />
      ) : (
        <>
          <div className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {devices.map((device, index) => (
              <GpuCard
                key={device.uuid}
                device={device}
                position={index + 1}
                total={devices.length}
                locale={locale}
              />
            ))}
          </div>

          <section aria-label={t('dashboard.charts')}>
            <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t('dashboard.charts')}
            </h2>
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
          </section>
        </>
      )}
    </div>
  );
}

function cnPulse(active: boolean): string {
  return active ? 'h-2 w-2 rounded-full bg-primary animate-pulse-dot' : 'h-2 w-2 rounded-full bg-muted-foreground/50';
}
