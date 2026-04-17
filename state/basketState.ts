import { create } from 'zustand';
import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';

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