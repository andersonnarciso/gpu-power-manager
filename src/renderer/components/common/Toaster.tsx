import { useEffect, useRef } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/lib/i18n';
import { useUiStore } from '@renderer/store/ui';
import { Button } from '@renderer/components/ui/button';

const TOAST_TTL_MS = 5200;

export function Toaster(): React.JSX.Element {
  const toasts = useUiStore((state) => state.toasts);
  const dismiss = useUiStore((state) => state.dismissToast);
  const t = useT();
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    for (const toast of toasts) {
      if (timers.current.has(toast.id)) continue;
      const timer = window.setTimeout(() => {
        timers.current.delete(toast.id);
        dismiss(toast.id);
      }, TOAST_TTL_MS);
      timers.current.set(toast.id, timer);
    }
  }, [toasts, dismiss]);

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    },
    [],
  );

  if (toasts.length === 0) return <></>;

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      role="region"
      aria-label={t('toast.info')}
    >
      {toasts.map((toast) => {
        const Icon =
          toast.variant === 'success' ? CheckCircle2 : toast.variant === 'error' ? AlertTriangle : Info;
        return (
          <div
            key={toast.id}
            role="status"
            aria-live="polite"
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-card p-3 shadow-xl',
              'animate-in fade-in-0 slide-in-from-bottom-2 duration-200',
              toast.variant === 'success' && 'border-primary/40',
              toast.variant === 'error' && 'border-destructive/50',
              toast.variant === 'info' && 'border-border',
            )}
          >
            <Icon
              className={cn(
                'mt-0.5 h-4 w-4 shrink-0',
                toast.variant === 'success' && 'text-primary',
                toast.variant === 'error' && 'text-destructive',
                toast.variant === 'info' && 'text-info',
              )}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold leading-tight">{toast.title}</p>
              {toast.description && (
                <p className="mt-1 break-words text-[11px] leading-snug text-muted-foreground">
                  {toast.description}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-6 w-6 text-muted-foreground"
              onClick={() => dismiss(toast.id)}
              aria-label={t('toast.dismiss')}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
