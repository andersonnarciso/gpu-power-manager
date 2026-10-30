import { AlertOctagon, RefreshCw } from 'lucide-react';
import type { AppError } from '@shared/types';
import { useT } from '@renderer/lib/i18n';
import { Button } from '@renderer/components/ui/button';
import { Badge } from '@renderer/components/ui/badge';

/**
 * Dedicated panel shown when the application runs inside Electron but the
 * preload bridge is missing. The renderer refuses to display simulated data
 * in that situation.
 */
export function BridgeErrorPanel({ error }: { error: AppError | null }): React.JSX.Element {
  const t = useT();

  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-background p-6">
      <div className="w-full max-w-xl rounded-xl border border-destructive/40 bg-card p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/15 text-destructive">
            <AlertOctagon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-base font-semibold tracking-tight">
              {t('bridge.unavailableTitle')}
            </h1>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {t('bridge.unavailableDescription')}
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('bridge.technicalDetail')}
          </p>
          {error && (
            <>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground">{t('bridge.code')}</span>
                <Badge variant="destructive" className="font-mono">
                  {error.code}
                </Badge>
              </div>
              <p className="text-[11px] leading-relaxed text-foreground/90">{error.message}</p>
              {error.detail && (
                <p className="mt-1.5 break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {error.detail}
                </p>
              )}
            </>
          )}
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            {t('bridge.simulationDisabled')}
          </p>
        </div>

        <div className="mt-4 flex justify-end">
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('bridge.retry')}
          </Button>
        </div>
      </div>
    </div>
  );
}
