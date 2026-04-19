import { create } from 'zustand';
import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';
export interface ReceiptPick {
    productIndex: number;
    storeProductId: number;
    productId: number;
    storeProductName: string;
    imageUrl: string | null;
    amount: number | null;
    unit: string | null;
}

interface ReceiptPickerState {
    pendingPick: ReceiptPick | null;
    setPendingPick: (pick: ReceiptPick) => void;
    clearPendingPick: () => void;
}

interface BasketState {
    draftBasketId: number | null;
    setDraftBasketId: (id: number | null) => void;
    initDraftBasket: () => Promise<void>;
}

export const useBasketState = create<BasketState>((set) => ({
    draftBasketId: null,
    setDraftBasketId: (id) => set({ draftBasketId: id }),
    initDraftBasket: async () => {
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/baskets/user/${userId}`);
            const baskets = await res.json();
            const draft = Array.isArray(baskets) ? baskets.find((b: any) => b.status === 'draft') : null;
            set({ draftBasketId: draft ? draft.id : null });
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