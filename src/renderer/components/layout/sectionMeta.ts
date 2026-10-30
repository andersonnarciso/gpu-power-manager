/**
 * Sidebar metadata shared with the header.
 *
 * Only hooks live here, which keeps every module of the renderer compatible
 * with React Fast Refresh.
 */

import { useT } from '@renderer/lib/i18n';
import { useUiStore } from '@renderer/store/ui';
import { NAV_ITEMS } from './navigation';

/** Label of the section currently open. */
export function useSectionLabel(): string {
  const t = useT();
  const section = useUiStore((state) => state.section);
  const item = NAV_ITEMS.find((entry) => entry.id === section);
  return item ? t(item.labelKey) : t('nav.dashboard');
}
