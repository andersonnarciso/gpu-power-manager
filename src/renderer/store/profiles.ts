/**
 * Profile store.
 *
 * Full CRUD over the profile collection exposed by the backend, plus
 * activation and restore of the factory defaults.
 */

import { create } from 'zustand';
import type { OperationResult, PowerLimitChangeResult, PowerProfile } from '@shared/types';
import { getBridge } from '@renderer/lib/bridge';

export interface ProfilesState {
  profiles: PowerProfile[];
  activeProfileId: string | null;
  loading: boolean;
  load: () => Promise<PowerProfile[]>;
  save: (profile: PowerProfile) => Promise<PowerProfile>;
  remove: (id: string) => Promise<OperationResult>;
  activate: (id: string) => Promise<PowerLimitChangeResult[]>;
  resetDefaults: () => Promise<PowerLimitChangeResult[]>;
  setActive: (id: string | null) => void;
}

export const useProfilesStore = create<ProfilesState>((set, get) => ({
  profiles: [],
  activeProfileId: null,
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const profiles = await getBridge().profiles.list();
      set({ profiles, loading: false });
      return profiles;
    } catch {
      set({ profiles: [], loading: false });
      return [];
    }
  },

  save: async (profile) => {
    const saved = await getBridge().profiles.save(profile);
    await get().load();
    return saved;
  },

  remove: async (id) => {
    const result = await getBridge().profiles.remove(id);
    await get().load();
    return result;
  },

  activate: async (id) => {
    const results = await getBridge().profiles.activate(id);
    set({ activeProfileId: id });
    return results;
  },

  resetDefaults: async () => {
    const results = await getBridge().profiles.resetDefaults();
    set({ activeProfileId: 'builtin-original' });
    return results;
  },

  setActive: (id) => set({ activeProfileId: id }),
}));
