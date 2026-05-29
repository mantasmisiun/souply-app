import { create } from 'zustand';
import {
    addTemplateItem,
    deleteTemplateItem,
    getTemplate,
    patchTemplateItem,
} from '../utils/basketTemplatesApi';

/**
 * Cross-screen state for the "Pridėti į šabloną" flow (template-add
 * categories → /browse/[categoryId] → /product/[id] → /search). Holds a
 * snapshot of the template's current items so every screen knows which
 * products are already in the template and what quantity they hold —
 * without each one re-fetching the template detail on every render.
 *
 * Hydrated once when the user enters the flow (template-add route). All
 * downstream mutations route through `add` / `setQuantity` / `remove`
 * so the store stays in sync with the server.
 *
 * NOT used by the template editor itself (that screen owns its own
 * `template` state via `getTemplate`); this store is purely the add-flow's
 * lightweight overlay.
 */
export interface TemplateAddItem {
    itemId: number;
    productId: number;
    quantity: number;
}

interface State {
    templateId: number | null;
    items: TemplateAddItem[];
    loaded: boolean;
    /** Idempotent — bails out if the same templateId is already loaded. */
    hydrate: (templateId: number) => Promise<void>;
    /** Adds new or, if the product is already in the template, increments
     *  the existing row's quantity by `quantity`. Returns the resulting
     *  quantity so callers can echo it (e.g. toast "kg added"). */
    add: (productId: number, quantity: number) => Promise<number>;
    /** Sets the absolute quantity; ≤ 0 deletes the row. */
    setQuantity: (productId: number, quantity: number) => Promise<void>;
    remove: (productId: number) => Promise<void>;
    /** Called on full flow dismissal so re-entry with a different
     *  templateId triggers a fresh hydrate. */
    clear: () => void;
}

export const useTemplateAddState = create<State>((set, get) => ({
    templateId: null,
    items: [],
    loaded: false,

    hydrate: async (templateId) => {
        if (get().templateId === templateId && get().loaded) return;
        set({ templateId, items: [], loaded: false });
        try {
            const data = await getTemplate(templateId);
            set({
                items: data.items.map(it => ({
                    itemId: it.id,
                    productId: it.productId,
                    quantity: Number(it.quantity),
                })),
                loaded: true,
            });
        } catch {
            set({ loaded: true });
        }
    },

    add: async (productId, quantity) => {
        const tid = get().templateId;
        if (tid == null) return quantity;
        const existing = get().items.find(i => i.productId === productId);
        if (existing) {
            const next = existing.quantity + quantity;
            await patchTemplateItem(tid, existing.itemId, { quantity: next });
            set(s => ({
                items: s.items.map(i =>
                    i.productId === productId ? { ...i, quantity: next } : i,
                ),
            }));
            return next;
        }
        const result = await addTemplateItem(tid, { productId, quantity });
        set(s => ({
            items: [
                ...s.items,
                { itemId: result.id, productId, quantity },
            ],
        }));
        return quantity;
    },

    setQuantity: async (productId, quantity) => {
        const tid = get().templateId;
        if (tid == null) return;
        const existing = get().items.find(i => i.productId === productId);
        if (!existing) return;
        if (quantity <= 0) {
            await deleteTemplateItem(tid, existing.itemId);
            set(s => ({ items: s.items.filter(i => i.productId !== productId) }));
            return;
        }
        await patchTemplateItem(tid, existing.itemId, { quantity });
        set(s => ({
            items: s.items.map(i =>
                i.productId === productId ? { ...i, quantity } : i,
            ),
        }));
    },

    remove: async (productId) => {
        const tid = get().templateId;
        if (tid == null) return;
        const existing = get().items.find(i => i.productId === productId);
        if (!existing) return;
        await deleteTemplateItem(tid, existing.itemId);
        set(s => ({ items: s.items.filter(i => i.productId !== productId) }));
    },

    clear: () => set({ templateId: null, items: [], loaded: false }),
}));
