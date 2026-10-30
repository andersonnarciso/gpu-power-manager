import { useId, useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Locale } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { formatClockTime } from '@renderer/lib/format';
import { downsample, niceDomain, type ChartPoint } from '@renderer/lib/series';
import { SERIES_COLORS } from './seriesColors';

/** Maximum number of points rendered by a single series. */
const MAX_POINTS = 220;

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  data: ChartPoint[];
}

export interface LiveChartProps {
  title: string;
  unit: string;
  series: ChartSeries[];
  locale: Locale;
  height?: number;
  formatValue?: (value: number) => string;
  emptyLabel: string;
  className?: string;
}

interface ChartRow {
  at: number;
  [key: string]: number;
}

export function LiveChart({
  title,
  unit,
  series,
  locale,
  height = 168,
  formatValue,
  emptyLabel,
  className,
}: LiveChartProps): React.JSX.Element {
  const gradientId = useId().replace(/:/g, '');
  const rows = useMemo<ChartRow[]>(() => {
    const byTime = new Map<number, ChartRow>();
    for (const entry of series) {
      const points = downsample(entry.data, MAX_POINTS);
      for (const point of points) {
        let row = byTime.get(point.at);
        if (!row) {
          row = { at: point.at };
          byTime.set(point.at, row);
        }
        row[entry.key] = point.value;
      }
    }
    return [...byTime.values()].sort((a, b) => a.at - b.at);
  }, [series]);

  const domain = useMemo<[number, number]>(() => {
    const all: ChartPoint[] = [];
    for (const entry of series) {
      for (const point of entry.data) all.push(point);
    }
    if (all.length === 0) return [0, 1];
    return niceDomain(all, 0.18);
  }, [series]);

  const hasData = rows.length > 1;

  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border border-border bg-card px-3 pb-2 pt-3',
        className,
      )}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="truncate text-xs font-semibold tracking-tight">{title}</h3>
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {unit}
        </span>
      </div>

      {hasData ? (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                {series.map((entry) => (
                  <linearGradient
                    key={entry.key}
                    id={`${gradientId}-${entry.key}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor={entry.color} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={entry.color} stopOpacity={0.02} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid
                stroke="hsl(var(--border))"
                strokeOpacity={0.55}
                strokeDasharray="2 4"
                vertical={false}
              />
              <XAxis
                dataKey="at"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                hide={rows.length < 2}
                tickFormatter={(value: number) => formatClockTime(locale, value)}
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 9 }}
                tickLine={false}
                axisLine={false}
                minTickGap={48}
              />
              <YAxis
                domain={domain}
                width={42}
                allowDecimals={false}
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 9 }}
                tickLine={false}
                axisLine={false}
                tickCount={4}
                tickFormatter={(value: number) => String(Math.round(value))}
              />
              <Tooltip
                isAnimationActive={false}
                cursor={{ stroke: 'hsl(var(--ring))', strokeOpacity: 0.35 }}
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 8,
                  fontSize: 11,
                  padding: '6px 8px',
                  boxShadow: '0 10px 24px rgba(0,0,0,0.35)',
                }}
                labelStyle={{ color: 'hsl(var(--muted-foreground))', fontSize: 10, marginBottom: 2 }}
                labelFormatter={(label: number) => formatClockTime(locale, label)}
                formatter={(value: number) =>
                  formatValue ? formatValue(value) : `${Math.round(value * 10) / 10}`
                }
              />
              {series.map((entry) => (
                <Area
                  key={entry.key}
                  type="monotone"
                  dataKey={entry.key}
                  name={entry.label}
                  stroke={entry.color}
                  strokeWidth={1.75}
                  fill={`url(#${gradientId}-${entry.key})`}
                  connectNulls
                  isAnimationActive={false}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div
          style={{ height }}
          className="flex items-center justify-center rounded-md border border-dashed border-border text-center text-[11px] text-muted-foreground"
        >
          {emptyLabel}
        </div>
      )}

      {series.length > 1 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {series.map((entry) => (
            <span key={entry.key} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              {entry.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
