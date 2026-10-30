import { Activity, Clock, Gauge, MemoryStick, Thermometer, Zap } from 'lucide-react';
import type { GpuDevice } from '@shared/types';
import type { Locale } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/lib/i18n';
import { formatInt, formatMHz, formatPercent, formatTemperature, formatWatts } from '@renderer/lib/format';
import { truncateMiddle } from '@renderer/lib/utils';
import { Badge } from '@renderer/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@renderer/components/ui/card';
import { CopyableValue } from '@renderer/components/common/CopyableValue';
import { StatTile } from '@renderer/components/common/StatTile';
import { useAppStore } from '@renderer/store/app';
import { useSettingsStore } from '@renderer/store/settings';
import { shouldHideIdentifier } from '@renderer/lib/privacy';

export interface GpuCardProps {
  device: GpuDevice;
  position: number;
  total: number;
  locale: Locale;
}

export function GpuCard({ device, position, total, locale }: GpuCardProps): React.JSX.Element {
  const t = useT();
  const adjustable = device.capabilities.powerLimitAdjustable;
  const simulated = useAppStore((state) => state.simulated);
  const hideIdentifiers =
    useSettingsStore((state) => state.settings.hideHardwareIdentifiers) ||
    (useAppStore((state) => state.info?.hideHardwareIdentifiers) ?? false);
  const identifierHidden = shouldHideIdentifier(device.uuid, hideIdentifiers, simulated);

  return (
    <Card className={cn('overflow-hidden', !device.present && 'opacity-70')}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-sm">{device.name}</CardTitle>
            <CardDescription className="mt-1">
              {t('dashboard.cardOf', { index: position, total })}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {device.present ? (
              <Badge variant="success">{t('gpus.present')}</Badge>
            ) : (
              <Badge variant="destructive">{t('gpus.absent')}</Badge>
            )}
            {device.throttling.active && (
              <Badge variant="warning">{t('dashboard.throttlingActive')}</Badge>
            )}
          </div>
        </div>
        {identifierHidden ? (
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">
            {t('dashboard.identifierHidden')}
          </p>
        ) : (
          <CopyableValue
            value={device.uuid}
            display={truncateMiddle(device.uuid, 12, 6)}
            label={t('dashboard.copyUuid')}
            className="mt-2"
          />
        )}
      </CardHeader>

      <CardContent>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatTile
            label={t('dashboard.utilization')}
            value={formatPercent(locale, device.utilizationGpuPercent)}
            icon={Activity}
            progress={device.utilizationGpuPercent}
          />
          <StatTile
            label={t('dashboard.temperature')}
            value={formatTemperature(locale, device.temperatureC)}
            icon={Thermometer}
            tone={device.temperatureC !== null && device.temperatureC >= 83 ? 'warning' : 'default'}
          />
          <StatTile
            label={t('dashboard.vram')}
            value={formatInt(locale, device.memory.usedMiB)}
            unit={`/ ${formatInt(locale, device.memory.totalMiB)} MiB`}
            icon={MemoryStick}
            progress={
              device.memory.totalMiB > 0
                ? (device.memory.usedMiB / device.memory.totalMiB) * 100
                : 0
            }
          />
          <StatTile
            label={t('dashboard.powerDraw')}
            value={formatWatts(locale, device.power.drawW)}
            icon={Zap}
            tone="accent"
          />
          <StatTile
            label={t('dashboard.powerLimit')}
            value={formatWatts(locale, device.power.limitW)}
            icon={Gauge}
            hint={
              device.power.enforcedLimitW !== null &&
              device.power.enforcedLimitW !== device.power.limitW
                ? `${t('dashboard.enforcedLimit')}: ${formatWatts(locale, device.power.enforcedLimitW)}`
                : undefined
            }
          />
          <StatTile
            label={t('dashboard.smClock')}
            value={formatMHz(locale, device.clocks.smMHz)}
            icon={Clock}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          {device.throttling.reasons.length > 0 ? (
            device.throttling.reasons.map((reason) => (
              <Badge key={reason} variant="warning">
                {reason}
              </Badge>
            ))
          ) : (
            <Badge variant="muted">{t('dashboard.throttlingNone')}</Badge>
          )}

          {adjustable ? (
            <span className="text-[10px] text-muted-foreground">
              {t('power.range')}: {formatWatts(locale, device.power.minLimitW)} –{' '}
              {formatWatts(locale, device.power.maxLimitW)}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[10px] text-warning">
              {t('dashboard.notAdjustable')}
            </span>
          )}
        </div>

        {!adjustable && (
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            {t('dashboard.notAdjustableDescription')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Small inline summary used by the power page cards. */
export function PowerSummaryRow({
  label,
  drawW,
  limitW,
  locale,
}: {
  label: string;
  drawW: number | null;
  limitW: number | null;
  locale: Locale;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="metric text-xs font-medium">
        {formatWatts(locale, drawW)} / {formatWatts(locale, limitW)}
      </span>
    </div>
  );
}
