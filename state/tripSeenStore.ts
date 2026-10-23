import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

const STORAGE_KEY = 'trip_seen_v1';

/**
 * Tracks which trip cards the user has OPENED, as a per-trip receipt-count
 * watermark: `seen[tripId]` = the receiptCount the card had the last time it was
 * opened. A card is "New" (pink + badge) when its CURRENT receiptCount exceeds
 * that watermark — so a first upload flags it, opening clears it, and a SECOND
 * receipt re-flags it. Persisted, so "New" survives an app restart until opened.
 */
interface TripSeenState {
  seen: Record<number, number>;
  initialized: boolean;
  initialize: () => Promise<void>;
  /** Mark a trip opened at its current receiptCount (clears its New state). */
  markOpened: (tripId: number, receiptCount: number) => void;
}

export const useTripSeenStore = create<TripSeenState>((set, get) => ({
  seen: {},
  initialized: false,

  initialize: async () => {
    if (get().initialized) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const seen = raw ? JSON.parse(raw) : {};
      set({ seen: seen && typeof seen === 'object' ? seen : {}, initialized: true });
    } catch {
      set({ initialized: true });
    }
  },

  markOpened: (tripId, receiptCount) => {
    set((s) => {
      if ((s.seen[tripId] ?? 0) >= receiptCount) return {}; // already caught up
      const seen = { ...s.seen, [tripId]: receiptCount };
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(seen)).catch(() => {});
      return { seen };
    });
  },
}));

/** A trip is New when it has a receipt the user hasn't opened yet. */
export const isTripNew = (
  seen: Record<number, number>,
  tripId: number,
  receiptCount: number,
): boolean => receiptCount > 0 && receiptCount > (seen[tripId] ?? 0);
