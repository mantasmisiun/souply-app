import { chunkIds, fetchPriceHistories, HISTORY_CHUNK_SIZE } from '../utils/priceHistory';

/**
 * Perf audit finding 13: product detail fetched price history per store
 * product IN SEQUENCE. The bulk client must: chunk ids under the server's
 * per-request cap, map `{ histories }` back per id (missing id → []), and
 * fall back to the legacy single-id endpoint when the bulk call fails (400
 * over-cap, older server without the route, network error) — never throw.
 */

let fetchMock: jest.Mock;
beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
});

const bulkCalls = () => fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/prices/store-products/history'));
const singleCalls = () => fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/prices/store-product/') && String(c[0]).endsWith('/history'));

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const bad = (status: number) => ({ ok: false, status, json: async () => ({}) });

describe('chunkIds', () => {
    test('splits at the chunk size', () => {
        const ids = Array.from({ length: 45 }, (_, i) => i + 1);
        const chunks = chunkIds(ids);
        expect(chunks.map(c => c.length)).toEqual([HISTORY_CHUNK_SIZE, HISTORY_CHUNK_SIZE, 45 - 2 * HISTORY_CHUNK_SIZE]);
        expect(chunks.flat()).toEqual(ids);
    });
    test('empty input → no chunks', () => {
        expect(chunkIds([])).toEqual([]);
    });
});

describe('bulk happy path', () => {
    test('one request, ids in the query, histories mapped per id', async () => {
        fetchMock.mockResolvedValueOnce(ok({
            histories: { '1': [{ price: 1.09, date: '2026-07-01' }], '2': [] },
        }));
        const res = await fetchPriceHistories([1, 2, 3]);
        expect(bulkCalls()).toHaveLength(1);
        expect(String(bulkCalls()[0][0])).toContain('spIds=1,2,3');
        expect(res[1]).toEqual([{ price: 1.09, date: '2026-07-01' }]);
        expect(res[2]).toEqual([]);
        expect(res[3]).toEqual([]); // omitted by the server → empty, not undefined
    });

    test('more ids than the cap → one bulk request per chunk', async () => {
        fetchMock.mockImplementation(async () => ok({ histories: {} }));
        const ids = Array.from({ length: HISTORY_CHUNK_SIZE * 2 + 5 }, (_, i) => i + 1);
        const res = await fetchPriceHistories(ids);
        expect(bulkCalls()).toHaveLength(3);
        expect(Object.keys(res)).toHaveLength(ids.length);
    });

    test('no ids → no requests', async () => {
        expect(await fetchPriceHistories([])).toEqual({});
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('fallback to the single-id endpoint', () => {
    test('a 400 (or any non-OK) falls back per id for that chunk', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (String(url).includes('/api/prices/store-products/history')) return bad(400);
            return ok([{ price: 2.5, date: '2026-07-02' }]);
        });
        const res = await fetchPriceHistories([7, 8]);
        expect(bulkCalls()).toHaveLength(1);
        expect(singleCalls()).toHaveLength(2);
        expect(res[7]).toEqual([{ price: 2.5, date: '2026-07-02' }]);
        expect(res[8]).toEqual([{ price: 2.5, date: '2026-07-02' }]);
    });

    test('a network error on the bulk call falls back too', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (String(url).includes('/api/prices/store-products/history')) throw new Error('offline');
            return ok([]);
        });
        const res = await fetchPriceHistories([7]);
        expect(singleCalls()).toHaveLength(1);
        expect(res[7]).toEqual([]);
    });

    test('a malformed bulk body (no histories object) falls back', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (String(url).includes('/api/prices/store-products/history')) return ok({ error: 'nope' });
            return ok([{ price: 3, date: '2026-07-03' }]);
        });
        const res = await fetchPriceHistories([9]);
        expect(singleCalls()).toHaveLength(1);
        expect(res[9]).toEqual([{ price: 3, date: '2026-07-03' }]);
    });

    test('single-id failures resolve to [] — never a throw', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (String(url).includes('/api/prices/store-products/history')) return bad(400);
            throw new Error('offline');
        });
        const res = await fetchPriceHistories([7, 8]);
        expect(res).toEqual({ 7: [], 8: [] });
    });
});
