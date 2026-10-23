import { create } from "zustand";
import { API_BASE_URL } from "../config/api";
import { getUserId } from "../config/user";
export interface ReceiptPick {
  productIndex: number;
  storeProductId: number;
  productId: number;
  storeProductName: string;
  imageUrl: string | null;
  amount: number | null;
  unit: string | null;
  priceVerified?: boolean;
}

interface ReceiptPickerState {
  pendingPick: ReceiptPick | null;
  setPendingPick: (pick: ReceiptPick) => void;
  clearPendingPick: () => void;
}

interface BasketState {
  /** Non-null only when the current session basket is in 'draft' status. */
  draftBasketId: number | null;
  /**
   * Tracks the active basket for the whole app session regardless of its
   * status (draft or compared). Set automatically whenever draftBasketId
   * is set to a non-null value. Only cleared explicitly via clearSessionBasket
   * (user action) or when the basket is deleted.
   */
  sessionBasketId: number | null;
  setDraftBasketId: (id: number | null) => void;
  clearSessionBasket: () => void;
  initDraftBasket: () => Promise<void>;
}

export const useBasketState = create<BasketState>((set) => ({
  draftBasketId: null,
  sessionBasketId: null,

  setDraftBasketId: (id) =>
    set((state) => ({
      draftBasketId: id,
      // When a draft basket is set, it becomes the session basket.
      // When cleared (basket compared/calc run), session basket stays —
      // the bar remains visible until the user explicitly discards.
      sessionBasketId: id !== null ? id : state.sessionBasketId,
    })),

  clearSessionBasket: () => {
    set({ draftBasketId: null, sessionBasketId: null });
    // The basket session lives in a SEPARATE store — clear its target too, or a
    // graduated/deleted basket keeps driving catalog steppers + the session
    // sheet. (Lazy require avoids an import cycle.)
    try { require('./basketSession').useBasketSession.getState().clearTarget(); } catch {}
  },

  initDraftBasket: async () => {
    try {
      const userId = await getUserId();
      const res = await fetch(`${API_BASE_URL}/api/baskets/user/${userId}`);
      const baskets = await res.json();
      const draft = Array.isArray(baskets)
        // householdId filter: the family SHARED basket is draft-status but
        // must never become the implicit personal target.
        ? baskets.find((b: any) => b.status === "draft" && b.householdId == null)
        : null;
      if (draft) {
        set({ draftBasketId: draft.id, sessionBasketId: draft.id });
      } else {
        set({ draftBasketId: null });
        // sessionBasketId intentionally not cleared — if a session basket
        // exists but is now 'compared', the bar should still show.
      }
    } catch {
      set({ draftBasketId: null });
    }
  },
}));

export const useReceiptPickerState = create<ReceiptPickerState>((set) => ({
  pendingPick: null,
  setPendingPick: (pick) => set({ pendingPick: pick }),
  clearPendingPick: () => set({ pendingPick: null }),
}));

export interface ReceiptCreateContext {
  receiptId: number;
  storeId: number;
  chainId: number;
  receiptDate: string | null;
  ocrName: string;
  ocrPrice: number;
  ocrPromoPrice: number | null;
  ocrQuantity: number;
  ocrUnit: string | null;
  ocrIsWeighable: boolean;
}

interface ReceiptCreateContextState {
  context: ReceiptCreateContext | null;
  setContext: (ctx: ReceiptCreateContext | null) => void;
  clearContext: () => void;
}

export const useReceiptCreateContext = create<ReceiptCreateContextState>(
  (set) => ({
    context: null,
    setContext: (ctx) => set({ context: ctx }),
    clearContext: () => set({ context: null }),
  }),
);
