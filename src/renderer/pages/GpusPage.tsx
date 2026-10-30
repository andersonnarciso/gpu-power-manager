import { Cpu } from 'lucide-react';
import { useT, getLocale } from '@renderer/lib/i18n';
import { EM_DASH, formatDateTime, formatInt, formatMHz, formatPercent } from '@renderer/lib/format';
import { useTelemetryStore } from '@renderer/store/telemetry';
import { PageHeader, EmptyState } from '@renderer/components/common/PageStates';
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card';
import { Badge } from '@renderer/components/ui/badge';
import { CopyableValue } from '@renderer/components/common/CopyableValue';
import { DataRow } from '@renderer/components/common/StatTile';
import { truncateMiddle } from '@renderer/lib/utils';
import { useAppStore } from '@renderer/store/app';
import { useSettingsStore } from '@renderer/store/settings';
import { shouldHideIdentifier } from '@renderer/lib/privacy';

function valueOrDash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === '' ? EM_DASH : String(value);
}

export function GpusPage(): React.JSX.Element {
  const t = useT();
  const locale = getLocale();
  const devices = useTelemetryStore((state) => state.devices);
  const simulated = useAppStore((state) => state.simulated);
  const hideIdentifiers =
    useSettingsStore((state) => state.settings.hideHardwareIdentifiers) ||
    (useAppStore((state) => state.info?.hideHardwareIdentifiers) ?? false);

  return (
    <div className="animate-fade-in">
      <PageHeader title={t('gpus.title')} description={t('gpus.subtitle')} />

      {devices.length === 0 ? (
        <EmptyState
          icon={<Cpu className="h-5 w-5" aria-hidden="true" />}
          title={t('gpus.noGpus')}
          description={t('dashboard.noGpus.description')}
        />
      ) : (
        <div className="space-y-3">
          {devices.map((device, index) => (
            <Card key={device.uuid}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="text-sm">{device.name}</CardTitle>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {t('gpus.gpuLabel', { index: device.index })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge variant={device.present ? 'success' : 'destructive'}>
                      {device.present ? t('gpus.present') : t('gpus.absent')}
                    </Badge>
                    {device.throttling.active && (
                      <Badge variant="warning">{t('dashboard.throttlingActive')}</Badge>
                    )}
                  </div>
                </div>
                {shouldHideIdentifier(device.uuid, hideIdentifiers, simulated) ? (
                  <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                    {t('dashboard.identifierHidden')}
                  </p>
                ) : (
                  <CopyableValue
                    value={device.uuid}
                    display={truncateMiddle(device.uuid, 16, 8)}
                    label={t('dashboard.copyUuid')}
                    className="mt-2"
                  />
                )}
              </CardHeader>

              <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <section aria-label={t('gpus.identity')}>
                  <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {t('gpus.identity')}
                  </h3>
                  <DataRow label={t('gpus.index')} value={formatInt(locale, device.index)} mono />
                  <DataRow label={t('gpus.pciBusId')} value={valueOrDash(device.pciBusId)} mono />
                  <DataRow label={t('gpus.driverVersion')} value={valueOrDash(device.driverVersion)} mono />
                  <DataRow label={t('gpus.cudaVersion')} value={valueOrDash(device.cudaVersion)} mono />
                  <DataRow label={t('gpus.vbiosVersion')} value={valueOrDash(device.vbiosVersion)} mono />
                  <DataRow label={t('gpus.computeMode')} value={valueOrDash(device.computeMode)} />
                  <DataRow label={t('gpus.persistenceMode')} value={valueOrDash(device.persistenceMode)} />
                  <DataRow label={t('gpus.fanSpeed')} value={valueOrDash(device.fanSpeedPercent)} />
                  <DataRow
                    label={t('gpus.lastSeen')}
                    value={formatDateTime(locale, device.lastSeenAt)}
                    mono
                  />
                </section>

                <section aria-label={t('gpus.powerSection')}>
                  <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {t('gpus.powerSection')}
                  </h3>
                  <DataRow label={t('gpus.minLimit')} value={`${valueOrDash(device.power.minLimitW)} W`} mono />
                  <DataRow
                    label={t('gpus.defaultLimit')}
                    value={`${valueOrDash(device.power.defaultLimitW)} W`}
                    mono
                  />
                  <DataRow label={t('gpus.currentLimit')} value={`${valueOrDash(device.power.limitW)} W`} mono />
                  <DataRow label={t('gpus.maxLimit')} value={`${valueOrDash(device.power.maxLimitW)} W`} mono />
                  <DataRow
                    label={t('gpus.enforcedLimit')}
                    value={`${valueOrDash(device.power.enforcedLimitW)} W`}
                    mono
                  />
                  <DataRow
                    label={t('dashboard.powerDraw')}
                    value={`${valueOrDash(device.power.drawW)} W`}
                    mono
                  />
                </section>

                <section aria-label={t('gpus.clocksSection')}>
                  <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {t('gpus.clocksSection')}
                  </h3>
                  <DataRow label={t('dashboard.smClock')} value={`${valueOrDash(device.clocks.smMHz)} MHz`} mono />
                  <DataRow label={t('gpus.maxClock')} value={`${valueOrDash(device.clocks.maxSmMHz)} MHz`} mono />
                  <DataRow label={t('gpus.memClock')} value={`${valueOrDash(device.clocks.memMHz)} MHz`} mono />
                  <DataRow
                    label={t('gpus.maxClock')}
                    value={`${valueOrDash(device.clocks.maxMemMHz)} MHz`}
                    mono
                  />
                  <DataRow
                    label={t('dashboard.utilizationMemory')}
                    value={formatPercent(locale, device.utilizationMemoryPercent)}
                    mono
                  />
                </section>

                <section aria-label={t('gpus.memorySection')}>
                  <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {t('gpus.memorySection')}
                  </h3>
                  <DataRow label={t('gpus.total')} value={`${formatInt(locale, device.memory.totalMiB)} MiB`} mono />
                  <DataRow label={t('gpus.used')} value={`${formatInt(locale, device.memory.usedMiB)} MiB`} mono />
                  <DataRow label={t('gpus.free')} value={`${formatInt(locale, device.memory.freeMiB)} MiB`} mono />
                </section>

                <section aria-label={t('gpus.capabilities')}>
                  <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {t('gpus.capabilities')}
                  </h3>
                  <DataRow
                    label={t('gpus.capPowerLimit')}
                    value={
                      device.capabilities.powerLimitAdjustable ? t('common.yes') : t('common.no')
                    }
                  />
                  <DataRow
                    label={t('gpus.capFanControl')}
                    value={device.capabilities.fanControl ? t('common.yes') : t('common.no')}
                  />
                  <DataRow
                    label={t('gpus.capClockControl')}
                    value={device.capabilities.clockControl ? t('common.yes') : t('common.no')}
                  />
                  <DataRow
                    label={t('gpus.capPersistence')}
                    value={device.capabilities.persistenceMode ? t('common.yes') : t('common.no')}
                  />
                </section>

                <section aria-label={t('gpus.throttleReasons')}>
                  <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {t('gpus.throttleReasons')}
                  </h3>
                  <DataRow
                    label={t('dashboard.throttling')}
                    value={
                      device.throttling.active ? t('dashboard.throttlingActive') : t('dashboard.throttlingNone')
                    }
                  />
                  <DataRow
                    label={t('gpus.throttleReasons')}
                    value={
                      device.throttling.reasons.length > 0
                        ? device.throttling.reasons.join(', ')
                        : EM_DASH
                    }
                  />
                  <DataRow label={t('gpus.rawThrottle')} value={valueOrDash(device.throttling.raw)} mono />
                </section>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
