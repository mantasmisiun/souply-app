import {
    capVoluntaryQueue,
    capMandatoryQueue,
    composeVoluntaryReceiptDeck,
    type CapCardLike,
} from '../utils/swipeQueueCap';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TestCard = CapCardLike;

const card = (cardId: string, slot: 1 | 2 | 3): TestCard => ({ cardId, slot });

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const makeReceiptCards = (counts: { s1?: number; s2?: number; s3?: number }, prefix = 'r') => [
    ...range(counts.s1 ?? 0).map((i) => card(`${prefix}-s1-${i}`, 1)),
    ...range(counts.s2 ?? 0).map((i) => card(`${prefix}-s2-${i}`, 2)),
    ...range(counts.s3 ?? 0).map((i) => card(`${prefix}-s3-${i}`, 3)),
];

const makeGlobalCards = (counts: { s1?: number; s2?: number; s3?: number }) =>
    makeReceiptCards(counts, 'g');

const slotCount = (cards: { slot: number }[], slot: number) =>
    cards.filter((c) => c.slot === slot).length;

const fromGlobalCount = (cards: { fromGlobalFill: boolean }[]) =>
    cards.filter((c) => c.fromGlobalFill).length;

// ---------------------------------------------------------------------------
// Voluntary mode — happy paths
// ---------------------------------------------------------------------------

describe('capVoluntaryQueue — canonical 3-per-slot + 1 global', () => {
    it('returns 9 receipt + 1 global when both pools are plentiful', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: makeReceiptCards({ s1: 5, s2: 5, s3: 5 }),
            globalItems: makeGlobalCards({ s1: 5, s2: 5, s3: 5 }),
        });
        expect(items).toHaveLength(10);
        expect(fromGlobalCount(items)).toBe(1);
        expect(items.filter((c) => !c.fromGlobalFill)).toHaveLength(9);
    });

    it('puts the global card at the very end (last position)', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: makeReceiptCards({ s1: 5, s2: 5, s3: 5 }),
            globalItems: makeGlobalCards({ s1: 5, s2: 5, s3: 5 }),
        });
        expect(items[9].fromGlobalFill).toBe(true);
        // Every preceding card is receipt-anchored
        for (let i = 0; i < 9; i++) {
            expect(items[i].fromGlobalFill).toBe(false);
        }
    });

    it('takes exactly 3 per slot when the receipt has enough', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: makeReceiptCards({ s1: 5, s2: 5, s3: 5 }),
            globalItems: makeGlobalCards({ s1: 5, s2: 5, s3: 5 }),
        });
        const receipt = items.filter((c) => !c.fromGlobalFill);
        expect(slotCount(receipt, 2)).toBe(3);
        expect(slotCount(receipt, 1)).toBe(3);
        expect(slotCount(receipt, 3)).toBe(3);
    });

    it('global card respects slot priority (slot 2 first when available)', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: makeReceiptCards({ s1: 5, s2: 5, s3: 5 }),
            globalItems: makeGlobalCards({ s1: 5, s2: 5, s3: 5 }),
        });
        const globals = items.filter((c) => c.fromGlobalFill);
        expect(globals).toHaveLength(1);
        expect(globals[0].slot).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// Voluntary mode — slot redistribution
// ---------------------------------------------------------------------------

describe('capVoluntaryQueue — redistribution within receipt budget', () => {
    it('redistributes to slot 2 when slot 1 and 3 are empty', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: makeReceiptCards({ s2: 20 }),
            globalItems: makeGlobalCards({ s1: 5 }),
        });
        const receipt = items.filter((c) => !c.fromGlobalFill);
        expect(receipt).toHaveLength(9);
        expect(slotCount(receipt, 2)).toBe(9);
        expect(fromGlobalCount(items)).toBe(1);
    });

    it('caps redistribution at the receipt budget of 9', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: makeReceiptCards({ s2: 100 }),
            globalItems: makeGlobalCards({ s2: 100 }),
        });
        expect(items).toHaveLength(10);
        expect(items.filter((c) => !c.fromGlobalFill)).toHaveLength(9);
        expect(fromGlobalCount(items)).toBe(1);
    });

    it('fills mixed slots in priority order during redistribution', () => {
        // Phase A takes 0 s1, 3 s2, 0 s3 = 3. Budget remaining = 6.
        // Phase B redistributes — slot 1 has 5, slot 3 has 5, slot 2 has 7 left.
        // Round-robin in priority order: s2, s1, s3, s2, s1, s3 = 6 more.
        const { items } = capVoluntaryQueue({
            receiptItems: makeReceiptCards({ s1: 5, s2: 10, s3: 5 }),
            globalItems: makeGlobalCards({ s2: 5 }),
        });
        const receipt = items.filter((c) => !c.fromGlobalFill);
        expect(receipt).toHaveLength(9);
        // Originally took 3 of each in Phase A, then round-robin redistributes
        // the remaining 0 budget — but slot 2 still has more cards. Verify
        // slot 2 doesn't grow beyond 3 unless slot 1/3 are exhausted (they
        // aren't here at the time of redistribution since they had only 5
        // each in Phase A, leaving 2 each).
        // Phase A: s2=3, s1=3, s3=3 = 9. Budget reached. Phase B never fires.
        expect(slotCount(receipt, 2)).toBe(3);
        expect(slotCount(receipt, 1)).toBe(3);
        expect(slotCount(receipt, 3)).toBe(3);
    });

    it('redistribution prefers slot 2 when only slots 1+2 have cards', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: makeReceiptCards({ s1: 3, s2: 20 }),
            globalItems: makeGlobalCards({ s1: 3 }),
        });
        const receipt = items.filter((c) => !c.fromGlobalFill);
        expect(receipt).toHaveLength(9);
        // Phase A: 3 s2, 3 s1, 0 s3 = 6. Budget remaining = 3.
        // Phase B round-robin: s2 → s1 (empty) → s3 (empty) → s2 → s2 → s2.
        // Slot 1 exhausted after Phase A, so all 3 extra come from slot 2.
        expect(slotCount(receipt, 1)).toBe(3);
        expect(slotCount(receipt, 2)).toBe(6);
        expect(slotCount(receipt, 3)).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Voluntary mode — short receipt → global fills the gap
// ---------------------------------------------------------------------------

describe('capVoluntaryQueue — short receipt, global fills the gap', () => {
    it('fills 5 receipt + 5 global when receipt has 5 cards', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: makeReceiptCards({ s2: 5 }),
            globalItems: makeGlobalCards({ s1: 10, s2: 10, s3: 10 }),
        });
        expect(items).toHaveLength(10);
        expect(items.filter((c) => !c.fromGlobalFill)).toHaveLength(5);
        expect(fromGlobalCount(items)).toBe(5);
    });

    it('all global when receipt is empty', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: [],
            globalItems: makeGlobalCards({ s1: 10, s2: 10, s3: 10 }),
        });
        expect(items).toHaveLength(10);
        expect(fromGlobalCount(items)).toBe(10);
        // Global takes priority order too: 3 s2, then 3 s1, then 3 s3, then round-robin
        expect(slotCount(items, 2)).toBeGreaterThanOrEqual(3);
        expect(slotCount(items, 1)).toBeGreaterThanOrEqual(3);
        expect(slotCount(items, 3)).toBeGreaterThanOrEqual(3);
    });

    it('global fill keeps slot priority (s2 → s1 → s3)', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: [],
            globalItems: makeGlobalCards({ s1: 1, s2: 1, s3: 1 }),
        });
        const globals = items.filter((c) => c.fromGlobalFill);
        expect(globals).toHaveLength(3);
        expect(globals[0].slot).toBe(2);
        expect(globals[1].slot).toBe(1);
        expect(globals[2].slot).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// Voluntary mode — global empty edge cases
// ---------------------------------------------------------------------------

describe('capVoluntaryQueue — global pool empty', () => {
    it('backfills receipt to 10 when global has zero cards (rule yields)', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: makeReceiptCards({ s2: 20 }),
            globalItems: [],
        });
        expect(items).toHaveLength(10);
        expect(fromGlobalCount(items)).toBe(0);
    });

    it('does NOT backfill when receipt is also short (returns < 10)', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: makeReceiptCards({ s2: 4 }),
            globalItems: [],
        });
        expect(items).toHaveLength(4);
        expect(fromGlobalCount(items)).toBe(0);
    });

    it('returns empty when both pools are empty', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: [],
            globalItems: [],
        });
        expect(items).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Voluntary mode — deduplication
// ---------------------------------------------------------------------------

describe('capVoluntaryQueue — dedupes by cardId', () => {
    it('does not double-count when same cardId appears in both pools', () => {
        const shared = card('shared-1', 2);
        const { items } = capVoluntaryQueue({
            receiptItems: [shared, ...makeReceiptCards({ s2: 4 })],
            globalItems: [shared, ...makeGlobalCards({ s2: 4 })],
        });
        // Shared card should appear once (as receipt, since receipt is consumed
        // first), then we should see receipt cards + global cards making up
        // the rest without re-including shared.
        const ids = items.map((c) => c.cardId);
        const uniqueIds = new Set(ids);
        expect(ids).toHaveLength(uniqueIds.size);
    });

    it('still hits the ≥1 global rule when receipt pool has overlapping cardIds', () => {
        const overlap = makeReceiptCards({ s2: 3 }, 'overlap');
        const { items } = capVoluntaryQueue({
            receiptItems: [...overlap, ...makeReceiptCards({ s2: 6 }, 'unique')],
            globalItems: [...overlap, ...makeGlobalCards({ s2: 5 })],
        });
        expect(items).toHaveLength(10);
        // global picks must come from cards NOT shared with receipt
        expect(fromGlobalCount(items)).toBe(1);
        const globalIds = items.filter((c) => c.fromGlobalFill).map((c) => c.cardId);
        // Overlap cards came in as receipt-anchored. Global card must be
        // unique to the global pool.
        for (const id of globalIds) {
            expect(id.startsWith('g-')).toBe(true);
        }
    });
});

// ---------------------------------------------------------------------------
// Voluntary mode — RECEIPT-SCOPED (relevance-only, no global fill)
// ---------------------------------------------------------------------------

describe('capVoluntaryQueue — receiptScoped kills the global fill', () => {
    it('never tags any card fromGlobalFill even with a plentiful global pool', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: makeReceiptCards({ s1: 5, s2: 5, s3: 5 }),
            globalItems: makeGlobalCards({ s1: 5, s2: 5, s3: 5 }),
            receiptScoped: true,
        });
        expect(items).toHaveLength(10);
        expect(fromGlobalCount(items)).toBe(0);
        // Every card is a receipt card, never a global one.
        for (const c of items) expect(c.cardId.startsWith('r-')).toBe(true);
    });

    it('fills all 10 from the receipt (no reserved global slot)', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: makeReceiptCards({ s2: 20 }),
            globalItems: makeGlobalCards({ s2: 20 }),
            receiptScoped: true,
        });
        expect(items).toHaveLength(10);
        expect(fromGlobalCount(items)).toBe(0);
        expect(slotCount(items, 2)).toBe(10);
    });

    it('returns an HONEST short deck when the receipt is short — never pads with globals', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: makeReceiptCards({ s2: 4 }),
            globalItems: makeGlobalCards({ s1: 10, s2: 10, s3: 10 }),
            receiptScoped: true,
        });
        expect(items).toHaveLength(4);
        expect(fromGlobalCount(items)).toBe(0);
    });

    it('preserves slot priority (2 → 1 → 3) within the receipt-only deck', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: makeReceiptCards({ s1: 1, s2: 1, s3: 1 }),
            globalItems: makeGlobalCards({ s1: 5, s2: 5, s3: 5 }),
            receiptScoped: true,
        });
        expect(items.map((c) => c.slot)).toEqual([2, 1, 3]);
        expect(fromGlobalCount(items)).toBe(0);
    });

    it('community path (receiptScoped=false) still gets a global card — unchanged', () => {
        const { items } = capVoluntaryQueue({
            receiptItems: makeReceiptCards({ s1: 5, s2: 5, s3: 5 }),
            globalItems: makeGlobalCards({ s1: 5, s2: 5, s3: 5 }),
        });
        expect(fromGlobalCount(items)).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// composeVoluntaryReceiptDeck — crops fill first up to the comfort cap
// ---------------------------------------------------------------------------

describe('composeVoluntaryReceiptDeck — crops ahead of slots, capped', () => {
    const crop = (i: number) => ({ cardId: `crop-${i}`, cardKind: 'receipt' as const });
    const crops = (n: number) => range(n).map(crop);

    it('places crops FIRST, then slot cards', () => {
        const deck = composeVoluntaryReceiptDeck(crops(2), makeReceiptCards({ s2: 5 }), 7);
        expect(deck.slice(0, 2).map((c) => c.cardId)).toEqual(['crop-0', 'crop-1']);
        expect(deck.slice(2).every((c) => c.cardId.startsWith('r-'))).toBe(true);
    });

    it('caps crops at the comfort cap and gives the rest to slot cards', () => {
        // 9 crops available but cap 7 → 7 crops + 3 slot cards = 10.
        const deck = composeVoluntaryReceiptDeck(crops(9), makeReceiptCards({ s2: 8 }), 7);
        expect(deck).toHaveLength(10);
        const cropCount = deck.filter((c) => (c as any).cardKind === 'receipt').length;
        expect(cropCount).toBe(7);
        expect(deck.length - cropCount).toBe(3);
    });

    it('when few crops, slot rescues take the remaining room (up to 10)', () => {
        const deck = composeVoluntaryReceiptDeck(crops(2), makeReceiptCards({ s2: 20 }), 7);
        expect(deck).toHaveLength(10);
        expect(deck.filter((c) => (c as any).cardKind === 'receipt')).toHaveLength(2);
    });

    it('never exceeds the 10-card cap', () => {
        const deck = composeVoluntaryReceiptDeck(crops(7), makeReceiptCards({ s2: 20 }), 7);
        expect(deck).toHaveLength(10);
    });

    it('no crops → the slot deck straight through (cap 10)', () => {
        const deck = composeVoluntaryReceiptDeck([], makeReceiptCards({ s2: 12 }), 7);
        expect(deck).toHaveLength(10);
        expect(deck.every((c) => c.cardId.startsWith('r-'))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Mandatory mode
// ---------------------------------------------------------------------------

describe('capMandatoryQueue — 3-card priority cap (unchanged behaviour)', () => {
    it('returns exactly 3 cards when plenty available', () => {
        const { items } = capMandatoryQueue({
            receiptItems: makeReceiptCards({ s1: 5, s2: 5, s3: 5 }),
        });
        expect(items).toHaveLength(3);
    });

    it('prioritises slot 2 first', () => {
        const { items } = capMandatoryQueue({
            receiptItems: makeReceiptCards({ s1: 5, s2: 5, s3: 5 }),
        });
        // Round-robin in priority order: s2, s1, s3 = 3 cards, one of each slot
        expect(slotCount(items, 2)).toBe(1);
        expect(slotCount(items, 1)).toBe(1);
        expect(slotCount(items, 3)).toBe(1);
    });

    it('fills from other slots when slot 2 is empty', () => {
        const { items } = capMandatoryQueue({
            receiptItems: makeReceiptCards({ s1: 5, s3: 5 }),
        });
        expect(items).toHaveLength(3);
        expect(slotCount(items, 2)).toBe(0);
    });

    it('returns fewer than 3 when the receipt has too few cards', () => {
        const { items } = capMandatoryQueue({
            receiptItems: makeReceiptCards({ s2: 1 }),
        });
        expect(items).toHaveLength(1);
    });

    it('never tags any card as fromGlobalFill (mandatory doesn\'t use globals)', () => {
        const { items } = capMandatoryQueue({
            receiptItems: makeReceiptCards({ s1: 5, s2: 5, s3: 5 }),
        });
        expect(fromGlobalCount(items)).toBe(0);
    });
});
