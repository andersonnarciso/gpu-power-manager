/**
 * Navigation catalogue.
 *
 * Kept in its own module (no React component) so the sidebar module only
 * exports components and stays compatible with React Fast Refresh.
 */

import {
  Activity,
  Cpu,
  Gauge,
  History,
  LayoutDashboard,
  Layers,
  Settings,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import type { TranslationKey } from '@renderer/lib/i18n';
import type { SectionId } from '@renderer/store/ui';

export interface NavItem {
  id: SectionId;
  labelKey: TranslationKey;
  icon: LucideIcon;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
  { id: 'gpus', labelKey: 'nav.gpus', icon: Cpu },
  { id: 'powerLimit', labelKey: 'nav.powerLimit', icon: Gauge },
  { id: 'profiles', labelKey: 'nav.profiles', icon: Layers },
  { id: 'benchmark', labelKey: 'nav.benchmark', icon: Activity },
  { id: 'optimizer', labelKey: 'nav.optimizer', icon: Sparkles },
  { id: 'processes', labelKey: 'nav.processes', icon: SquareTerminal },
  { id: 'history', labelKey: 'nav.history', icon: History },
  { id: 'settings', labelKey: 'nav.settings', icon: Settings },
];
