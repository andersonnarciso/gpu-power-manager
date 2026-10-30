import { useCallback, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/lib/i18n';
import { useUiStore } from '@renderer/store/ui';
import { writeToClipboard } from '@renderer/lib/clipboard';
import { Button } from '@renderer/components/ui/button';

export interface CopyableValueProps {
  value: string;
  display: string;
  label: string;
  className?: string;
}

/**
 * Read-only value that can be copied to the clipboard.
 *
 * The copy is only reported as successful when the text really reached the
 * clipboard — otherwise the user would be told a lie.
 */
export function CopyableValue({
  value,
  display,
  label,
  className,
}: CopyableValueProps): React.JSX.Element {
  const t = useT();
  const pushToast = useUiStore((state) => state.pushToast);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async (): Promise<void> => {
    const succeeded = await writeToClipboard(value);

    if (!succeeded) {
      pushToast({ variant: 'error', title: t('common.copyFailed'), description: value });
      return;
    }

    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
    pushToast({ variant: 'success', title: t('common.copied'), description: display });
  }, [display, pushToast, t, value]);

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <code
        className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
        title={value}
      >
        {display}
      </code>
      <Button
        variant="ghost"
        size="icon-sm"
        className="h-6 w-6 shrink-0 text-muted-foreground"
        onClick={() => void copy()}
        aria-label={label}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}
