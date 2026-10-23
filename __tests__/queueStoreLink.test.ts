import { needsStoreChoice, resolveLinkListId } from '../services/receiptProcessingService';
import { useReceiptQueueStore } from '../state/receiptQueueStore';

/**
 * THE SILENT DETACH (trip 186, receipts 121/122).
 *
 * A basket was calculated for TWO stores — Lidl (chain 5, list 73) and Maxima
 * (chain 1, list 74) — and the user then uploaded two IKI (chain 3) receipts from
 * that trip's sheet. Both parsed perfectly, both saved… and both vanished from the
 * trip: `resolveLinkListId` found no chain match, had two candidates so couldn't
 * pick one, and returned null. The link call was then skipped entirely, the server
 * saw no shoppingListId, and each receipt minted its own ad-hoc trip. Nothing
 * errored, so the card just disappeared — it read as "the scan silently failed".
 *
 * The interactive scan has always asked (scanSessionService's chainGate). These
 * tests pin the headless queue asking too, and never dropping a link in silence.
 */

const TRIP_LINK_MAP = { 5: 73, 1: 74 };   // planned: Lidl + Maxima

describe('needsStoreChoice — when must the queue ask?', () => {
    test('THE BUG: multi-store trip, receipt from an unplanned chain → ask', () => {
        expect(needsStoreChoice(3, TRIP_LINK_MAP, null)).toBe(true);
    });

    test('chain matches a planned store → link straight through, no question', () => {
        expect(needsStoreChoice(5, TRIP_LINK_MAP, null)).toBe(false);
        expect(resolveLinkListId(5, TRIP_LINK_MAP, null)).toBe(73);
    });

    test('single-store trip → the lone list wins even on a chain mismatch', () => {
        // Receipt 120 took this path and attached correctly (list 72, IKI trip).
        expect(needsStoreChoice(1, { 3: 72 }, null)).toBe(false);
        expect(resolveLinkListId(1, { 3: 72 }, null)).toBe(72);
    });

    test('a bare upload (Shopping sheet, no trip context) stays ad-hoc by design', () => {
        expect(needsStoreChoice(3, undefined, null)).toBe(false);
        expect(needsStoreChoice(null, undefined, undefined)).toBe(false);
    });

    test('an explicit fallback list is an answer — nothing to ask', () => {
        expect(needsStoreChoice(3, undefined, 71)).toBe(false);
        expect(resolveLinkListId(3, undefined, 71)).toBe(71);
    });

    test('unknown chain on a multi-store trip still asks (rather than guessing)', () => {
        expect(needsStoreChoice(null, TRIP_LINK_MAP, null)).toBe(true);
    });
});

describe('queue parking for the store choice', () => {
    beforeEach(() => {
        useReceiptQueueStore.setState({ items: [], recentIds: [], lastCompleted: null, lastCompletedAt: null });
    });

    const seed = () => {
        useReceiptQueueStore.getState().addItems([{ uris: ['file:///a.jpg'], linkMap: TRIP_LINK_MAP }]);
        return useReceiptQueueStore.getState().items[0].id;
    };

    test('parked item carries the detected chain and one option per planned store', () => {
        const id = seed();
        useReceiptQueueStore.getState().markNeedsStore(id, 'ask', {
            detectedChainId: 3,
            options: [{ chainId: 5, listId: 73 }, { chainId: 1, listId: 74 }],
        });
        const item = useReceiptQueueStore.getState().items[0];
        expect(item.status).toBe('needs_store');
        expect(item.linkDetectedChainId).toBe(3);
        expect(item.linkOptions).toHaveLength(2);
    });

    test('picking a store re-queues the item pinned to that list', () => {
        const id = seed();
        useReceiptQueueStore.getState().markNeedsStore(id, 'ask', { detectedChainId: 3, options: [] });
        useReceiptQueueStore.getState().resolveStoreLink(id, 74);
        const item = useReceiptQueueStore.getState().items[0];
        expect(item.status).toBe('pending');
        expect(item.linkChoiceListId).toBe(74);
        expect(item.linkAdHoc).toBe(false);
        expect(item.errorReason).toBeUndefined();      // the park is cleared, not left dangling
    });

    test('"keep separate" re-queues as an explicit ad-hoc upload, and does not ask twice', () => {
        const id = seed();
        useReceiptQueueStore.getState().markNeedsStore(id, 'ask', { detectedChainId: 3, options: [] });
        useReceiptQueueStore.getState().resolveStoreLink(id, null);
        const item = useReceiptQueueStore.getState().items[0];
        expect(item.status).toBe('pending');
        expect(item.linkAdHoc).toBe(true);
        expect(item.linkChoiceListId).toBeUndefined();
    });

    test('"this shopping, no planned store" targets the TRIP, not a borrowed slot', () => {
        // Plan IKI + Norfa, shop Maxima. Claiming the IKI slot would mark the IKI
        // stop done; the receipt belongs to the trip and to no slot at all.
        const id = seed();
        useReceiptQueueStore.getState().markNeedsStore(id, 'ask', {
            detectedChainId: 1, options: [{ chainId: 5, listId: 73 }, { chainId: 3, listId: 75 }],
        });
        useReceiptQueueStore.getState().resolveStoreTrip(id, 191);
        const item = useReceiptQueueStore.getState().items[0];
        expect(item.status).toBe('pending');
        expect(item.linkTripId).toBe(191);
        expect(item.linkChoiceListId).toBeUndefined();
        expect(item.linkAdHoc).toBe(false);
    });

    test('a failed link parks with the saved receipt id so the retry links only', () => {
        const id = seed();
        useReceiptQueueStore.getState().markNeedsLink(id, 'oops', { receiptId: 121, listId: 74 });
        const item = useReceiptQueueStore.getState().items[0];
        expect(item.status).toBe('needs_link');
        expect(item.linkReceiptId).toBe(121);
        expect(item.linkListId).toBe(74);
    });
});

describe('completion records where the receipt LANDED (trip-screen backstop)', () => {
    beforeEach(() => {
        useReceiptQueueStore.setState({ items: [], recentIds: [], lastCompleted: null, lastCompletedAt: null });
    });

    test('aimed at the trip, attached to one of its lists → nothing to warn about', () => {
        useReceiptQueueStore.getState().addItems([{ uris: ['file:///a.jpg'], linkMap: TRIP_LINK_MAP }]);
        const id = useReceiptQueueStore.getState().items[0].id;
        useReceiptQueueStore.getState().markDone(id, 121, 74);
        const last = useReceiptQueueStore.getState().lastCompleted!;
        expect(last.receiptId).toBe(121);
        // Order is whatever Object.values gives (numeric keys sort ascending) —
        // the backstop only asks "was this trip among the targets?".
        expect(last.intendedListIds.sort()).toEqual([73, 74]);
        expect(last.linkedListId).toBe(74);
    });

    test('THE BUG: aimed at the trip, landed nowhere → the trip screen can say so', () => {
        useReceiptQueueStore.getState().addItems([{ uris: ['file:///a.jpg'], linkMap: TRIP_LINK_MAP }]);
        const id = useReceiptQueueStore.getState().items[0].id;
        useReceiptQueueStore.getState().markDone(id, 122);          // no linkedListId = ad-hoc
        const last = useReceiptQueueStore.getState().lastCompleted!;
        expect(last.intendedListIds.sort()).toEqual([73, 74]);
        expect(last.linkedListId).toBeNull();
    });

    test('a HEAL declares no link intent — it re-parses a receipt already on the trip', () => {
        // Reported: a dev re-scan updated Prekės and THEN said "Kvitas priskirtas
        // kitur". A heal targets a RECEIPT, not a list; the link step is skipped
        // by design, so linkedListId is always null and must not read as "landed
        // elsewhere" for the receipt sitting right there on screen.
        useReceiptQueueStore.getState().addItems([
            { uris: ['file:///a.jpg'], healReceiptId: 19, devReplace: true, linkMap: TRIP_LINK_MAP },
        ]);
        const id = useReceiptQueueStore.getState().items[0].id;
        useReceiptQueueStore.getState().markDone(id, 19);
        expect(useReceiptQueueStore.getState().lastCompleted!.intendedListIds).toEqual([]);
    });

    test('a bare upload records no intent, so no trip claims it', () => {
        useReceiptQueueStore.getState().addItems([{ uris: ['file:///a.jpg'] }]);
        const id = useReceiptQueueStore.getState().items[0].id;
        useReceiptQueueStore.getState().markDone(id, 123);
        expect(useReceiptQueueStore.getState().lastCompleted!.intendedListIds).toEqual([]);
    });
});
