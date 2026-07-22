import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";

const STORAGE_KEY = "receipt_queue_v1";

export type QueueStatus =
  | "pending"
  | "processing"
  | "error"
  | "awaiting_network";

export interface QueueItem {
  id: string;
  uris: string[];
  /** True when uris[0] is a PDF still awaiting page conversion (done as the
   *  item's first processing stage). */
  isPdf?: boolean;
  /** Original filename for display in error/awaiting cards. */
  name?: string;
  /** Trip/list linking (background scan/upload from a shopping list): the
   *  detected chain's list is linked after the receipt is created. `linkMap`
   *  is chainId→listId; `fallbackLinkId` links a single-store list whose chain
   *  we can't gate on. Mirrors the interactive scan-session link logic. */
  linkMap?: Record<number, number>;
  fallbackLinkId?: number | null;
  status: QueueStatus;
  error?: string;
  /** Human-readable progress line ("Nuskaitoma...", "3/8 prekės", "Išsaugoma..."). */
  progress?: string;
  /** When the progress is "matching products", how many done. Drives the bottom bar. */
  progressDone?: number;
  progressTotal?: number;
  addedAt: number;
}

interface ReceiptQueueState {
  items: QueueItem[];
  /**
   * Server receipt IDs that finished processing in the current app session.
   * Drives the "Nauji" section and the pending-swipes banner. Cleared on
   * app restart and once all listed receipts have completed mandatory swipes.
   */
  recentIds: number[];
  lastCompletedAt: number | null;
  initialized: boolean;

  initialize: () => Promise<void>;
  addItems: (entries: {
    uris: string[];
    name?: string;
    isPdf?: boolean;
    linkMap?: Record<number, number>;
    fallbackLinkId?: number | null;
  }[]) => void;
  markProcessing: (id: string, progress?: string) => void;
  updateProgress: (
    id: string,
    progress: string,
    done?: number,
    total?: number,
  ) => void;
  markAwaitingNetwork: (id: string) => void;
  resumeAwaitingNetwork: () => void;
  markDone: (id: string, receiptId: number) => void;
  noteReceiptCreated: (receiptId: number) => void;
  markError: (id: string, error: string) => void;
  removeItem: (id: string) => void;
  pruneRecentIds: (idsToKeep: number[]) => void;
}

function genId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function persist(items: QueueItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch (e) {
    console.warn("[receiptQueue] persist failed:", e);
  }
}

export const useReceiptQueueStore = create<ReceiptQueueState>((set, get) => ({
  items: [],
  recentIds: [],
  lastCompletedAt: null,
  initialized: false,

  initialize: async () => {
    if (get().initialized) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const saved: QueueItem[] = raw ? JSON.parse(raw) : [];
      // Items that were mid-processing when the app was killed get reset
      // to pending so the runner picks them up. `awaiting_network` stays
      // — the network resumer flips it back when connectivity returns.
      const restored = saved.map((item) =>
        item.status === "processing"
          ? { ...item, status: "pending" as const, progress: undefined, progressDone: undefined, progressTotal: undefined }
          : item,
      );
      set({ items: restored, initialized: true });
    } catch (e) {
      console.warn("[receiptQueue] load failed:", e);
      set({ initialized: true });
    }
  },

  addItems: (entries) => {
    const newItems: QueueItem[] = entries.map((e) => ({
      id: genId(),
      uris: e.uris,
      isPdf: e.isPdf,
      name: e.name,
      linkMap: e.linkMap,
      fallbackLinkId: e.fallbackLinkId,
      status: "pending",
      addedAt: Date.now(),
    }));
    set((state) => {
      const items = [...state.items, ...newItems];
      persist(items);
      return { items };
    });
  },

  markProcessing: (id, progress) => {
    set((state) => {
      const items = state.items.map((item) =>
        item.id === id
          ? {
              ...item,
              status: "processing" as const,
              progress,
              progressDone: undefined,
              progressTotal: undefined,
            }
          : item,
      );
      persist(items);
      return { items };
    });
  },

  updateProgress: (id, progress, done, total) => {
    // Progress updates are high-frequency; skip the AsyncStorage write
    // to avoid hammering the disk during product matching.
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id
          ? { ...item, progress, progressDone: done, progressTotal: total }
          : item,
      ),
    }));
  },

  markAwaitingNetwork: (id) => {
    set((state) => {
      const items = state.items.map((item) =>
        item.id === id
          ? {
              ...item,
              status: "awaiting_network" as const,
              progress: undefined,
              progressDone: undefined,
              progressTotal: undefined,
            }
          : item,
      );
      persist(items);
      return { items };
    });
  },

  resumeAwaitingNetwork: () => {
    set((state) => {
      let changed = false;
      const items = state.items.map((item) => {
        if (item.status === "awaiting_network") {
          changed = true;
          return { ...item, status: "pending" as const };
        }
        return item;
      });
      if (!changed) return {};
      persist(items);
      return { items };
    });
  },

  markDone: (id, receiptId) => {
    set((state) => {
      const items = state.items.filter((item) => item.id !== id);
      const recentIds = state.recentIds.includes(receiptId)
        ? state.recentIds
        : [...state.recentIds, receiptId];
      persist(items);
      return { items, lastCompletedAt: Date.now(), recentIds };
    });
  },

  // A fresh camera scan is created directly by receipt-process, which never goes through
  // the batch queue runner (the only caller of markDone). Without this, a scanned receipt
  // would never enter recentIds nor bump lastCompletedAt — so it wouldn't appear in the
  // "Nauji" section and the Analyze list wouldn't refetch until the tab next regains focus.
  // This gives the scan path the same store signal the batch-upload path already emits.
  // No `persist` — it touches only in-memory session state (items are unchanged).
  noteReceiptCreated: (receiptId) => {
    set((state) => ({
      lastCompletedAt: Date.now(),
      recentIds: state.recentIds.includes(receiptId)
        ? state.recentIds
        : [...state.recentIds, receiptId],
    }));
  },

  markError: (id, error) => {
    set((state) => {
      const items = state.items.map((item) =>
        item.id === id
          ? {
              ...item,
              status: "error" as const,
              error,
              progress: undefined,
              progressDone: undefined,
              progressTotal: undefined,
            }
          : item,
      );
      persist(items);
      return { items };
    });
  },

  removeItem: (id) => {
    set((state) => {
      const items = state.items.filter((item) => item.id !== id);
      persist(items);
      return { items };
    });
  },

  pruneRecentIds: (idsToKeep) => {
    set((state) => {
      const next = state.recentIds.filter((id) => idsToKeep.includes(id));
      if (next.length === state.recentIds.length) return {};
      return { recentIds: next };
    });
  },
}));
