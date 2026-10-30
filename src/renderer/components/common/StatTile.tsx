import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { Progress } from '@renderer/components/ui/progress';

export interface StatTileProps {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  icon?: LucideIcon;
  tone?: 'default' | 'accent' | 'warning' | 'muted';
  /** Optional 0..100 fill rendered under the value. */
  progress?: number;
  className?: string;
}

/** Compact metric tile used across the dashboard and the detail pages. */
export function StatTile({
  label,
  value,
  unit,
  hint,
  icon: Icon,
  tone = 'default',
  progress,
  className,
}: StatTileProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2.5',
        className,
      )}
    >
      {/*
        The label sits on its own line so it gets the full width of the tile:
        inside a flex row next to the icon the two-line clamp never kicked in
        and long words ("Temperatura") were cut off at the tile border.
      */}
      <span className="text-[10px] font-medium uppercase leading-[1.25] tracking-[0.12em] text-muted-foreground line-clamp-2">
        {label}
      </span>
      <div className="flex items-baseline gap-1">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <span
          className={cn(
            'metric text-lg font-semibold leading-none',
            tone === 'accent' && 'text-primary',
            tone === 'warning' && 'text-warning',
            tone === 'muted' && 'text-muted-foreground',
          )}
        >
          {value}
        </span>
        {unit && <span className="text-[11px] font-medium text-muted-foreground">{unit}</span>}
      </div>
      {progress !== undefined && (
        <Progress value={Math.min(100, Math.max(0, progress))} className="mt-1.5" />
      )}
      {hint && <p className="truncate text-[10px] text-muted-foreground/80">{hint}</p>}
    </div>
  );
}

export interface DataRowProps {
  label: string;
  value: ReactNode;
  hint?: string;
  mono?: boolean;
}

/** Label / value row used by the device detail pages. */
export function DataRow({ label, value, hint, mono }: DataRowProps): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/50 py-1.5 last:border-0">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          'min-w-0 truncate text-right text-xs font-medium',
          mono && 'font-mono text-[11px]',
        )}
      >
        {value}
      </span>
      {hint && <span className="sr-only">{hint}</span>}
    </div>
  );
}
