import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, FlaskConical, Play, Square, Timer, type LucideIcon } from 'lucide-react';
import { efficiency } from '@shared/energy';
import type {
  BenchmarkResult,
  BenchmarkRunConfig,
  EnergySummary,
  GpuDevice,
  Locale,
  ThroughputUnit,
  WorkloadKind,
} from '@shared/types';
import { getLocale, useT, useSamplesLabel, type TranslationKey } from '@renderer/lib/i18n';
import {
  EM_DASH,
  formatDecimal2,
  formatEnergyPerUnit,
  formatInt,
  formatJoules,
  formatSeconds,
  formatTemperature,
  formatWattHours,
  formatWatts,
} from '@renderer/lib/format';
import {
  MIN_COVERAGE_PCT,
  arePeerRuns,
  comparablePairRuns,
  evidenceOf,
  isComparableRun,
  isEnergyMeasured,
  limitStatusOf,
  measuredJoules,
  runCoveragePct,
  runScope,
  scopedEnergy,
  type LimitStatus,
} from '@renderer/lib/benchmark-metrics';
import { cn } from '@renderer/lib/utils';
import { useTelemetryStore } from '@renderer/store/telemetry';
import { useBenchmarkStore } from '@renderer/store/benchmark';
import { usePowerStore } from '@renderer/store/power';
import { useUiStore } from '@renderer/store/ui';
import { PageHeader, EmptyState } from '@renderer/components/common/PageStates';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@renderer/components/ui/card';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { Badge } from '@renderer/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import {
  Table,
  TableBody,
  TableBodyCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@renderer/components/ui/table';
import { LiveChart, type ChartSeries } from '@renderer/components/charts/LiveChart';
import { SERIES_COLORS } from '@renderer/components/charts/seriesColors';

function throughputSuffix(unit: ThroughputUnit): TranslationKey {
  switch (unit) {
    case 'token':
      return 'bench.perToken';
    case 'image':
      return 'bench.perImage';
    case 'video-second':
      return 'bench.perVideoSecond';
    default:
      return 'bench.unitUnknown';
  }
}

/** The range of watts the driver accepts for a GPU. */
interface WattRange {
  min: number;
  max: number;
}

/**
 * The range of watts the driver accepts.
 *
 * The driver is the only authority: a hardcoded range would refuse values
 * that a 5060 Ti accepts and accept values that it refuses. When the driver
 * reports no range, the current limit is the only value that can be trusted.
 */
function wattRangeOf(device: GpuDevice | null): WattRange | null {
  if (!device) return null;
  const min = device.power.minLimitW;
  const max = device.power.maxLimitW;
  if (
    typeof min === 'number' &&
    typeof max === 'number' &&
    Number.isFinite(min) &&
    Number.isFinite(max) &&
    min > 0 &&
    max >= min
  ) {
    return { min, max };
  }
  const current = device.power.limitW ?? device.power.defaultLimitW;
  if (typeof current === 'number' && Number.isFinite(current) && current > 0) {
    return { min: current, max: current };
  }
  return null;
}

/** One row of the results table, with every figure already resolved. */
interface RunRow {
  run: BenchmarkResult;
  /** Energy of the run, restricted to the GPUs the run covered. */
  scope: EnergySummary | null;
  /** Measured energy in joules. `null` when it was not measured. */
  joules: number | null;
  /** Share of the run that was really measured, percent. Null when unknown. */
  coveragePct: number | null;
  /** Why the run failed, when it failed. */
  errorMessage: string | null;
  /** Energy per unit of work. `null` when it could not be derived. */
  efficiencyValue: number | null;
  efficiencyUnit: ThroughputUnit;
  /** Why the efficiency could not be derived. */
  efficiencyReason: string;
  avgTemperatureC: number | null;
  maxTemperatureC: number | null;
  /** Per GPU temperatures, for the breakdown under the overall value. */
  perGpuTemperatures: { name: string; avg: number | null; max: number | null }[];
  targetWatts: number | null;
  observedLimitW: number | null;
  limitStatus: LimitStatus;
  comparable: boolean;
}

export function BenchmarkPage(): React.JSX.Element {
  const t = useT();
  const locale = getLocale();
  const devices = useTelemetryStore((state) => state.devices);
  const adapters = useBenchmarkStore((state) => state.adapters);
  const runs = useBenchmarkStore((state) => state.runs);
  const runningId = useBenchmarkStore((state) => state.runningId);
  const liveRun = useBenchmarkStore((state) => state.liveRun);
  const live = useBenchmarkStore((state) => state.live);
  const loadAdapters = useBenchmarkStore((state) => state.loadAdapters);
  const loadRuns = useBenchmarkStore((state) => state.loadRuns);
  const startRun = useBenchmarkStore((state) => state.start);
  const stopRun = useBenchmarkStore((state) => state.stop);
  const refreshLive = useBenchmarkStore((state) => state.refreshLive);
  const applyOne = usePowerStore((state) => state.applyOne);
  const pushToast = useUiStore((state) => state.pushToast);

  const [adapterId, setAdapterId] = useState<string | null>(null);
  const [gpuUuid, setGpuUuid] = useState<string>('');
  const [targetWatts, setTargetWatts] = useState<string>('');
  const [runName, setRunName] = useState<string>('');
  const [durationLimit, setDurationLimit] = useState<string>('');
  const [baselineId, setBaselineId] = useState<string>('');
  const [candidateId, setCandidateId] = useState<string>('');
  const [compareNotice, setCompareNotice] = useState<string | null>(null);

  useEffect(() => {
    void loadAdapters();
    void loadRuns();
  }, [loadAdapters, loadRuns]);

  useEffect(() => {
    if (runningId === null) return;
    const timer = window.setInterval(() => {
      void refreshLive();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [runningId, refreshLive]);

  useEffect(() => {
    if (devices.length === 0) return;
    const device = devices.find((item) => item.uuid === gpuUuid) ?? devices[0];
    if (!device) return;
    if (gpuUuid === '') setGpuUuid(device.uuid);
    const limit = device.power.limitW ?? device.power.defaultLimitW;
    if (limit !== null && targetWatts === '') setTargetWatts(String(limit));
  }, [devices, gpuUuid, targetWatts]);

  const selectedAdapter = adapters.find((adapter) => adapter.id === adapterId) ?? null;
  const workload: WorkloadKind = selectedAdapter?.workload ?? 'manual';

  const device = devices.find((item) => item.uuid === gpuUuid) ?? null;
  const currentLimitW = device?.power.limitW ?? device?.power.defaultLimitW ?? null;
  const allowedRange = useMemo(() => wattRangeOf(device), [device]);

  const liveSeries = useMemo<ChartSeries[]>(() => {
    if (!liveRun) return [];
    const uuids = liveRun.config.uuids;
    return uuids.map((uuid, index) => {
      const device = devices.find((item) => item.uuid === uuid);
      return {
        key: uuid,
        label: device?.name ?? uuid,
        color: SERIES_COLORS[index % SERIES_COLORS.length],
        data: liveRun.samples
          .map((sample) => {
            const watts = sample.powerW[uuid];
            return typeof watts === 'number' ? { at: sample.at, value: watts } : null;
          })
          .filter((point): point is { at: number; value: number } => point !== null),
      };
    });
  }, [liveRun, devices]);

  const tableRuns = useMemo(
    () =>
      runs.filter(
        (run) =>
          run.status === 'completed' ||
          run.status === 'partial' ||
          run.status === 'aborted' ||
          run.status === 'failed',
      ),
    [runs],
  );

  const rows = useMemo<RunRow[]>(
    () =>
      tableRuns.map((run) => {
        const scope = scopedEnergy(run.energy, runScope(run));
        const uuid = run.config.uuids[0] ?? null;
        const evidence = evidenceOf(run);
        const result = scope ? efficiency(scope, run.throughput) : null;
        const coverage = runCoveragePct(run);

        let reason = t('bench.energyNotMeasured');
        if (!run.throughput) reason = t('bench.throughputNotMeasured');
        else if (run.throughput.count <= 0) reason = t('bench.noWorkProduced');
        else if (!isEnergyMeasured(scope)) reason = t('bench.energyNotMeasured');
        else if (coverage === null || coverage < MIN_COVERAGE_PCT) {
          // The joules only describe the measured window: without a known
          // coverage there is no evidence that they cover the whole workload.
          reason = t('bench.coverageNotMeasured');
        }

        return {
          run,
          scope,
          joules: measuredJoules(scope),
          coveragePct: coverage,
          errorMessage: run.error?.message ?? null,
          efficiencyValue: result && result.joulesPerUnit !== null ? result.joulesPerUnit : null,
          efficiencyUnit: result ? result.unit : 'unknown',
          efficiencyReason: reason,
          avgTemperatureC: scope?.avgTemperatureC ?? null,
          maxTemperatureC: scope?.maxTemperatureC ?? null,
          perGpuTemperatures: run.config.uuids.map((gpu) => ({
            name: devices.find((item) => item.uuid === gpu)?.name ?? gpu,
            avg: scope?.perGpu[gpu]?.avgTemperatureC ?? null,
            max: scope?.perGpu[gpu]?.maxTemperatureC ?? null,
          })),
          targetWatts: uuid ? run.config.wattsPerGpu[uuid] ?? null : null,
          observedLimitW: uuid ? evidence.observedLimitsW?.[uuid] ?? null : null,
          limitStatus: limitStatusOf(run),
          comparable: isComparableRun(run),
        };
      }),
    [tableRuns, devices, t],
  );

  const scopeLabel = useCallback(
    (uuids: readonly string[]): string => {
      if (uuids.length === 0) return t('bench.scopeUnknown');
      return uuids
        .map((uuid) => devices.find((item) => item.uuid === uuid)?.name ?? uuid)
        .join(', ');
    },
    [devices, t],
  );

  const liveScope = useMemo(
    () => (liveRun ? scopedEnergy(live, runScope(liveRun)) : null),
    [live, liveRun],
  );

  const samplesLabel = useSamplesLabel(liveRun?.samples.length ?? 0);

  // Only runs that really measured the same thing may be compared.
  const comparable = useMemo(() => comparablePairRuns(runs), [runs]);
  const baseline = comparable.find((run) => run.id === baselineId) ?? null;
  const candidateOptions = useMemo(
    () => (baseline ? comparable.filter((run) => arePeerRuns(baseline, run)) : comparable),
    [comparable, baseline],
  );
  const candidate = candidateOptions.find((run) => run.id === candidateId) ?? null;

  // A selection that stops being comparable is dropped, and the user is told.
  useEffect(() => {
    if (baselineId === '') return;
    if (comparable.some((run) => run.id === baselineId)) return;
    setBaselineId('');
    setCompareNotice(t('bench.compareDroppedBaseline'));
  }, [baselineId, comparable, t]);

  useEffect(() => {
    if (candidateId === '') return;
    if (candidateOptions.some((run) => run.id === candidateId)) return;
    setCandidateId('');
    setCompareNotice(t('bench.compareDroppedCandidate'));
  }, [candidateId, candidateOptions, t]);

  const applyTargetLimit = async (): Promise<void> => {
    const watts = Number(targetWatts);
    if (gpuUuid === '' || !Number.isFinite(watts) || watts <= 0) {
      pushToast({
        variant: 'error',
        title: t('error.title'),
        description: t('power.notInteger'),
      });
      return;
    }
    try {
      const result = await applyOne(gpuUuid, Math.round(watts));
      const confirmed = result.verification?.confirmed ?? result.ok;
      if (result.ok && confirmed) {
        pushToast({
          variant: 'success',
          title: t('bench.limitApplied'),
          description: formatWatts(locale, result.appliedWatts ?? Math.round(watts)),
        });
      } else {
        pushToast({
          variant: 'error',
          title: t('error.title'),
          description: result.error?.message ?? t('bench.limitApplyFailed'),
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

  const start = async (): Promise<void> => {
    if (gpuUuid === '') return;
    const watts = Number(targetWatts);
    if (!Number.isFinite(watts) || watts <= 0) {
      pushToast({
        variant: 'error',
        title: t('error.title'),
        description: t('power.notInteger'),
      });
      return;
    }
    if (allowedRange && (watts < allowedRange.min || watts > allowedRange.max)) {
      pushToast({
        variant: 'error',
        title: t('error.title'),
        description: t('power.outOfRange', { min: allowedRange.min, max: allowedRange.max }),
      });
      return;
    }

    const config: BenchmarkRunConfig = {
      name:
        runName.trim() ||
        `${selectedAdapter?.name ?? t('bench.workloadManual')} · ${formatInt(locale, watts)} W`,
      workload,
      adapterId: selectedAdapter?.id ?? null,
      uuids: [gpuUuid],
      wattsPerGpu: { [gpuUuid]: Math.round(watts) },
      durationLimitSeconds:
        durationLimit.trim() === '' ? null : Math.max(5, Number(durationLimit)),
    };

    try {
      await startRun(config);
      setRunName('');
    } catch (error) {
      pushToast({
        variant: 'error',
        title: t('error.title'),
        description: (error as Error).message,
      });
    }
  };

  const baselineScope = baseline ? scopedEnergy(baseline.energy, runScope(baseline)) : null;
  const candidateScope = candidate ? scopedEnergy(candidate.energy, runScope(candidate)) : null;

  return (
    <div className="animate-fade-in">
      <PageHeader title={t('bench.title')} description={t('bench.subtitle')} />

      <div className="grid gap-3 xl:grid-cols-[22rem_1fr]">
        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">{t('bench.adapters')}</CardTitle>
              <CardDescription>{t('bench.startHint')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {adapters.map((adapter) => {
                const selected = adapter.id === adapterId;
                return (
                  <button
                    key={adapter.id}
                    type="button"
                    disabled={!adapter.available}
                    onClick={() => setAdapterId(selected ? null : adapter.id)}
                    aria-pressed={selected}
                    className={cn(
                      'w-full rounded-lg border px-3 py-2.5 text-left transition-colors duration-150',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      adapter.available
                        ? selected
                          ? 'border-primary/60 bg-primary/5'
                          : 'border-border hover:bg-accent/60'
                        : 'cursor-not-allowed border-border bg-muted/30 opacity-70',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium">{adapter.name}</span>
                      <Badge variant={adapter.available ? 'success' : 'muted'}>
                        {adapter.available ? t('bench.available') : t('bench.unavailable')}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                      {adapter.detectionHint}
                    </p>
                    {adapter.endpoint && (
                      <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
                        {adapter.endpoint}
                      </p>
                    )}
                  </button>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">{t('bench.start')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="bench-gpu">{t('bench.gpu')}</Label>
                <Select value={gpuUuid} onValueChange={setGpuUuid}>
                  <SelectTrigger id="bench-gpu">
                    <SelectValue placeholder={t('bench.gpu')} />
                  </SelectTrigger>
                  <SelectContent>
                    {devices.map((device) => (
                      <SelectItem key={device.uuid} value={device.uuid}>
                        {device.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="bench-watts">{t('bench.targetPower')}</Label>
                <Input
                  id="bench-watts"
                  type="number"
                  step="1"
                  value={targetWatts}
                  onChange={(event) => setTargetWatts(event.target.value)}
                />
                <p className="text-[10px] text-muted-foreground">{t('bench.gpuLimitHint')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  {allowedRange ? (
                    <span className="text-[10px] text-muted-foreground">
                      {t('bench.allowedRange', { min: allowedRange.min, max: allowedRange.max })}
                    </span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">{t('bench.rangeUnknown')}</span>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px]"
                    disabled={currentLimitW === null}
                    onClick={() => {
                      if (currentLimitW === null) return;
                      setTargetWatts(String(currentLimitW));
                    }}
                  >
                    {t('bench.useCurrentLimit')}
                  </Button>
                </div>
                {currentLimitW !== null && Number(targetWatts) !== currentLimitW && (
                  <p className="text-[10px] text-warning">
                    {t('bench.currentLimitDiffers', {
                      current: formatWatts(locale, currentLimitW),
                      target: formatWatts(locale, Number(targetWatts)),
                    })}
                  </p>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  disabled={gpuUuid === '' || targetWatts === ''}
                  onClick={() => void applyTargetLimit()}
                >
                  {t('bench.applyLimitBefore')}
                </Button>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="bench-name">{t('bench.runName')}</Label>
                <Input
                  id="bench-name"
                  value={runName}
                  placeholder={t('bench.runName')}
                  onChange={(event) => setRunName(event.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="bench-duration">{t('bench.durationLimit')}</Label>
                <Input
                  id="bench-duration"
                  type="number"
                  step="5"
                  placeholder={t('common.optional')}
                  value={durationLimit}
                  onChange={(event) => setDurationLimit(event.target.value)}
                />
              </div>

              <div className="flex items-center gap-2">
                {runningId ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    className="flex-1"
                    onClick={() => {
                      if (runningId) void stopRun(runningId);
                    }}
                  >
                    <Square className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('bench.stop')}
                  </Button>
                ) : (
                  <Button size="sm" className="flex-1" disabled={!gpuUuid} onClick={() => void start()}>
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('bench.start')}
                  </Button>
                )}
              </div>

              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {t('bench.energyDisclaimer')}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-3">
          <LiveChart
            title={t('bench.liveChart')}
            unit="W"
            series={liveSeries}
            locale={locale}
            height={190}
            formatValue={(value) => `${formatInt(locale, value)} W`}
            emptyLabel={t('bench.idle')}
          />

          {runningId && (
            <div className="flex items-center gap-2">
              <Badge variant="success" className="gap-1.5">
                <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-primary" aria-hidden="true" />
                {t('bench.running')}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {liveRun?.config.name ?? ''}
              </span>
            </div>
          )}

          {runningId && live && (
            <div className="space-y-1.5">
              <div className="grid gap-2 sm:grid-cols-4">
                <LiveMetric
                  label={t('bench.energyTotal')}
                  value={
                    <Measured
                      value={measuredJoules(liveScope)}
                      format={(joules) => formatJoules(locale, joules)}
                      reason={t('bench.energyNotMeasured')}
                    />
                  }
                  icon={FlaskConical}
                />
                <LiveMetric
                  label={t('bench.avgPower')}
                  value={formatWatts(locale, averagePower(liveScope))}
                  icon={Activity}
                />
                <LiveMetric
                  label={t('bench.duration')}
                  value={
                    liveRun
                      ? formatSeconds(locale, (Date.now() - liveRun.startedAt) / 1000)
                      : EM_DASH
                  }
                  icon={Timer}
                />
                <LiveMetric label={samplesLabel} value={samplesLabel} />
              </div>
              <p className="text-[10px] text-muted-foreground">
                {t('bench.scope', {
                  gpus: scopeLabel(liveRun ? runScope(liveRun) : []),
                })}
              </p>
            </div>
          )}

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm">{t('bench.results')}</CardTitle>
                <Badge variant="muted">{tableRuns.length}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              {tableRuns.length === 0 ? (
                <EmptyState
                  icon={<FlaskConical className="h-5 w-5" aria-hidden="true" />}
                  title={t('bench.noResults')}
                  description={t('bench.noResultsHint')}
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('bench.runName')}</TableHead>
                      <TableHead>{t('common.status')}</TableHead>
                      <TableHead>{t('bench.energy')}</TableHead>
                      <TableHead>{t('bench.duration')}</TableHead>
                      <TableHead>{t('bench.avgPower')}</TableHead>
                      <TableHead>{t('bench.peakPower')}</TableHead>
                      <TableHead>{t('bench.temperatureAvg')}</TableHead>
                      <TableHead>{t('bench.temperatureMax')}</TableHead>
                      <TableHead>{t('bench.throughput')}</TableHead>
                      <TableHead>{t('bench.efficiency')}</TableHead>
                      <TableHead>{t('bench.powerLimitColumn')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => {
                      const uuid = row.run.config.uuids[0] ?? null;
                      const perGpu = uuid ? row.scope?.perGpu[uuid] : undefined;
                      return (
                        <TableRow key={row.run.id}>
                          <TableBodyCell className="max-w-52 font-medium">
                            <div className="truncate">{row.run.config.name}</div>
                            <div className="truncate text-[10px] font-normal text-muted-foreground">
                              {t('bench.scope', { gpus: scopeLabel(runScope(row.run)) })}
                            </div>
                          </TableBodyCell>
                          <TableBodyCell>
                            <div className="flex items-center gap-1.5">
                              <Badge
                                variant={
                                  row.run.status === 'completed'
                                    ? 'success'
                                    : row.run.status === 'partial'
                                      ? 'info'
                                      : row.run.status === 'aborted'
                                        ? 'warning'
                                        : 'destructive'
                                }
                              >
                                {row.run.status === 'completed'
                                  ? t('bench.statusCompleted')
                                  : row.run.status === 'partial'
                                    ? t('bench.statusPartial')
                                    : row.run.status === 'aborted'
                                      ? t('bench.statusAborted')
                                      : t('bench.statusFailed')}
                              </Badge>
                              {row.limitStatus === 'not-applied' && (
                                <Badge variant="warning">{t('bench.notComparable')}</Badge>
                              )}
                            </div>
                            {row.errorMessage && (
                              <p className="mt-1 max-w-56 whitespace-normal text-[10px] leading-relaxed text-destructive">
                                <span className="font-medium">{t('bench.runError')}: </span>
                                {row.errorMessage}
                              </p>
                            )}
                          </TableBodyCell>
                          <TableBodyCell className="font-mono text-[11px]">
                            {row.joules !== null ? (
                              `${formatJoules(locale, row.joules)} · ${formatWattHours(
                                locale,
                                row.scope?.wattHoursTotal ?? null,
                              )}`
                            ) : (
                              <NotMeasured reason={t('bench.energyNotMeasured')} />
                            )}
                            <div className="text-[10px] text-muted-foreground">
                              {t('bench.coverageLabel')}:{' '}
                              {row.coveragePct !== null ? (
                                `${formatDecimal2(locale, row.coveragePct)} %`
                              ) : (
                                t('bench.notMeasured')
                              )}
                            </div>
                          </TableBodyCell>
                          <TableBodyCell className="font-mono text-[11px]">
                            {formatSeconds(locale, row.run.durationSeconds)}
                          </TableBodyCell>
                          <TableBodyCell className="font-mono text-[11px]">
                            {formatWatts(locale, perGpu?.avgPowerW ?? null)}
                          </TableBodyCell>
                          <TableBodyCell className="font-mono text-[11px]">
                            {formatWatts(locale, perGpu?.peakPowerW ?? null)}
                          </TableBodyCell>
                          <TableBodyCell className="font-mono text-[11px]">
                            <Temperature
                              locale={locale}
                              value={row.avgTemperatureC}
                              perGpu={row.perGpuTemperatures.map((entry) => ({
                                name: entry.name,
                                value: entry.avg,
                              }))}
                              reason={t('bench.notMeasured')}
                            />
                          </TableBodyCell>
                          <TableBodyCell className="font-mono text-[11px]">
                            <Temperature
                              locale={locale}
                              value={row.maxTemperatureC}
                              perGpu={row.perGpuTemperatures.map((entry) => ({
                                name: entry.name,
                                value: entry.max,
                              }))}
                              reason={t('bench.notMeasured')}
                            />
                          </TableBodyCell>
                          <TableBodyCell className="font-mono text-[11px]">
                            {row.run.throughput
                              ? `${formatInt(locale, row.run.throughput.count)} ${row.run.throughput.label}`
                              : t('bench.throughputUnavailable')}
                          </TableBodyCell>
                          <TableBodyCell className="font-mono text-[11px]">
                            {row.efficiencyValue !== null ? (
                              formatEnergyPerUnit(
                                locale,
                                row.efficiencyValue,
                                t(throughputSuffix(row.efficiencyUnit)),
                              )
                            ) : (
                              <NotMeasured reason={row.efficiencyReason} />
                            )}
                          </TableBodyCell>
                          <TableBodyCell className="font-mono text-[11px]">
                            <div>
                              {t('bench.targetLabel')}: {formatWatts(locale, row.targetWatts)}
                            </div>
                            <div className="text-muted-foreground">
                              {t('bench.observedLabel')}:{' '}
                              {row.observedLimitW !== null ? (
                                formatWatts(locale, row.observedLimitW)
                              ) : (
                                <NotMeasured reason={t('bench.notMeasured')} />
                              )}
                            </div>
                            <Badge
                              variant={
                                row.limitStatus === 'verified'
                                  ? 'success'
                                  : row.limitStatus === 'not-applied'
                                    ? 'warning'
                                    : 'muted'
                              }
                              className="mt-1"
                            >
                              {row.limitStatus === 'verified'
                                ? t('bench.limitVerified')
                                : row.limitStatus === 'not-applied'
                                  ? t('bench.limitNotApplied')
                                  : t('bench.limitNotVerified')}
                            </Badge>
                          </TableBodyCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
              <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
                {t('bench.energyDisclaimer')}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">{t('bench.compare')}</CardTitle>
              <CardDescription>{t('bench.compareHint')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {t('bench.compareOnlyComparable')}
              </p>
              {compareNotice && (
                <p className="text-[11px] text-warning" role="status">
                  {compareNotice}
                </p>
              )}
              {comparable.length < 2 ? (
                <p className="text-[11px] text-muted-foreground">{t('bench.selectTwoRuns')}</p>
              ) : (
                <>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Select
                      value={baselineId}
                      onValueChange={(value: string) => {
                        setBaselineId(value);
                        setCompareNotice(null);
                      }}
                    >
                      <SelectTrigger aria-label={t('bench.baseline')}>
                        <SelectValue placeholder={t('bench.baseline')} />
                      </SelectTrigger>
                      <SelectContent>
                        {comparable.map((run) => (
                          <SelectItem key={run.id} value={run.id}>
                            {run.config.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={candidateId}
                      onValueChange={(value: string) => {
                        setCandidateId(value);
                        setCompareNotice(null);
                      }}
                    >
                      <SelectTrigger aria-label={t('bench.candidate')}>
                        <SelectValue placeholder={t('bench.candidate')} />
                      </SelectTrigger>
                      <SelectContent>
                        {candidateOptions.map((run) => (
                          <SelectItem key={run.id} value={run.id}>
                            {run.config.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {baseline && candidate ? (
                    <div className="rounded-lg border border-border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t('common.value')}</TableHead>
                            <TableHead>{t('bench.baseline')}</TableHead>
                            <TableHead>{t('bench.candidate')}</TableHead>
                            <TableHead>{t('bench.deltaEnergy')}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          <CompareRow
                            label={t('bench.targetPower')}
                            baseline={formatWatts(
                              locale,
                              baseline.config.wattsPerGpu[baseline.config.uuids[0]],
                            )}
                            candidate={formatWatts(
                              locale,
                              candidate.config.wattsPerGpu[candidate.config.uuids[0]],
                            )}
                            delta={EM_DASH}
                          />
                          <CompareRow
                            label={t('bench.energy')}
                            baseline={
                              <Measured
                                value={measuredJoules(baselineScope)}
                                format={(joules) => formatJoules(locale, joules)}
                                reason={t('bench.energyNotMeasured')}
                              />
                            }
                            candidate={
                              <Measured
                                value={measuredJoules(candidateScope)}
                                format={(joules) => formatJoules(locale, joules)}
                                reason={t('bench.energyNotMeasured')}
                              />
                            }
                            delta={deltaPercent(
                              locale,
                              measuredJoules(candidateScope),
                              measuredJoules(baselineScope),
                            )}
                          />
                          <CompareRow
                            label={t('bench.avgPower')}
                            baseline={
                              <MeasuredText
                                measured={isEnergyMeasured(baselineScope)}
                                text={formatWatts(locale, averagePower(baselineScope))}
                                reason={t('bench.energyNotMeasured')}
                              />
                            }
                            candidate={
                              <MeasuredText
                                measured={isEnergyMeasured(candidateScope)}
                                text={formatWatts(locale, averagePower(candidateScope))}
                                reason={t('bench.energyNotMeasured')}
                              />
                            }
                            delta={deltaPercent(
                              locale,
                              averagePower(candidateScope),
                              averagePower(baselineScope),
                            )}
                          />
                          <CompareRow
                            label={t('bench.duration')}
                            baseline={formatSeconds(locale, baseline.durationSeconds)}
                            candidate={formatSeconds(locale, candidate.durationSeconds)}
                            delta={EM_DASH}
                          />
                          <CompareRow
                            label={t('bench.throughput')}
                            baseline={throughputText(locale, baseline, t)}
                            candidate={throughputText(locale, candidate, t)}
                            delta={EM_DASH}
                          />
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">{t('bench.selectTwoRuns')}</p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** The explicit marker of a measurement that does not exist. */
function NotMeasured({ reason }: { reason: string }): React.JSX.Element {
  return (
    <span className="text-muted-foreground" title={reason} aria-label={reason}>
      {EM_DASH}
    </span>
  );
}

/**
 * Renders a measured value, or the explicit marker when it was not measured.
 */
function Measured({
  value,
  format,
  reason,
}: {
  value: number | null;
  format: (value: number) => string;
  reason: string;
}): React.JSX.Element {
  if (value === null) return <NotMeasured reason={reason} />;
  return <>{format(value)}</>;
}

/** Renders a value that is only known when the measurement was resolved. */
function MeasuredText({
  measured,
  text,
  reason,
}: {
  measured: boolean;
  text: string;
  reason: string;
}): React.JSX.Element {
  if (!measured) return <NotMeasured reason={reason} />;
  return <>{text}</>;
}

/** Temperature of a run, overall and per GPU. */
function Temperature({
  locale,
  value,
  perGpu,
  reason,
}: {
  locale: Locale;
  value: number | null;
  perGpu: { name: string; value: number | null }[];
  reason: string;
}): React.JSX.Element {
  return (
    <div>
      {value === null ? <NotMeasured reason={reason} /> : formatTemperature(locale, value)}
      {perGpu.length > 1 && (
        <div className="mt-0.5 text-[10px] font-normal text-muted-foreground">
          {perGpu
            .map(
              (entry) =>
                `${entry.name}: ${
                  entry.value === null ? EM_DASH : formatTemperature(locale, entry.value)
                }`,
            )
            .join(' · ')}
        </div>
      )}
    </div>
  );
}

function LiveMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: React.ReactNode;
  icon?: LucideIcon;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex items-center gap-1.5">
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
        <span className="truncate text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </span>
      </div>
      <p className="metric mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

function CompareRow({
  label,
  baseline,
  candidate,
  delta,
}: {
  label: string;
  baseline: React.ReactNode;
  candidate: React.ReactNode;
  delta: React.ReactNode;
}): React.JSX.Element {
  return (
    <TableRow>
      <TableBodyCell className="text-muted-foreground">{label}</TableBodyCell>
      <TableBodyCell className="font-mono text-[11px]">{baseline}</TableBodyCell>
      <TableBodyCell className="font-mono text-[11px]">{candidate}</TableBodyCell>
      <TableBodyCell className="font-mono text-[11px]">{delta}</TableBodyCell>
    </TableRow>
  );
}

/** Average measured power of the GPUs a run covered, watts. */
function averagePower(summary: EnergySummary | null): number | null {
  if (!summary) return null;
  const values = Object.values(summary.perGpu)
    .map((entry) => entry.avgPowerW)
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function deltaPercent(locale: Locale, candidate: number | null, baseline: number | null): string {
  if (candidate === null || baseline === null || baseline === 0) return EM_DASH;
  const delta = ((candidate - baseline) / baseline) * 100;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${formatDecimal2(locale, delta)} %`;
}

function throughputText(
  locale: Locale,
  run: { throughput: { count: number; label: string } | null },
  t: (key: 'bench.throughputUnavailable') => string,
): string {
  if (!run.throughput) return t('bench.throughputUnavailable');
  return `${formatInt(locale, run.throughput.count)} ${run.throughput.label}`;
}
