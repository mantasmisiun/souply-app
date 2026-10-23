import { useBasketQuantitiesStore, __resetBasketQuantityTimers } from '../state/basketQuantities';

/**
 * THE STEPPER RACE (reported: "tapped +, it showed 2, then snapped back to 1;
 * came back later and it was 3").
 *
 * Every add bumps basketRev, which triggers a refresh. That refresh REPLACED the
 * quantity map, so a fetch that started before your tap could land after it and
 * overwrite the newer local value — while the server had already stored it. The
 * next unrelated refresh then made the number jump.
 *
 * The rules pinned here: local writes win while in flight, the newest write wins
 * by seq, a burst of taps becomes ONE request, and a refusal falls back to
 * server truth instead of leaving a fantasy quantity on screen.
 */

// Fake timers stub setImmediate, so drain the microtask queue by hand: the
// flush awaits fetch → res.json() → store writes.
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
/** Run the debounce window and let the write settle. */
const settleWrite = async () => { await jest.advanceTimersByTimeAsync(250); await tick(); };

const store = () => useBasketQuantitiesStore.getState();

let fetchMock: jest.Mock;

beforeEach(() => {
    jest.useFakeTimers();
    __resetBasketQuantityTimers();
    useBasketQuantitiesStore.setState({
        basketId: 7, quantities: {}, server: {}, pending: {}, seq: 0,
    });
    fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ remaining: 1 }) }));
    (global as any).fetch = fetchMock;
});
afterEach(() => {
    __resetBasketQuantityTimers();
    jest.useRealTimers();
});

describe('a local write survives a stale refresh', () => {
    test('THE BUG: a refresh that resolves AFTER the tap must not revert it', async () => {
        // Server truth as of the add: 1.
        useBasketQuantitiesStore.setState({ server: { 42: 1 }, quantities: { 42: 1 } });

        // The user taps + → 2, while a refresh (started earlier) is still in flight.
        store().commit(42, 2);
        expect(store().quantities[42]).toBe(2);

        // That refresh now lands, still reporting the pre-tap value.
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ 42: 1 }) });
        await store().refresh();

        expect(store().quantities[42]).toBe(2);      // local intent held
        expect(store().server[42]).toBe(1);          // server truth recorded separately
    });

    test('server truth for OTHER products still lands', async () => {
        useBasketQuantitiesStore.setState({ server: { 42: 1 }, quantities: { 42: 1 } });
        store().commit(42, 2);
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ 42: 1, 99: 3 }) });
        await store().refresh();
        expect(store().quantities).toEqual({ 42: 2, 99: 3 });
    });

    test('once the write is confirmed, refresh adopts the server value again', async () => {
        store().commit(42, 2);
        await settleWrite();
        expect(store().pending[42]).toBeUndefined();
        expect(store().server[42]).toBe(2);

        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ 42: 5 }) });
        await store().refresh();
        expect(store().quantities[42]).toBe(5);      // someone else changed it — adopt
    });
});

describe('a burst of taps is one request', () => {
    test('+,+,+ writes the FINAL value once, not three racing writes', async () => {
        store().commit(42, 1);
        store().commit(42, 2);
        store().commit(42, 3);
        expect(store().quantities[42]).toBe(3);      // painted every tap

        await settleWrite();

        const writes = fetchMock.mock.calls.filter(c => c[1]?.method === 'PUT');
        expect(writes).toHaveLength(1);
        expect(JSON.parse(writes[0][1].body)).toEqual({ quantity: 3 });
    });

    test('the write is addressed by PRODUCT — no lookup request first', async () => {
        store().commit(42, 2);
        await settleWrite();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toContain('/api/baskets/7/items/by-product/42');
    });

    test('different products write independently', async () => {
        store().commit(42, 1);
        store().commit(43, 2);
        await settleWrite();
        expect(fetchMock.mock.calls.filter(c => c[1]?.method === 'PUT')).toHaveLength(2);
    });
});

describe('failure handling', () => {
    test('a refused write falls back to server truth', async () => {
        useBasketQuantitiesStore.setState({ server: { 42: 1 }, quantities: { 42: 1 } });
        fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });

        store().commit(42, 2);
        expect(store().quantities[42]).toBe(2);      // optimistic first

        await settleWrite();
        expect(store().quantities[42]).toBe(1);      // corrected, not left lying
        expect(store().pending[42]).toBeUndefined();
    });

    test('quantity 0 clears the product from the map', async () => {
        useBasketQuantitiesStore.setState({ server: { 42: 2 }, quantities: { 42: 2 } });
        store().commit(42, 0);
        await settleWrite();
        expect(store().quantities[42] ?? 0).toBe(0);
        expect(store().server[42]).toBeUndefined();
    });

    test('a negative step can never persist a negative quantity', () => {
        store().commit(42, -3);
        expect(store().quantities[42]).toBe(0);
    });
});

describe('basket switching', () => {
    test('switching target clears the map and cancels pending writes', async () => {
        store().commit(42, 2);
        store().setBasket(9);
        await settleWrite();
        // The pending write for basket 7 must not land on basket 9.
        const writes = fetchMock.mock.calls.filter(c => c[1]?.method === 'PUT');
        expect(writes).toHaveLength(0);
        expect(store().quantities).toEqual({});
    });

    test('adopt records a quantity persisted elsewhere without writing', async () => {
        store().adopt(42, 4);
        await jest.advanceTimersByTimeAsync(250);
        expect(store().quantities[42]).toBe(4);
        expect(store().server[42]).toBe(4);
        expect(fetchMock.mock.calls.filter(c => c[1]?.method === 'PUT')).toHaveLength(0);
    });
});
