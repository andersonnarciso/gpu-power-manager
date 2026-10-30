import { Cpu, Languages, Moon, PanelLeftClose, PanelLeftOpen, Sun, Zap } from 'lucide-react';
import { useMemo } from 'react';
import type { Locale } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/lib/i18n';
import { useUiStore } from '@renderer/store/ui';
import { useSettingsStore } from '@renderer/store/settings';
import { useAppStore } from '@renderer/store/app';
import { useTelemetryStore } from '@renderer/store/telemetry';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { useSectionLabel } from './sectionMeta';

/** Small badge with the product version. */
function VersionBadge(): React.JSX.Element {
  const t = useT();
  const version = '1.0.0';
  return (
    <Badge variant="muted" className="font-mono text-[10px]">
      {t('app.version', { version })}
    </Badge>
  );
}

function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'off' }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-1.5 w-1.5 rounded-full',
        tone === 'ok' && 'bg-primary',
        tone === 'warn' && 'bg-warning',
        tone === 'off' && 'bg-muted-foreground/60',
      )}
    />
  );
}

export function Header(): React.JSX.Element {
  const t = useT();
  const sectionLabel = useSectionLabel();
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.update);
  const info = useAppStore((state) => state.info);
  const simulated = useAppStore((state) => state.simulated);
  const connected = useTelemetryStore((state) => state.connected);

  const isDark = useMemo(() => {
    if (settings.theme === 'system') {
      return (
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches
      );
    }
    return settings.theme === 'dark';
  }, [settings.theme]);

  const toggleLocale = (): void => {
    const next: Locale = settings.locale === 'pt-BR' ? 'en' : 'pt-BR';
    void updateSettings({ locale: next });
  };

  const driverAvailable = info?.driverAvailable ?? false;

  return (
    <TooltipProvider delayDuration={250}>
      <header className="z-10 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card/70 px-4 backdrop-blur">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleSidebar}
          aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
          className="text-muted-foreground"
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
          ) : (
            <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>

        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
            <Zap className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold tracking-tight">
              {t('app.name')}
            </span>
            <VersionBadge />
            <span className="hidden truncate text-xs text-muted-foreground md:inline">
              / {sectionLabel}
            </span>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {simulated && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Badge variant="warning" className="gap-1.5 font-semibold tracking-wider">
                    <StatusDot tone="warn" />
                    {t('header.simulationBadge')}
                  </Badge>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t('header.simulationTooltip')}</TooltipContent>
            </Tooltip>
          )}

          <div
            className="hidden items-center gap-2 rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-xs lg:flex"
            title={driverAvailable ? t('header.driverDetected') : t('header.driverMissing')}
          >
            <Cpu className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <StatusDot tone={driverAvailable ? 'ok' : 'warn'} />
            <span className="text-muted-foreground">
              {driverAvailable ? t('header.driverDetected') : t('header.driverMissing')}
            </span>
            <span className="text-border" aria-hidden="true">
              |
            </span>
            <span className="text-muted-foreground">
              {connected ? t('header.connected') : t('header.connecting')}
            </span>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('header.theme')}>
                {isDark ? (
                  <Moon className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Sun className="h-4 w-4" aria-hidden="true" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t('header.theme')}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => void updateSettings({ theme: 'dark' })}>
                <Moon className="h-4 w-4" aria-hidden="true" />
                {t('header.themeDark')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void updateSettings({ theme: 'light' })}>
                <Sun className="h-4 w-4" aria-hidden="true" />
                {t('header.themeLight')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void updateSettings({ theme: 'system' })}>
                <Cpu className="h-4 w-4" aria-hidden="true" />
                {t('header.themeSystem')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button variant="ghost" size="icon-sm" onClick={toggleLocale} aria-label={t('header.toggleLanguage')}>
            <Languages className="h-4 w-4" aria-hidden="true" />
            <span className="ml-1 text-[10px] font-semibold uppercase">
              {settings.locale === 'pt-BR' ? 'PT' : 'EN'}
            </span>
          </Button>
        </div>
      </header>
    </TooltipProvider>
  );
}
