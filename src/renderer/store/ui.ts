/**
 * UI store: navigation, sidebar state and toasts.
 */

import { create } from 'zustand';

export type SectionId =
  | 'dashboard'
  | 'gpus'
  | 'powerLimit'
  | 'profiles'
  | 'benchmark'
  | 'optimizer'
  | 'processes'
  | 'history'
  | 'settings';

export type ToastVariant = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
}

export interface UiState {
  section: SectionId;
  sidebarCollapsed: boolean;
  toasts: Toast[];
  setSection: (section: SectionId) => void;
  toggleSidebar: () => void;
  pushToast: (toast: Omit<Toast, 'id'>) => string;
  dismissToast: (id: string) => void;
}

let toastCounter = 0;

export const useUiStore = create<UiState>((set) => ({
  section: 'dashboard',
  sidebarCollapsed: false,
  toasts: [],

  setSection: (section) => set({ section }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  pushToast: (toast) => {
    toastCounter += 1;
    const id = `toast-${toastCounter}`;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    return id;
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));
