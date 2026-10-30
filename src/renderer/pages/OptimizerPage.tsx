import { useEffect, useMemo, useState } from 'react';
import { Sparkles, TrendingDown, TrendingUp, TriangleAlert, Zap } from 'lucide-react';
import type {
  BenchmarkResult,
  Locale,
  OptimizerRecommendation,
  WorkloadKind,
} from '@shared/types';
import { getLocale, useT, useSamplesLabel } from '@renderer/lib/i18n';
import { getBridge } from '@renderer/lib/bridge';
import {
  EM_DASH,
  formatDeltaPercent,
  formatInt,
  formatWatts,
} from '@renderer/lib/format';
import { cn } from '@renderer/lib/utils';
import { comparableRuns } from '@renderer/lib/benchmark-metrics';
import { useTelemetryStore } from '@renderer/store/telemetry';
import { useBenchmarkStore } from '@renderer/store/benchmark';
import { usePowerStore } from '@renderer/store/power';
import { useUiStore } from '@renderer/store/ui';
import { PageHeader, EmptyState } from '@renderer/components/common/PageStates';
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { Badge } from '@renderer/components/ui/badge';
import { Slider } from '@renderer/components/ui/slider';
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
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert';

const WORKLOADS: readonly { value: WorkloadKind; key: 'bench.workloadLlm' | 'bench.workloadImage' | 'bench.workloadVideo' | 'bench.workloadCuda' | 'bench.workloadManual' }[] = [
  { value: 'llm-inference', key: 'bench.workloadLlm' },
  { value: 'image-generation', key: 'bench.workloadImage' },
  { value: 'video-generation', key: 'bench.workloadVideo' },
  { value: 'cuda-synthetic', key: 'bench.workloadCuda' },
  { value: 'manual', key: 'bench.workloadManual' },
];

export function OptimizerPage(): React.JSX.Element {
  const t = useT();
  const locale = getLocale();
  const devices = useTelemetryStore((state) => state.devices);
  const runs = useBenchmarkStore((state) => state.runs);
  const loadRuns = useBenchmarkStore((state) => state.loadRuns);
  const bounds = usePowerStore((state) => state.bounds);
  const applyOne = usePowerStore((state) => state.applyOne);
  const pushToast = useUiStore((state) => state.pushToast);

  const [gpuUuid, setGpuUuid] = useState('');
  const [workload, setWorkload] = useState<WorkloadKind>('llm-inference');
  const [baselineId, setBaselineId] = useState('');
  const [candidateMin, setCandidateMin] = useState('');
  const [candidateMax, setCandidateMax] = useState('');
  const [maxLoss, setMaxLoss] = useState(10);
  const [recommendations, setRecommendations] = useState<OptimizerRecommendation[]>([]);
  const [analysed, setAnalysed] = useState(false);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (devices.length === 0) return;
    const device = devices.find((item) => item.uuid === gpuUuid) ?? devices[0];
    if (!device) return;
    if (gpuUuid === '') setGpuUuid(device.uuid);
    const min = bounds[device.uuid]?.minWatts ?? device.power.minLimitW ?? null;
    const max = bounds[device.uuid]?.maxWatts ?? device.power.maxLimitW ?? null;
    if (candidateMin === '' && min !== null) setCandidateMin(String(min));
    if (candidateMax === '' && max !== null) setCandidateMax(String(max));
  }, [devices, gpuUuid, bounds, candidateMin, candidateMax]);

  const measurements = useMemo(
    () =>
      runs.filter(
        (run) => run.config.uuids.includes(gpuUuid) && run.config.workload === workload,
      ),
    [runs, gpuUuid, workload],
  );

  /**
   * Only runs that really measured the same thing take part in the
   * comparison: a completed run, with a complete measurement, whose power
   * limit was not known to be missing.
   */
  const comparable = useMemo(() => comparableRuns(measurements), [measurements]);

  const samplesLabel = useSamplesLabel(measurements.length);

  // Pre-select the oldest comparable run as the baseline.
  useEffect(() => {
    if (baselineId !== '' || comparable.length === 0) return;
    setBaselineId(comparable[0].id);
  }, [baselineId, comparable]);

  const candidates = useMemo(() => {
    const min = Number(candidateMin);
    const max = Number(candidateMax);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return [] as number[];
    const step = Math.max(1, Math.round((max - min) / 12));
    const values = new Set<number>();
    for (let value = min; value <= max; value += step) values.add(value);
    values.add(max);
    // The watt values that were really measured are always part of the
    // candidate set: a recommendation is only ever based on a real run.
    // Aborted runs, runs without a complete measurement and runs whose limit
    // was not in effect never seed the candidates.
    for (const run of comparable) {
      const watts = run.config.wattsPerGpu[gpuUuid];
      if (typeof watts === 'number' && watts >= min && watts <= max) values.add(watts);
    }
    return [...values].sort((a, b) => a - b);
  }, [candidateMin, candidateMax, comparable, gpuUuid]);

  const analyse = async (): Promise<void> => {
    if (baselineId === '') return;
    try {
      const result = await getBridge().optimizer.recommend({
        uuid: gpuUuid,
        workload,
        candidateWatts: candidates,
        maxPerformanceLossPct: maxLoss,
        baselineRunId: baselineId,
      });
      setRecommendations(result);
      setAnalysed(true);
      if (result.length === 0) {
        pushToast({
          variant: 'info',
          title: t('opt.noMeasurements'),
          description: t('opt.needRuns'),
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

  const applyRecommendation = async (recommendation: OptimizerRecommendation): Promise<void> => {
    try {
      const result = await applyOne(recommendation.uuid, recommendation.watts);
      if (result.ok) {
        pushToast({
          variant: 'success',
          title: t('opt.applied'),
          description: formatWatts(locale, recommendation.watts),
        });
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

  /**
   * The recommendation of the service.
   *
   * The service puts its recommendation first and ranks the other candidates
   * after it. The renderer never picks a candidate on its own: an
   * unmeasured energy delta is not a zero, so choosing the "cheapest" one
   * here would recommend a limit that was never measured.
   */
  const recommended = recommendations[0] ?? null;

  return (
    <div className="animate-fade-in">
      <PageHeader title={t('opt.title')} description={t('opt.subtitle')} />

      <div className="grid gap-3 xl:grid-cols-[22rem_1fr]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">{t('opt.measured')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="opt-gpu">{t('opt.gpu')}</Label>
              <Select value={gpuUuid} onValueChange={setGpuUuid}>
                <SelectTrigger id="opt-gpu">
                  <SelectValue placeholder={t('opt.gpu')} />
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
              <Label htmlFor="opt-workload">{t('opt.workload')}</Label>
              <Select
                value={workload}
                onValueChange={(value: string) => {
                  setWorkload(value as WorkloadKind);
                  setBaselineId('');
                }}
              >
                <SelectTrigger id="opt-workload">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORKLOADS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {t(item.key)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="opt-baseline">{t('opt.baselineRun')}</Label>
              <Select value={baselineId} onValueChange={setBaselineId}>
                <SelectTrigger id="opt-baseline">
                  <SelectValue placeholder={t('opt.baselineRun')} />
                </SelectTrigger>
                <SelectContent>
                  {comparable.map((run: BenchmarkResult) => (
                    <SelectItem key={run.id} value={run.id}>
                      {run.config.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>{t('opt.candidates')}</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  step="1"
                  value={candidateMin}
                  aria-label={`${t('opt.candidates')} ${t('gpus.minLimit')}`}
                  onChange={(event) => setCandidateMin(event.target.value)}
                />
                <span className="text-muted-foreground">–</span>
                <Input
                  type="number"
                  step="1"
                  value={candidateMax}
                  aria-label={`${t('opt.candidates')} ${t('gpus.maxLimit')}`}
                  onChange={(event) => setCandidateMax(event.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="opt-loss">{t('opt.maxLoss')}</Label>
              <Slider
                id="opt-loss"
                value={[maxLoss]}
                min={0}
                max={50}
                step={1}
                onValueChange={(value: number[]) => {
                  const next = value[0];
                  if (next !== undefined) setMaxLoss(next);
                }}
                aria-label={t('opt.maxLoss')}
              />
              <p className="text-[11px] text-muted-foreground">{t('opt.percent', { value: maxLoss })}</p>
            </div>

            <Button
              className="w-full"
              disabled={baselineId === '' || candidates.length === 0}
              onClick={() => void analyse()}
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {t('opt.analyze')}
            </Button>

            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {t('opt.energyDisclaimer')}
            </p>
          </CardContent>
        </Card>

        <div className="space-y-3">
          {measurements.length === 0 ? (
            <EmptyState
              icon={<Sparkles className="h-5 w-5" aria-hidden="true" />}
              title={t('opt.noMeasurements')}
              description={t('opt.noMeasurementsHint')}
            />
          ) : (
            <>
              <Alert variant="info">
                <TrendingDown className="h-4 w-4" aria-hidden="true" />
                <AlertTitle>{t('opt.needRuns')}</AlertTitle>
                <AlertDescription>{samplesLabel}</AlertDescription>
              </Alert>

              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {t('opt.comparableOnly')}
              </p>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">{t('opt.recommendation')}</CardTitle>
                </CardHeader>
                <CardContent>
                  {!analysed ? (
                    <p className="text-[11px] text-muted-foreground">{t('opt.noMeasurementsHint')}</p>
                  ) : recommendations.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">{t('opt.noRecommendation')}</p>
                  ) : (
                    <>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t('opt.watts')}</TableHead>
                            <TableHead>{t('opt.baselineWatts')}</TableHead>
                            <TableHead>{t('opt.performanceDelta')}</TableHead>
                            <TableHead>{t('opt.energyDelta')}</TableHead>
                            <TableHead>{t('common.status')}</TableHead>
                            <TableHead>{t('opt.reason')}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {recommendations.map((recommendation, index) => (
                            <TableRow
                              key={`${recommendation.uuid}-${recommendation.watts}`}
                              className={cn(index === 0 && 'bg-primary/5')}
                              data-recommended={index === 0 ? 'true' : undefined}
                              data-fallback={recommendation.fallback ? 'true' : undefined}
                            >
                              <TableBodyCell className="font-mono text-[11px] font-semibold">
                                {recommendation.watts > 0 ? (
                                  formatWatts(locale, recommendation.watts)
                                ) : (
                                  <span className="text-muted-foreground">{EM_DASH}</span>
                                )}
                                {index === 0 && (
                                  <Badge
                                    variant={recommendation.fallback ? 'warning' : 'success'}
                                    className="ml-1.5"
                                  >
                                    {recommendation.fallback
                                      ? t('opt.fallbackRecommendation')
                                      : t('opt.serviceRecommendation')}
                                  </Badge>
                                )}
                              </TableBodyCell>
                              <TableBodyCell className="font-mono text-[11px]">
                                {formatWatts(locale, recommendation.baselineWatts)}
                              </TableBodyCell>
                              <TableBodyCell className="font-mono text-[11px]">
                                <DeltaCell
                                  locale={locale}
                                  value={
                                    recommendation.fallback ? null : recommendation.performanceDeltaPct
                                  }
                                />
                              </TableBodyCell>
                              <TableBodyCell className="font-mono text-[11px]">
                                <DeltaCell
                                  locale={locale}
                                  value={recommendation.fallback ? null : recommendation.energyDeltaPct}
                                />
                              </TableBodyCell>
                              <TableBodyCell>
                                <Badge
                                  variant={
                                    recommendation.fallback
                                      ? 'warning'
                                      : recommendation.meetsConstraint
                                        ? 'success'
                                        : 'warning'
                                  }
                                >
                                  {recommendation.fallback
                                    ? t('opt.fallbackRecommendation')
                                    : recommendation.meetsConstraint
                                      ? t('opt.meetsConstraint')
                                      : t('opt.doesNotMeet')}
                                </Badge>
                              </TableBodyCell>
                              <TableBodyCell className="max-w-64 whitespace-normal text-[11px] text-muted-foreground">
                                {recommendation.reason}
                              </TableBodyCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>

                      {recommended && recommended.watts > 0 && (
                        <div
                          className={cn(
                            'mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5',
                            recommended.fallback
                              ? 'border-warning/40 bg-warning/5'
                              : 'border-primary/40 bg-primary/5',
                          )}
                        >
                          <div className="flex items-center gap-2">
                            {recommended.fallback ? (
                              <TriangleAlert
                                className="h-4 w-4 text-warning"
                                aria-hidden="true"
                              />
                            ) : (
                              <Zap className="h-4 w-4 text-primary" aria-hidden="true" />
                            )}
                            <span className="text-xs">
                              {recommended.fallback
                                ? t('opt.fallbackKeepsReference')
                                : t('opt.watts')}{' '}
                              <span className="font-mono font-semibold">
                                {formatInt(locale, recommended.watts)} W
                              </span>
                            </span>
                          </div>
                          {recommended.fallback ? (
                            <p className="max-w-72 text-[10px] leading-relaxed text-muted-foreground">
                              {t('opt.fallbackNoApply')}
                            </p>
                          ) : (
                            <Button
                              size="sm"
                              onClick={() => void applyRecommendation(recommended)}
                            >
                              {t('opt.applyRecommendation')}
                            </Button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DeltaCell({ locale, value }: { locale: Locale; value: number | null }): React.JSX.Element {
  if (value === null) return <span className="text-muted-foreground">{EM_DASH}</span>;
  const negative = value < 0;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1',
        negative ? 'text-primary' : 'text-warning',
      )}
    >
      {negative ? (
        <TrendingDown className="h-3 w-3" aria-hidden="true" />
      ) : (
        <TrendingUp className="h-3 w-3" aria-hidden="true" />
      )}
      {formatDeltaPercent(locale, value)}
    </span>
  );
}
