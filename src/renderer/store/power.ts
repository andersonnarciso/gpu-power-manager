/**
 * Power limit store.
 *
 * Keeps the driver reported bounds, the value the user is currently editing
 * and the result of the last application.
 */

import { create } from 'zustand';
import type { PowerLimitBounds } from '@shared/contracts';
import type { PowerLimitChangeResult, PowerLimitRequest } from '@shared/types';
import { getBridge } from '@renderer/lib/bridge';

export interface PowerState {
  bounds: Record<string, PowerLimitBounds>;
  drafts: Record<string, number>;
  applying: boolean;
  results: PowerLimitChangeResult[];
  loadBounds: (uuids: string[]) => Promise<void>;
  setDraft: (uuid: string, watts: number) => void;
  clearDraft: (uuid: string) => void;
  applyOne: (uuid: string, watts: number) => Promise<PowerLimitChangeResult>;
  applyMany: (requests: PowerLimitRequest[]) => Promise<PowerLimitChangeResult[]>;
  resetOne: (uuid: string) => Promise<PowerLimitChangeResult>;
  resetMany: (uuids: string[]) => Promise<PowerLimitChangeResult[]>;
  clearResults: () => void;
}

export const usePowerStore = create<PowerState>((set, get) => ({
  bounds: {},
  drafts: {},
  applying: false,
  results: [],

  loadBounds: async (uuids) => {
    const bridge = getBridge();
    const entries = await Promise.all(
      uuids.map(async (uuid) => {
        try {
          const bounds = await bridge.power.bounds(uuid);
          return [uuid, bounds] as const;
        } catch {
          return null;
        }
      }),
    );
    set((state) => {
      const bounds = { ...state.bounds };
      for (const entry of entries) {
        if (entry) bounds[entry[0]] = entry[1];
      }
      return { bounds };
    });
  },

  setDraft: (uuid, watts) =>
    set((state) => ({ drafts: { ...state.drafts, [uuid]: watts } })),

  clearDraft: (uuid) =>
    set((state) => {
      const drafts = { ...state.drafts };
      delete drafts[uuid];
      return { drafts };
    }),

  applyOne: async (uuid, watts) => {
    set({ applying: true });
    try {
      const result = await getBridge().power.apply(uuid, watts);
      set((state) => ({ results: [...state.results, result] }));
      return result;
    } finally {
      set({ applying: false });
    }
  },

  applyMany: async (requests) => {
    set({ applying: true });
    try {
      const results = await getBridge().power.applyMany(requests);
      set((state) => ({ results: [...state.results, ...results] }));
      return results;
    } finally {
      set({ applying: false });
    }
  },

  resetOne: async (uuid) => {
    set({ applying: true });
    try {
      const result = await getBridge().power.reset(uuid);
      set((state) => ({ results: [...state.results, result] }));
      return result;
    } finally {
      set({ applying: false });
    }
  },

  resetMany: async (uuids) => {
    set({ applying: true });
    try {
      const results = await getBridge().power.resetMany(uuids);
      set((state) => ({ results: [...state.results, ...results] }));
      return results;
    } finally {
      set({ applying: false });
    }
  },

  clearResults: () => set({ results: [] }),
}));
