/**
 * Application store: version, driver state and simulation flag.
 */

import { create } from 'zustand';
import type { AppInfo } from '@shared/types';
import { getBridge, isMockBridge } from '@renderer/lib/bridge';

export interface AppState {
  info: AppInfo | null;
  simulated: boolean;
  load: () => Promise<void>;
}

export const useAppStore = create<AppState>((set) => ({
  info: null,
  simulated: isMockBridge(),

  load: async () => {
    try {
      const info = await getBridge().app.info();
      set({ info, simulated: info.simulated || isMockBridge() });
    } catch {
      set({ simulated: isMockBridge() });
    }
  },
}));
