import { create } from 'zustand';

interface BasketState {
    draftBasketId: number | null;
    setDraftBasketId: (id: number | null) => void;
}

export const useBasketState = create<BasketState>((set) => ({
    draftBasketId: null,
    setDraftBasketId: (id) => set({ draftBasketId: id }),
}));