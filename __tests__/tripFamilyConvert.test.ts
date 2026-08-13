import fs from 'fs';
import path from 'path';
import { convertTripToFamily } from '../utils/familyShoppingApi';
import { buildFamilyFeed, isFamilyTrip } from '../utils/familyShopping';
import type { TripSummary } from '../utils/tripsApi';

/**
 * "CONVERT TO FAMILY SHOPPING" IS THE SERVER'S JOB (spec §7).
 *
 * THE BUG THIS LOCKS DOWN. The API had no convert endpoint, so the app shipped
 * §7's menu action as device-local state: `state/familyTripStore.ts`, a
 * persisted AsyncStorage map of "trips I converted on this phone" plus the
 * personal flags for their lines. Tapping Convert painted the pink "Family
 * items" section and switched the per-item toggles on — and nothing reached the
 * household ledger, no balance moved, and no other member saw a thing. It
 * looked exactly like a working feature, which is worse than an absent one.
 *
 * The contract now: convert POSTs, and family mode is `Trip.householdId` from
 * the server and nothing else. Two things must therefore stay true forever —
 * no local convert state survives anywhere, and a failed convert must THROW
 * rather than resolve, because a silent success is precisely the old bug.
 */

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fail = (status: number) => ({ ok: false, status, json: async () => ({ error: 'nope' }) });

const RESULT = {
    tripId: 7,
    householdId: 3,
    participants: ['u1', 'u2'],
    recorded: [{ receiptId: 11, payer: 'u1', amountCents: 1550, alreadyRecorded: false }],
    skipped: [],
};

describe('§7 convert — it goes to the server', () => {
    it('POSTs to the trip\'s convert endpoint and returns the ledger outcome', async () => {
        const fetchMock = jest.fn(async () => ok(RESULT));
        (global as any).fetch = fetchMock;

        await expect(convertTripToFamily(7)).resolves.toEqual(RESULT);

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toContain('/api/trips/7/convert-to-family');
        expect(init.method).toBe('POST');
    });

    it('THROWS when the server refuses — a failed convert must never look like a success', async () => {
        // 409 already-family, 403 not yours, 404, offline: all the same to the
        // caller, which shows the failure instead of flipping the UI.
        for (const status of [403, 404, 409, 500]) {
            (global as any).fetch = jest.fn(async () => fail(status));
            await expect(convertTripToFamily(7)).rejects.toThrow(String(status));
        }
        (global as any).fetch = jest.fn(async () => { throw new Error('Network request failed'); });
        await expect(convertTripToFamily(7)).rejects.toThrow(/Network/);
    });

    it('reports receipts the ledger could NOT take, rather than swallowing them', async () => {
        // A receipt uploaded by someone outside the household has no payer in
        // this ledger; the server skips it and says so (it must never be
        // re-attributed to the converter).
        (global as any).fetch = jest.fn(async () => ok({
            ...RESULT, recorded: [], skipped: [{ receiptId: 12, reason: 'payer-not-eligible' }],
        }));
        const out = await convertTripToFamily(7);
        expect(out.skipped).toEqual([{ receiptId: 12, reason: 'payer-not-eligible' }]);
    });
});

// ---------------------------------------------------------------------------
// A converted trip is a family trip everywhere, not just on the receipt screen
// ---------------------------------------------------------------------------

const SHARED_BASKET = 77;

const trip = (over: Partial<TripSummary>): TripSummary => ({
    id: 1, name: null, isAdHoc: false, scoreExempt: false, archivedAt: null,
    createdAt: '2026-07-01', stage: 5, memberCount: 2, ownerUserId: 'u1',
    anchorDate: '2026-07-20', basket: { id: SHARED_BASKET, status: 'inProgress', itemCount: 3 },
    slots: [], receiptCount: 1, recognisedItemCount: 12, chains: [],
    ...over,
} as TripSummary);

/** The shape convert produces: a PERSONAL basket, but a household on the trip. */
const converted = (over: Partial<TripSummary> = {}) => trip({
    id: 4, householdId: 9, basket: { id: 50, status: 'completed', itemCount: 2 }, ...over,
});

describe('§5.2 — a converted trip reaches the family history feed', () => {
    it('is a family trip because of Trip.householdId, not its basket', () => {
        expect(isFamilyTrip(converted(), SHARED_BASKET)).toBe(true);
        // ... and with no shared basket known at all.
        expect(isFamilyTrip(converted(), null)).toBe(true);
        // A genuinely personal trip is still personal.
        expect(isFamilyTrip(trip({ id: 5, basket: { id: 50, status: 'x', itemCount: 1 } }), SHARED_BASKET)).toBe(false);
    });

    it('renders as a trip card — it used to vanish from the feed entirely', () => {
        // THE BUG: keyed on the shared basket, a converted trip produced no
        // card, AND its ledger `receipt` row was suppressed by the trip cards'
        // coverage cutoff. Balances moved with nothing in the feed to explain
        // it — the same "looks like it worked" failure the endpoint replaced.
        const feed = buildFamilyFeed(
            [trip({ id: 1, anchorDate: '2026-07-10' }), converted({ anchorDate: '2026-07-20' })],
            null, SHARED_BASKET, [],
        );
        expect(feed.filter(e => e.kind === 'trip').map(e => (e as any).trip.id)).toEqual([4, 1]);
    });
});

// ---------------------------------------------------------------------------
// No local convert state, anywhere
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.expo', 'android', 'ios', 'dist', 'build', 'coverage', 'shared']);

const sourceFiles = (dir: string, out: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) sourceFiles(full, out);
        else if (/\.tsx?$/.test(entry.name) && !full.includes(`${path.sep}__tests__${path.sep}`)) out.push(full);
    }
    return out;
};

describe('§7 convert — the device-local store is gone and stays gone', () => {
    it('state/familyTripStore.ts no longer exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'state', 'familyTripStore.ts'))).toBe(false);
    });

    it('nothing imports it, and nothing calls a family-trip store hook', () => {
        // Import-shaped and call-shaped only — the prose above deliberately
        // names the deleted module, and a doc comment is not a dependency.
        const offenders = sourceFiles(ROOT).filter((f) => {
            const src = fs.readFileSync(f, 'utf8');
            return /from\s+['"][^'"]*familyTripStore['"]/.test(src) || /useFamilyTripStore\s*\(/.test(src);
        });
        expect(offenders.map(f => path.relative(ROOT, f))).toEqual([]);
    });

    it('no source file persists convert state', () => {
        // The old storage key, and any successor by another name.
        const offenders = sourceFiles(ROOT).filter(f =>
            /family_trip_convert/.test(fs.readFileSync(f, 'utf8')));
        expect(offenders.map(f => path.relative(ROOT, f))).toEqual([]);

        const screen = fs.readFileSync(path.join(ROOT, 'app', 'trip', 'receipts', '[id].tsx'), 'utf8');
        // The trip receipts screen holds NO persisted state of its own.
        expect(screen).not.toMatch(/from\s+['"]@react-native-async-storage/);
        // Family mode is derived from the server's trip payload, full stop.
        expect(screen).toMatch(/const familyActive = trip\?\.householdId != null;/);
    });
});
