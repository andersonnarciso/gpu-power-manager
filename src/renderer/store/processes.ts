/**
 * Process store.
 *
 * Read-only view of the processes using the GPU.
 */

import { create } from 'zustand';
import type { GpuProcess } from '@shared/types';
import { getBridge } from '@renderer/lib/bridge';

export interface ProcessesState {
  processes: GpuProcess[];
  loading: boolean;
  load: () => Promise<void>;
}

export const useProcessesStore = create<ProcessesState>((set) => ({
  processes: [],
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const processes = await getBridge().processes.list();
      set({ processes, loading: false });
    } finally {
      set({ loading: false });
    }
  },
}));
