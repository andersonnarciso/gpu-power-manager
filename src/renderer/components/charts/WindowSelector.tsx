import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/lib/i18n';
import { HISTORY_WINDOWS, useTelemetryStore } from '@renderer/store/telemetry';

export interface WindowSelectorProps {
  className?: string;
}

/** Selector of the time window shown by every chart. */
export function WindowSelector({ className }: WindowSelectorProps): React.JSX.Element {
  const t = useT();
  const windowMinutes = useTelemetryStore((state) => state.windowMinutes);
  const setWindow = useTelemetryStore((state) => state.setWindow);

  return (
    <div
      className={cn('inline-flex items-center gap-0.5 rounded-lg bg-muted p-1', className)}
      role="group"
      aria-label={t('dashboard.window')}
    >
      {HISTORY_WINDOWS.map((minutes) => {
        const active = windowMinutes === minutes;
        return (
          <button
            key={minutes}
            type="button"
            onClick={() => setWindow(minutes)}
            aria-pressed={active}
            className={cn(
              'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t('dashboard.windowMinutes', { minutes })}
          </button>
        );
      })}
    </div>
  );
}
