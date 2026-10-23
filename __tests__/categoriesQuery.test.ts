import { fetchCategoryTree, categoriesQueryKey } from '../utils/categoriesQuery';

/**
 * "THE CATALOG STAYED EMPTY UNTIL I RESTARTED THE APP."
 *
 * The server was down when the app launched. The category fetch caught its own
 * error, cleared the spinner and left an empty list — so a failure was
 * indistinguishable from an empty catalogue. Nothing retried it: tab screens
 * stay mounted, so leaving to Shopping and coming back never re-ran the effect,
 * and the query cache held no tree to fall back on either.
 *
 * The contract that fixes it: a failed load THROWS, so the query layer retries
 * with backoff, keeps the last good tree, and the screen can show an error with
 * a retry instead of a blank page.
 */

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fail = (status: number) => ({ ok: false, status, json: async () => ({}) });

const L1 = [{ id: 1, name: 'Pieno gaminiai', parentCategoryId: null }];
const L2 = [
    { id: 10, name: 'Pienas', parentCategoryId: 1 },
    { id: 11, name: 'Sūriai', parentCategoryId: 1 },
    { id: 20, name: 'Orphan', parentCategoryId: null },
];

describe('fetchCategoryTree', () => {
    test('THE BUG: a down server throws instead of resolving to an empty tree', async () => {
        (global as any).fetch = jest.fn(async () => fail(502));
        await expect(fetchCategoryTree()).rejects.toThrow(/categories/);
    });

    test('one endpoint failing is still a failure — never a half-built tree', async () => {
        (global as any).fetch = jest.fn(async (url: string) =>
            url.includes('/l2') ? fail(500) : ok(L1));
        await expect(fetchCategoryTree()).rejects.toThrow(/categories/);
    });

    test('a network error propagates (so the retry policy sees it)', async () => {
        (global as any).fetch = jest.fn(async () => { throw new Error('Network request failed'); });
        await expect(fetchCategoryTree()).rejects.toThrow('Network request failed');
    });

    test('groups every L2 under its parent', async () => {
        (global as any).fetch = jest.fn(async (url: string) => ok(url.includes('/l2') ? L2 : L1));
        const tree = await fetchCategoryTree();
        expect(tree.l1).toHaveLength(1);
        expect(tree.l2Map[1].map(c => c.id)).toEqual([10, 11]);
    });

    test('parentless L2 rows are dropped, not crashed on', async () => {
        (global as any).fetch = jest.fn(async (url: string) => ok(url.includes('/l2') ? L2 : L1));
        const tree = await fetchCategoryTree();
        expect(Object.keys(tree.l2Map)).toEqual(['1']);
    });

    test('a non-array payload degrades to empty rather than throwing on .forEach', async () => {
        (global as any).fetch = jest.fn(async () => ok({ error: 'nope' }));
        const tree = await fetchCategoryTree();
        expect(tree).toEqual({ l1: [], l2Map: {} });
    });

    test('both requests go out in parallel, and the abort signal is passed through', async () => {
        const seen: (AbortSignal | undefined)[] = [];
        (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
            seen.push(init?.signal ?? undefined);
            return ok(url.includes('/l2') ? L2 : L1);
        });
        const ctrl = new AbortController();
        await fetchCategoryTree(ctrl.signal);
        expect(seen).toHaveLength(2);
        expect(seen.every(s => s === ctrl.signal)).toBe(true);
    });

    test('the language is part of the cache key (a switch refetches)', () => {
        expect(categoriesQueryKey('lt')).not.toEqual(categoriesQueryKey('en'));
    });
});
