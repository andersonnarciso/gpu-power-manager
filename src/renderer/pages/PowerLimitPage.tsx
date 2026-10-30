import { useEffect, useMemo, useState } from 'react';
import {
  BatteryCharging,
  Check,
  Gauge,
  Info,
  RotateCcw,
  X,
  Zap,
} from 'lucide-react';
import type { GpuDevice } from '@shared/types';
import { integrateEnergy, type IntegratedEnergy } from '@shared/energy';
import { getLocale, useT } from '@renderer/lib/i18n';
import { formatInt, formatJoules, formatWattHours, formatWatts } from '@renderer/lib/format';
import { cn } from '@renderer/lib/utils';
import { useTelemetryStore } from '@renderer/store/telemetry';
import { usePowerStore } from '@renderer/store/power';
import { useUiStore } from '@renderer/store/ui';
import { PageHeader, EmptyState } from '@renderer/components/common/PageStates';
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { Slider } from '@renderer/components/ui/slider';
import { Badge } from '@renderer/components/ui/badge';
import { Switch } from '@renderer/components/ui/switch';
import { Separator } from '@renderer/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert';

interface StagedChange {
  uuid: string;
  name: string;
  current: number;
  next: number;
}

export function PowerLimitPage(): React.JSX.Element {
  const t = useT();
  const locale = getLocale();
  const devices = useTelemetryStore((state) => state.devices);
  const history = useTelemetryStore((state) => state.history);
  const bounds = usePowerStore((state) => state.bounds);
  const drafts = usePowerStore((state) => state.drafts);
  const setDraft = usePowerStore((state) => state.setDraft);
  const clearDraft = usePowerStore((state) => state.clearDraft);
  const loadBounds = usePowerStore((state) => state.loadBounds);
  const applyMany = usePowerStore((state) => state.applyMany);
  const applyOne = usePowerStore((state) => state.applyOne);
  const resetOne = usePowerStore((state) => state.resetOne);
  const pushToast = useUiStore((state) => state.pushToast);

  const [selected, setSelected] = useState<string[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [applying, setApplying] = useState(false);

  const uuids = useMemo(() => devices.map((device) => device.uuid), [devices]);

  useEffect(() => {
    if (uuids.length > 0) void loadBounds(uuids);
  }, [uuids, loadBounds]);

  const rangeOf = (device: GpuDevice): { min: number; max: number; current: number } => {
    const bound = bounds[device.uuid];
    const min = bound?.minWatts ?? device.power.minLimitW ?? 0;
    const max = bound?.maxWatts ?? device.power.maxLimitW ?? 0;
    const current = bound?.currentWatts ?? device.power.limitW ?? min;
    return { min, max, current };
  };

  const energyOf = (uuid: string): IntegratedEnergy | null => {
    const samples = history
      .map((frame) => {
        const point = frame.byUuid[uuid];
        const watts = point?.powerW ?? null;
        return watts === null ? null : { at: frame.at, powerW: watts };
      })
      .filter((sample): sample is { at: number; powerW: number } => sample !== null);
    if (samples.length === 0) return null;
    return integrateEnergy(samples);
  };

  const staged: StagedChange[] = useMemo(() => {
    const changes: StagedChange[] = [];
    for (const device of devices) {
      if (!selected.includes(device.uuid)) continue;
      const { min, max, current } = rangeOf(device);
      const draft = drafts[device.uuid];
      if (draft === undefined) continue;
      if (!Number.isInteger(draft) || draft < min || draft > max) continue;
      if (draft === current) continue;
      changes.push({ uuid: device.uuid, name: device.name, current, next: draft });
    }
    return changes;
  }, [devices, selected, drafts, bounds]);

  const invalidUuids = useMemo(() => {
    const invalid = new Set<string>();
    for (const device of devices) {
      const { min, max } = rangeOf(device);
      const draft = drafts[device.uuid];
      if (draft === undefined) continue;
      if (!Number.isInteger(draft) || draft < min || draft > max) invalid.add(device.uuid);
    }
    return invalid;
  }, [devices, drafts, bounds]);

  const toggleSelected = (uuid: string): void => {
    setSelected((current) =>
      current.includes(uuid) ? current.filter((item) => item !== uuid) : [...current, uuid],
    );
  };

  const restoreDefault = async (device: GpuDevice): Promise<void> => {
    try {
      const result = await resetOne(device.uuid);
      clearDraft(device.uuid);
      if (result.ok) {
        pushToast({ variant: 'success', title: t('power.resetDone'), description: device.name });
      } else {
        pushToast({
          variant: 'error',
          title: t('error.title'),
          description: result.error?.message ?? t('error.unknown'),
        });
      }
    } catch (error) {
      pushToast({
        variant: 'error',
        title: t('error.title'),
        description: (error as Error).message,
      });
    }
  };

  const confirmApply = async (): Promise<void> => {
    setApplying(true);
    try {
      if (staged.length === 1) {
        const change = staged[0];
        const result = await applyOne(change.uuid, change.next);
        clearDraft(change.uuid);
        setDialogOpen(false);
        if (result.ok) {
          pushToast({ variant: 'success', title: t('power.applied'), description: change.name });
        } else {
          pushToast({
            variant: 'error',
            title: t('error.title'),
            description: result.error?.message ?? t('error.unknown'),
          });
        }
        return;
      }

      const results = await applyMany(
        staged.map((change) => ({ uuid: change.uuid, watts: change.next })),
      );
      setDialogOpen(false);
      const failed = results.filter((result) => !result.ok);
      if (failed.length === 0) {
        staged.forEach((change) => clearDraft(change.uuid));
        pushToast({
          variant: 'success',
          title: t('power.resultOk', { count: results.length }),
        });
      } else {
        pushToast({
          variant: 'error',
          title: t('power.resultFailed', { count: failed.length }),
          description: failed[0]?.error?.message ?? t('error.unknown'),
        });
      }
    } catch (error) {
      pushToast({
        variant: 'error',
        title: t('error.title'),
        description: (error as Error).message,
      });
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader title={t('power.title')} description={t('power.subtitle')} />

      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <ConceptTile
          icon={<Zap className="h-4 w-4" aria-hidden="true" />}
          label={t('power.instantPower')}
          description={t('power.explainInstant')}
        />
        <ConceptTile
          icon={<Gauge className="h-4 w-4" aria-hidden="true" />}
          label={t('power.limitLabel')}
          description={t('power.explainLimit')}
        />
        <ConceptTile
          icon={<BatteryCharging className="h-4 w-4" aria-hidden="true" />}
          label={t('power.energyConsumed')}
          description={t('power.explainEnergy')}
        />
      </div>

      {devices.length === 0 ? (
        <EmptyState
          icon={<Gauge className="h-5 w-5" aria-hidden="true" />}
          title={t('power.noGpuSelected')}
          description={t('dashboard.noGpus.description')}
        />
      ) : (
        <div className="space-y-3">
          {devices.map((device) => {
            const { min, max, current } = rangeOf(device);
            const adjustable = device.capabilities.powerLimitAdjustable;
            const draft = drafts[device.uuid] ?? current;
            const invalid = invalidUuids.has(device.uuid);
            const energy = energyOf(device.uuid);
            const isSelected = selected.includes(device.uuid);

            return (
              <Card key={device.uuid}>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <Switch
                        checked={isSelected}
                        onCheckedChange={() => toggleSelected(device.uuid)}
                        disabled={!adjustable}
                        aria-label={t('power.applyToGpu', { name: device.name })}
                      />
                      <div className="min-w-0">
                        <CardTitle className="truncate text-sm">{device.name}</CardTitle>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {t('power.range')}: {t('power.rangeValues', { min, max })}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {!adjustable && (
                        <Badge variant="warning">{t('power.notAdjustable')}</Badge>
                      )}
                      <Badge variant="muted" className="font-mono">
                        {t('power.limitLabel')}: {formatWatts(locale, current)}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="space-y-4">
                  {!adjustable && (
                    <Alert variant="warning">
                      <Info className="h-4 w-4" aria-hidden="true" />
                      <AlertTitle>{t('power.notAdjustable')}</AlertTitle>
                      <AlertDescription>{t('power.notAdjustableDescription')}</AlertDescription>
                    </Alert>
                  )}

                  <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <Label htmlFor={`slider-${device.uuid}`}>{t('power.limitLabel')}</Label>
                        <Slider
                          id={`slider-${device.uuid}`}
                          value={[Number.isFinite(draft) ? draft : current]}
                          min={min}
                          max={max}
                          step={1}
                          disabled={!adjustable}
                          onValueChange={(value: number[]) => {
                            const next = value[0];
                            if (next !== undefined) setDraft(device.uuid, next);
                          }}
                          aria-label={`${t('power.limitLabel')} — ${device.name}`}
                        />
                        <div className="flex justify-between text-[10px] text-muted-foreground">
                          <span>{formatWatts(locale, min)}</span>
                          <span>{formatWatts(locale, max)}</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-end gap-3">
                        <div className="w-36 space-y-1.5">
                          <Label htmlFor={`input-${device.uuid}`}>{t('power.limitLabel')}</Label>
                          <Input
                            id={`input-${device.uuid}`}
                            type="number"
                            inputMode="numeric"
                            min={min}
                            max={max}
                            step={1}
                            disabled={!adjustable}
                            value={Number.isFinite(draft) ? String(draft) : ''}
                            aria-invalid={invalid}
                            aria-describedby={invalid ? `error-${device.uuid}` : undefined}
                            onChange={(event) => {
                              const raw = event.target.value;
                              setDraft(device.uuid, raw.trim() === '' ? Number.NaN : Number(raw));
                            }}
                          />
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!adjustable}
                          onClick={() => void restoreDefault(device)}
                        >
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                          {t('power.restoreDefault')}
                        </Button>
                        {invalid && (
                          <p
                            id={`error-${device.uuid}`}
                            role="alert"
                            className="text-[11px] text-destructive"
                          >
                            {Number.isInteger(draft)
                              ? t('power.outOfRange', { min, max })
                              : t('power.notInteger')}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                      <MetricLine
                        label={t('power.instantPower')}
                        value={formatWatts(locale, device.power.drawW)}
                      />
                      <MetricLine
                        label={t('power.limitLabel')}
                        value={formatWatts(locale, current)}
                      />
                      <Separator />
                      <MetricLine
                        label={t('power.energyConsumed')}
                        value={
                          energy && energy.measuredMs > 0
                            ? `${formatJoules(locale, energy.joules)} · ${formatWattHours(locale, energy.wattHours)}`
                            : '—'
                        }
                      />
                      <p className="text-[10px] leading-relaxed text-muted-foreground">
                        {t('power.measurementSince', {
                          minutes: Math.max(1, Math.round(history.length / 60)),
                        })}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {selected.length > 0 && (
            <div className="sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/95 px-4 py-3 shadow-xl backdrop-blur">
              <div className="flex items-center gap-2 text-xs">
                <Info className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                <span className="text-muted-foreground">
                  {staged.length > 0
                    ? t('power.applyMany', { count: staged.length })
                    : t('power.noGpuSelected')}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    selected.forEach((uuid) => clearDraft(uuid));
                    setSelected([]);
                  }}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('common.cancel')}
                </Button>
                <Button
                  size="sm"
                  disabled={staged.length === 0}
                  onClick={() => setDialogOpen(true)}
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('common.apply')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('power.confirmTitle')}</DialogTitle>
            <DialogDescription>{t('power.confirmDescription')}</DialogDescription>
          </DialogHeader>

          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t('power.confirmList')}
            </p>
            <ul className="space-y-1.5">
              {staged.map((change) => (
                <li
                  key={change.uuid}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
                >
                  <span className="min-w-0 truncate">{change.name}</span>
                  <span className="metric shrink-0 font-mono text-[11px]">
                    {t('power.currentToNew', {
                      current: formatInt(locale, change.current),
                      next: formatInt(locale, change.next),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void confirmApply()} disabled={applying || staged.length === 0}>
              {t('power.confirmApply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConceptTile({
  icon,
  label,
  description,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card px-3.5 py-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        {icon}
      </span>
      <div>
        <p className="text-xs font-semibold">{label}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function MetricLine({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={cn('metric text-xs font-semibold')}>{value}</span>
    </div>
  );
}
