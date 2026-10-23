import { create } from 'zustand';
import { API_BASE_URL } from '../config/api';
import { useBasketSession } from './basketSession';
import { useBasketState } from './basketState';

/**
 * THE owner of "how much of this product is in the current basket".
 *
 * Every catalog surface (cards, search, discounts, product detail) reads this
 * ONE map, and every ± / Add writes through it.
 *
 * WHY IT EXISTS. Each screen used to hold its own copy, mutate it optimistically
 * and then get flattened by `useBasketQuantities`' unconditional refetch: any
 * add bumps basketRev, the refetch replaces the whole map, and a refresh that
 * started BEFORE your tap lands AFTER it — so a 2 reverted to 1 while the server
 * quietly stored 2, and the next unrelated refresh made it jump to 3. Three
 * rules kill that class of bug:
 *
 *   1. LOCAL WINS WHILE IN FLIGHT. A write is recorded in `pending` with a
 *      monotonic seq; a refresh MERGES server truth under the pending entries
 *      instead of replacing them. A stale response can no longer overwrite a
 *      newer local intent.
 *   2. LAST WRITE WINS, BY SEQ. A response only clears its pending entry when
 *      it is still the newest write for that product; anything superseded is
 *      dropped on arrival (and its request aborted).
 *   3. ONE WRITE PER BURST. Taps coalesce per product over WRITE_DEBOUNCE_MS and
 *      send the FINAL value once, instead of racing a request per tap.
 *
 * The UI never waits on the network: `commit` paints immediately and only rolls
 * back if the server refuses.
 */

const WRITE_DEBOUNCE_MS = 200;

interface PendingWrite {
    /** The quantity the user last asked for. */
    qty: number;
    /** Monotonic write id — decides which response is still authoritative. */
    seq: number;
}

interface BasketQuantitiesState {
    /** The basket these quantities belong to (null = no active target). */
    basketId: number | null;
    /** What the UI shows: server truth with pending local writes layered on top. */
    quantities: Record<number, number>;
    /** Last known server truth, kept separately so a rollback has a target. */
    server: Record<number, number>;
    pending: Record<number, PendingWrite>;
    seq: number;

    setBasket: (basketId: number | null) => void;
    /** Re-read the server map and merge it UNDER anything still pending. */
    refresh: () => Promise<void>;
    /** Set a product's quantity: paints now, writes (debounced) after. */
    commit: (productId: number, qty: number) => void;
    /** Adopt a quantity that some other path already persisted (e.g. a fresh
     *  add through the session/chooser flow). No write is scheduled. */
    adopt: (productId: number, qty: number) => void;
    /** Drop everything (basket switched / session cleared). */
    reset: () => void;
}

/** Per-product debounce timers + in-flight aborts, outside the store's state. */
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const inflight = new Map<number, AbortController>();

const merge = (server: Record<number, number>, pending: Record<number, PendingWrite>) => {
    const out: Record<number, number> = { ...server };
    for (const [pid, w] of Object.entries(pending)) out[Number(pid)] = w.qty;
    return out;
};

export const useBasketQuantitiesStore = create<BasketQuantitiesState>((set, get) => ({
    basketId: null,
    quantities: {},
    server: {},
    pending: {},
    seq: 0,

    setBasket: (basketId) => {
        if (get().basketId === basketId) return;
        // A different basket invalidates everything, including writes aimed at
        // the old one — cancel them rather than letting them land somewhere else.
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
        for (const c of inflight.values()) c.abort();
        inflight.clear();
        set({ basketId, quantities: {}, server: {}, pending: {} });
        if (basketId != null) void get().refresh();
    },

    refresh: async () => {
        const { basketId } = get();
        if (basketId == null) { set({ quantities: {}, server: {}, pending: {} }); return; }
        try {
            const res = await fetch(`${API_BASE_URL}/api/baskets/${basketId}/quantities`);
            if (!res.ok) return;
            const raw = await res.json();
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
            // The basket may have changed while this was in flight.
            if (get().basketId !== basketId) return;
            const server: Record<number, number> = {};
            for (const [pid, qty] of Object.entries(raw)) {
                // Ignore anything that isn't a productId → quantity pair, so a
                // wrong-shaped body (an error envelope, a changed endpoint) can
                // never poison the map with NaN keys.
                const id = Number(pid);
                const q = Number(qty);
                if (Number.isFinite(id) && Number.isFinite(q)) server[id] = q;
            }
            const pending = get().pending;
            set({ server, quantities: merge(server, pending) });
        } catch { /* offline / aborted — keep showing what we have */ }
    },

    commit: (productId, qty) => {
        const next = Math.max(0, qty);
        const seq = get().seq + 1;
        const pending = { ...get().pending, [productId]: { qty: next, seq } };
        // 1. Paint immediately — the stepper never waits for the network.
        set({ seq, pending, quantities: { ...get().quantities, [productId]: next } });

        // 2. Coalesce a burst of taps into one write of the final value.
        const existing = timers.get(productId);
        if (existing) clearTimeout(existing);
        timers.set(productId, setTimeout(() => { void flush(productId, set, get); }, WRITE_DEBOUNCE_MS));
    },

    adopt: (productId, qty) => {
        const next = Math.max(0, qty);
        const server = { ...get().server, [productId]: next };
        const pending = { ...get().pending };
        delete pending[productId];
        set({ server, pending, quantities: merge(server, pending) });
    },

    reset: () => {
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
        for (const c of inflight.values()) c.abort();
        inflight.clear();
        set({ basketId: null, quantities: {}, server: {}, pending: {} });
    },
}));

/** Send the newest pending value for one product. */
async function flush(
    productId: number,
    set: (partial: Partial<BasketQuantitiesState>) => void,
    get: () => BasketQuantitiesState,
): Promise<void> {
    timers.delete(productId);
    const { basketId, pending } = get();
    const write = pending[productId];
    if (basketId == null || !write) return;

    // Supersede any write of this product still on the wire.
    inflight.get(productId)?.abort();
    const controller = new AbortController();
    inflight.set(productId, controller);

    let ok = false;
    let remaining: number | null = null;
    try {
        const res = await fetch(`${API_BASE_URL}/api/baskets/${basketId}/items/by-product/${productId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quantity: write.qty }),
            signal: controller.signal,
        });
        ok = res.ok;
        if (ok) {
            const body = await res.json().catch(() => null);
            remaining = typeof body?.remaining === 'number' ? body.remaining : null;
        }
    } catch {
        // Aborted (superseded) or offline. An abort must NOT roll back — a newer
        // write for this product is already scheduled and owns the value.
        if (controller.signal.aborted) return;
    } finally {
        if (inflight.get(productId) === controller) inflight.delete(productId);
    }

    const current = get().pending[productId];
    // A newer tap arrived while this was in flight — it owns the outcome.
    if (!current || current.seq !== write.seq) return;

    const nextPending = { ...get().pending };
    delete nextPending[productId];

    if (ok) {
        const server = { ...get().server };
        if (write.qty > 0) server[productId] = write.qty; else delete server[productId];
        set({ server, pending: nextPending, quantities: merge(server, nextPending) });
        // Keep the dock / basket sheet in step with the write.
        useBasketSession.getState().bumpBasketRev();
        // The last line just left — tear the empty basket down and end the
        // session, the behaviour each screen used to hand-roll after its own
        // GET/DELETE pair.
        if (remaining === 0) void teardownEmptyBasket(basketId);
    } else {
        // Refused (e.g. an inProgress basket) — fall back to server truth so the
        // card can't keep showing a quantity the basket doesn't have.
        set({ pending: nextPending, quantities: merge(get().server, nextPending) });
        useBasketSession.getState().setAddNotice('basketSession.addFailed');
    }
}

/** Delete a basket that just lost its last item and end the session with it. */
async function teardownEmptyBasket(basketId: number): Promise<void> {
    try {
        await fetch(`${API_BASE_URL}/api/baskets/${basketId}`, { method: 'DELETE' });
    } catch { /* the line is already gone; a stray empty basket is harmless */ }
    useBasketState.getState().clearSessionBasket();
    useBasketQuantitiesStore.getState().reset();
}

/** Test seam: pending timers/aborts live outside the store. */
export const __resetBasketQuantityTimers = () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    inflight.clear();
};
