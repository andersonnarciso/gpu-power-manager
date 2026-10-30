import { useMemo } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/lib/i18n';
import { useUiStore } from '@renderer/store/ui';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { NAV_ITEMS } from './navigation';

export function Sidebar(): React.JSX.Element {
  const t = useT();
  const section = useUiStore((state) => state.section);
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const setSection = useUiStore((state) => state.setSection);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);

  const items = useMemo(() => NAV_ITEMS, []);

  return (
    <TooltipProvider delayDuration={250}>
      <aside
        className={cn(
          // The surface comes from the theme tokens (`--card`), never from a
          // hard-coded palette: a fixed dark background turned the sidebar
          // into a muddy gray panel in the light theme.
          'relative z-20 flex h-full shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200 ease-out',
          collapsed ? 'w-16' : 'w-60',
        )}
        aria-label={t('nav.main')}
      >
        <nav className="flex-1 overflow-y-auto px-2.5 py-4">
          {!collapsed && (
            <p className="mb-2 px-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {t('nav.main')}
            </p>
          )}
          <ul className="space-y-1">
            {items.map((item) => {
              const active = item.id === section;
              const Icon = item.icon;
              const label = t(item.labelKey);
              const button = (
                <button
                  type="button"
                  onClick={() => setSection(item.id)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'group relative flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium',
                    'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary transition-opacity duration-150',
                      active ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {!collapsed && <span className="truncate">{label}</span>}
                </button>
              );

              return (
                <li key={item.id}>
                  {collapsed ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{button}</TooltipTrigger>
                      <TooltipContent side="right">{label}</TooltipContent>
                    </Tooltip>
                  ) : (
                    button
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="border-t border-border p-2.5">
          {!collapsed && (
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {t('app.tagline')}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-xs font-medium text-muted-foreground',
              'transition-colors duration-150 hover:bg-accent hover:text-accent-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <>
                <PanelLeftClose className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{t('nav.collapse')}</span>
              </>
            )}
          </button>
        </div>
      </aside>
    </TooltipProvider>
  );
}
