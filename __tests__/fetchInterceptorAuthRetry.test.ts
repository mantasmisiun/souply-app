/**
 * Regression guard for the 2026-08-28 production incident.
 *
 * A stale anonymous session token made every per-user route 401. Only
 * profileStore re-claimed a token, so the basket was permanently dead while the
 * catalog looked fine — and because the API's dev-header shim was open outside
 * production, it could not be reproduced anywhere but prod.
 *
 * The recovery now lives in the fetch interceptor so it covers EVERY per-user
 * route. These tests pin the parts that are easy to regress: retry exactly once,
 * only when the replay is safe, and share one reclaim across concurrent 401s.
 */
import { installFetchInterceptor } from '../utils/installFetchInterceptor';

const API = 'https://api.example.test';

jest.mock('../config/api', () => ({ API_BASE_URL: 'https://api.example.test' }));
jest.mock('../i18n', () => ({ __esModule: true, default: { language: 'lt' } }));
jest.mock('../state/versionGate', () => ({
    CLIENT_PLATFORM: 'android',
    CLIENT_VERSION: '1.1.0',
    useVersionGate: { getState: () => ({ triggerHard: jest.fn(), triggerSoft: jest.fn() }) },
}));

let mockActiveToken: string | null = 'stale-token';
jest.mock('../config/session', () => ({
    getActiveSessionToken: () => mockActiveToken,
}));

const mockReclaim = jest.fn();
jest.mock('../config/user', () => ({
    reclaimAnonSessionToken: () => mockReclaim(),
}));

const res = (status: number) =>
    ({ status, headers: { get: () => null }, clone: () => ({ json: () => Promise.resolve({}) }) }) as any;

/** Re-patch a fresh mock each test (the real patch is idempotent by tag). */
function install(impl: jest.Mock) {
    (globalThis as any).fetch = impl;
    installFetchInterceptor();
    return impl;
}

const authOf = (call: any[]) => new Headers(call[1].headers).get('Authorization');

beforeEach(() => {
    mockActiveToken = 'stale-token';
    mockReclaim.mockReset();
});

describe('interceptor: 401 → reclaim → replay once', () => {
    it('retries with the fresh token and returns the retried response', async () => {
        mockReclaim.mockImplementation(async () => { mockActiveToken = 'fresh-token'; return true; });
        const raw = install(jest.fn()
            .mockResolvedValueOnce(res(401))
            .mockResolvedValueOnce(res(200)));

        const out = await (globalThis as any).fetch(`${API}/api/baskets/user/u1`);

        expect(out.status).toBe(200);
        expect(mockReclaim).toHaveBeenCalledTimes(1);
        expect(raw).toHaveBeenCalledTimes(2);
        expect(authOf(raw.mock.calls[0])).toBe('Bearer stale-token');
        expect(authOf(raw.mock.calls[1])).toBe('Bearer fresh-token');
    });

    it('replays a POST with a string body — this is the add-to-basket path', async () => {
        mockReclaim.mockImplementation(async () => { mockActiveToken = 'fresh-token'; return true; });
        const raw = install(jest.fn()
            .mockResolvedValueOnce(res(401))
            .mockResolvedValueOnce(res(201)));

        const out = await (globalThis as any).fetch(`${API}/api/basket-items`, {
            method: 'POST',
            body: JSON.stringify({ basketId: 1, productId: 2 }),
        });

        expect(out.status).toBe(201);
        expect(raw).toHaveBeenCalledTimes(2);
    });

    it('does not loop when the replay also 401s', async () => {
        mockReclaim.mockImplementation(async () => { mockActiveToken = 'fresh-token'; return true; });
        const raw = install(jest.fn().mockResolvedValue(res(401)));

        const out = await (globalThis as any).fetch(`${API}/api/baskets/user/u1`);

        expect(out.status).toBe(401);
        expect(raw).toHaveBeenCalledTimes(2);
    });

    it('returns the 401 untouched when the reclaim fails', async () => {
        mockReclaim.mockResolvedValue(false);
        const raw = install(jest.fn().mockResolvedValue(res(401)));

        const out = await (globalThis as any).fetch(`${API}/api/baskets/user/u1`);

        expect(out.status).toBe(401);
        expect(raw).toHaveBeenCalledTimes(1);
    });

    it('shares ONE reclaim across concurrent 401s', async () => {
        let resolveReclaim: (v: boolean) => void = () => {};
        mockReclaim.mockImplementation(() => new Promise<boolean>(r => { resolveReclaim = r; }));
        const raw = install(jest.fn().mockResolvedValue(res(401)));

        const all = Promise.all([
            (globalThis as any).fetch(`${API}/api/baskets/user/u1`),
            (globalThis as any).fetch(`${API}/api/users/u1/profile`),
            (globalThis as any).fetch(`${API}/api/trips`),
        ]);
        await Promise.resolve();
        resolveReclaim(false);
        await all;

        expect(mockReclaim).toHaveBeenCalledTimes(1);
    });
});

describe('interceptor: when NOT to replay', () => {
    it('leaves a caller-managed Authorization alone', async () => {
        const raw = install(jest.fn().mockResolvedValue(res(401)));

        await (globalThis as any).fetch(`${API}/api/receipts/1`, {
            headers: { Authorization: 'Bearer caller-owned' },
        });

        expect(mockReclaim).not.toHaveBeenCalled();
        expect(raw).toHaveBeenCalledTimes(1);
        expect(authOf(raw.mock.calls[0])).toBe('Bearer caller-owned');
    });

    it('does not replay a non-string body — it cannot be sent twice', async () => {
        mockReclaim.mockResolvedValue(true);
        const raw = install(jest.fn().mockResolvedValue(res(401)));

        await (globalThis as any).fetch(`${API}/api/uploads`, {
            method: 'POST',
            body: new FormData() as any,
        });

        expect(mockReclaim).not.toHaveBeenCalled();
        expect(raw).toHaveBeenCalledTimes(1);
    });

    it('ignores third-party hosts entirely', async () => {
        const raw = install(jest.fn().mockResolvedValue(res(401)));

        await (globalThis as any).fetch('https://maps.googleapis.com/geocode');

        expect(mockReclaim).not.toHaveBeenCalled();
        expect(raw).toHaveBeenCalledTimes(1);
    });

    it('does nothing on a successful response', async () => {
        const raw = install(jest.fn().mockResolvedValue(res(200)));

        await (globalThis as any).fetch(`${API}/api/baskets/user/u1`);

        expect(mockReclaim).not.toHaveBeenCalled();
        expect(raw).toHaveBeenCalledTimes(1);
    });
});
