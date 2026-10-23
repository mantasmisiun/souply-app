import {
    mergeServerItems,
    itemsFingerprint,
    sortItems,
    createDebouncedSearch,
    type SyncableListItem,
} from '../utils/shoppingListSync';

const item = (over: Partial<SyncableListItem> & { id: number }): SyncableListItem => ({
    listId: 1,
    productName: `P${over.id}`,
    quantity: 1,
    price: null,
    isChecked: false,
    l1CategoryId: null,
    l2CategoryId: null,
    l2CategoryName: null,
    checkedByUserId: null,
    ...over,
});

describe('mergeServerItems — the 3s poll merge with diff-bail', () => {
    it('returns the PREVIOUS array reference when nothing changed (diff-bail)', () => {
        const prev = sortItems([item({ id: 1 }), item({ id: 2, isChecked: true })]);
        // Server sends fresh (deep-equal) objects, as JSON parsing always does.
        const server = [item({ id: 1 }), item({ id: 2, isChecked: true })];
        const out = mergeServerItems(prev, server, { inFlightIds: new Set() });
        expect(out).toBe(prev); // identity, not just equality — React skips the commit
    });

    it('returns a new array when a rendered field changed', () => {
        const prev = sortItems([item({ id: 1 }), item({ id: 2 })]);
        const server = [item({ id: 1 }), item({ id: 2, isChecked: true })];
        const out = mergeServerItems(prev, server, { inFlightIds: new Set() });
        expect(out).not.toBe(prev);
        expect(out.find(i => i.id === 2)?.isChecked).toBe(true);
    });

    it('returns a new array when an item is added or removed', () => {
        const prev = sortItems([item({ id: 1 })]);
        const added = mergeServerItems(prev, [item({ id: 1 }), item({ id: 3 })], { inFlightIds: new Set() });
        expect(added.map(i => i.id).sort()).toEqual([1, 3]);
        const removed = mergeServerItems(prev, [], { inFlightIds: new Set() });
        expect(removed).toHaveLength(0);
    });

    it('keeps the LOCAL version of in-flight items (optimistic write not yet on server)', () => {
        const local = item({ id: 5, isChecked: true });
        const prev = [local];
        const server = [item({ id: 5, isChecked: false })]; // stale server view
        const out = mergeServerItems(prev, server, { inFlightIds: new Set([5]) });
        expect(out).toBe(prev); // local state preserved AND identical → bail
    });

    it('hides an item pending undo-delete', () => {
        const prev = [item({ id: 1 })];
        const server = [item({ id: 1 }), item({ id: 9 })];
        const out = mergeServerItems(prev, server, { inFlightIds: new Set(), pendingDeleteId: 9 });
        expect(out.map(i => i.id)).toEqual([1]);
        expect(out).toBe(prev); // same visible outcome → bail
    });

    it('sorts merged results into display order (unchecked before checked)', () => {
        const prev: SyncableListItem[] = [];
        const server = [item({ id: 1, isChecked: true }), item({ id: 2 })];
        const out = mergeServerItems(prev, server, { inFlightIds: new Set() });
        expect(out.map(i => i.id)).toEqual([2, 1]);
    });
});

describe('itemsFingerprint', () => {
    it('differs when checked state, qty or checker changes', () => {
        const base = [item({ id: 1 })];
        expect(itemsFingerprint(base)).not.toEqual(itemsFingerprint([item({ id: 1, isChecked: true })]));
        expect(itemsFingerprint(base)).not.toEqual(itemsFingerprint([item({ id: 1, quantity: 2 })]));
        expect(itemsFingerprint(base)).not.toEqual(itemsFingerprint([item({ id: 1, checkedByUserId: 'u' })]));
        expect(itemsFingerprint(base)).toEqual(itemsFingerprint([item({ id: 1 })]));
    });
});

describe('createDebouncedSearch — debounce + abort + seq guard', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    it('collapses rapid keystrokes into ONE request after the debounce window', async () => {
        const run = jest.fn(async (_query: string, _signal: AbortSignal) => ['ok']);
        const onResults = jest.fn();
        const s = createDebouncedSearch(run, onResults, 300);
        s.search('p');
        jest.advanceTimersByTime(100);
        s.search('pi');
        jest.advanceTimersByTime(100);
        s.search('pienas');
        jest.advanceTimersByTime(299);
        expect(run).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0][0]).toBe('pienas');
        await Promise.resolve(); await Promise.resolve();
        expect(onResults).toHaveBeenCalledWith(['ok'], 'pienas');
    });

    it('drops a stale response that arrives after a newer search (seq guard)', async () => {
        const resolvers: ((v: string[]) => void)[] = [];
        const run = jest.fn((q: string) => new Promise<string[]>(res => resolvers.push(res)));
        const onResults = jest.fn();
        const s = createDebouncedSearch(run, onResults, 300);

        s.search('a');
        jest.advanceTimersByTime(300); // request 1 in flight
        s.search('ab');
        jest.advanceTimersByTime(300); // request 2 in flight

        // OLD response arrives LAST-to-first order: resolve request 1 late.
        resolvers[1](['fresh']);
        await Promise.resolve(); await Promise.resolve();
        resolvers[0](['stale']);
        await Promise.resolve(); await Promise.resolve();

        expect(onResults).toHaveBeenCalledTimes(1);
        expect(onResults).toHaveBeenCalledWith(['fresh'], 'ab');
    });

    it('aborts the previous in-flight request when a new one fires', () => {
        const seenSignals: AbortSignal[] = [];
        const run = jest.fn((q: string, signal: AbortSignal) => {
            seenSignals.push(signal);
            return new Promise<string[]>(() => {}); // never resolves
        });
        const s = createDebouncedSearch(run, jest.fn(), 300);
        s.search('a');
        jest.advanceTimersByTime(300);
        s.search('ab');
        jest.advanceTimersByTime(300);
        expect(seenSignals).toHaveLength(2);
        expect(seenSignals[0].aborted).toBe(true);
        expect(seenSignals[1].aborted).toBe(false);
    });

    it('cancel() stops the pending timer, aborts, and invalidates in-flight responses', async () => {
        let resolver: ((v: string[]) => void) | null = null;
        const seenSignals: AbortSignal[] = [];
        const run = jest.fn((q: string, signal: AbortSignal) => {
            seenSignals.push(signal);
            return new Promise<string[]>(res => { resolver = res; });
        });
        const onResults = jest.fn();
        const s = createDebouncedSearch(run, onResults, 300);

        // Pending timer cancelled → never fires.
        s.search('a');
        s.cancel();
        jest.advanceTimersByTime(1000);
        expect(run).not.toHaveBeenCalled();

        // In-flight request invalidated by cancel.
        s.search('ab');
        jest.advanceTimersByTime(300);
        expect(run).toHaveBeenCalledTimes(1);
        s.cancel();
        expect(seenSignals[0].aborted).toBe(true);
        resolver!(['late']);
        await Promise.resolve(); await Promise.resolve();
        expect(onResults).not.toHaveBeenCalled();
    });
});
