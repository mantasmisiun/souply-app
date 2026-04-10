import { create } from 'zustand';

interface CategorySelection {
    categoryId: number;
    categoryName: string;
    productName: string | null;
    itemIndex: number;
}

interface ReceiptEditStore {
    pendingSelection: CategorySelection | null;
    setPendingSelection: (selection: CategorySelection | null) => void;
}

export const useReceiptEditStore = create<ReceiptEditStore>((set) => ({
    pendingSelection: null,
    setPendingSelection: (selection) => set({ pendingSelection: selection }),
}));