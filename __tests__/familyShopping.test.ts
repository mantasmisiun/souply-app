/**
 * Family shopping (spec §5) pure logic — utils/familyShopping:
 *   · §5.1 select-all transitions (unchecked-set model): checked by default,
 *     unchecking one drops "Select all", checking all/none returns to it,
 *     refetch pruning keeps choices and births new items checked.
 *   · §1.3 cents formatting — display only, signed with a real minus.
 *   · §3.2.1 who may confirm — the counterparty ONLY, never the proposer.
 *   · §5.2 feed assembly — pending vs resolved trips, settlements/leaving
 *     first, non-family and stage-1/2 trips excluded.
 *   · §5.2 history — page accumulation without duplicates, live-vs-confirmed
 *     settlement reconciliation, receipt-row dedup against trip cards.
 */
import {
    isAllSelected, isItemSelected, toggleItem, toggleSelectAll, pruneSelection, selectedCount,
    formatCents, formatBalanceCents, mayConfirmSettlement, isFamilyTrip,
    buildFamilyFeed, buildMemberStrip, mergeHistoryPages, historyReceiptCutoffDay,
} from '../utils/familyShopping';
import type {
    HouseholdHistoryEntry, HouseholdLedgerView, PendingSettlement,
} from '../utils/familyShoppingApi';
import type { TripSummary } from '../utils/tripsApi';

const IDS = [1, 2, 3];
const none = new Set<number>();

describe('§5.1 selection — the unchecked-set model', () => {
    it('starts with everything selected ("Select all" checked by default)', () => {
        expect(isAllSelected(IDS.length, none)).toBe(true);
        for (const id of IDS) expect(isItemSelected(none, id)).toBe(true);
        expect(selectedCount(IDS, none)).toBe(3);
    });

    it('an empty list is never "all selected" (nothing to select)', () => {
        expect(isAllSelected(0, none)).toBe(false);
    });

    it('unchecking any one item unchecks "Select all"', () => {
        const s = toggleItem(none, 2);
        expect(isItemSelected(s, 2)).toBe(false);
        expect(isItemSelected(s, 1)).toBe(true);
        expect(isAllSelected(IDS.length, s)).toBe(false);
        expect(selectedCount(IDS, s)).toBe(2);
    });

    it('re-checking the last unchecked item returns to the "Select all" state', () => {
        const s = toggleItem(toggleItem(none, 2), 2);
        expect(isAllSelected(IDS.length, s)).toBe(true);
    });

    it('manually checking every item one by one returns to the "Select all" state', () => {
        let s = toggleSelectAll(none, IDS); // all → none selected
        for (const id of IDS) s = toggleItem(s, id);
        expect(isAllSelected(IDS.length, s)).toBe(true);
    });

    it('"Select all" tap: all selected → none; anything else → all', () => {
        // From the default (all selected) → deselect everything.
        const cleared = toggleSelectAll(none, IDS);
        expect(selectedCount(IDS, cleared)).toBe(0);
        expect(isAllSelected(IDS.length, cleared)).toBe(false);
        // From none selected → select everything (returns to select-all).
        expect(isAllSelected(IDS.length, toggleSelectAll(cleared, IDS))).toBe(true);
        // From a partial selection → select everything too.
        const partial = toggleItem(none, 1);
        expect(isAllSelected(IDS.length, toggleSelectAll(partial, IDS))).toBe(true);
    });

    it('toggle is pure — the input set is never mutated', () => {
        const s = new Set([1]);
        toggleItem(s, 2);
        toggleSelectAll(s, IDS);
        expect([...s]).toEqual([1]);
    });

    it('pruneSelection drops stale ids, keeps live unchecks, births new items checked', () => {
        const s = new Set([2, 99]);            // 99 no longer exists
        const pruned = pruneSelection(s, [1, 2, 3, 4]); // 4 is new
        expect([...pruned]).toEqual([2]);
        expect(isItemSelected(pruned, 4)).toBe(true);   // new item checked by default
        // A removed item's stale uncheck must not hold "Select all" off.
        expect(isAllSelected(4, pruneSelection(new Set([99]), [1, 2, 3, 4]))).toBe(true);
    });
});

describe('§1.3 cents formatting (display only)', () => {
    it('formats magnitude with two decimals', () => {
        expect(formatCents(700)).toBe('€7.00');
        expect(formatCents(5)).toBe('€0.05');
        expect(formatCents(-1234)).toBe('€12.34');
        expect(formatCents(0)).toBe('€0.00');
    });

    it('signs balances like the spec examples ("Laura −€7.00", "John +€7.00")', () => {
        expect(formatBalanceCents(-700)).toBe('−€7.00'); // U+2212, not a hyphen
        expect(formatBalanceCents(700)).toBe('+€7.00');
        expect(formatBalanceCents(0)).toBe('€0.00');
        expect(formatBalanceCents(-1)).toBe('−€0.01');   // integer cents, no float drift
    });
});

describe('§3.2.1 who may confirm a settlement', () => {
    const s: Pick<PendingSettlement, 'from' | 'to' | 'by'> = { from: 'laura', to: 'john', by: 'laura' };

    it('the counterparty may confirm', () => {
        expect(mayConfirmSettlement(s, 'john')).toBe(true);
    });

    it('the proposer may NOT confirm their own proposal', () => {
        expect(mayConfirmSettlement(s, 'laura')).toBe(false);
    });

    it('a third member may not confirm, nor may an unknown viewer', () => {
        expect(mayConfirmSettlement(s, 'peter')).toBe(false);
        expect(mayConfirmSettlement(s, null)).toBe(false);
    });

    it('works with the receiver as proposer (the other direction)', () => {
        const byReceiver = { from: 'laura', to: 'john', by: 'john' };
        expect(mayConfirmSettlement(byReceiver, 'laura')).toBe(true);
        expect(mayConfirmSettlement(byReceiver, 'john')).toBe(false);
    });
});

// ── §5.2 feed ────────────────────────────────────────────────────────────────

const trip = (over: Partial<TripSummary>): TripSummary => ({
    id: 1, name: null, isAdHoc: false, scoreExempt: false, archivedAt: null,
    createdAt: '2026-07-01', stage: 4, memberCount: 2, ownerUserId: 'john',
    anchorDate: '2026-07-20', basket: { id: 77, status: 'inProgress', itemCount: 3 },
    slots: [], receiptCount: 1, recognisedItemCount: 12, chains: [],
    ...over,
} as TripSummary);

const ledger = (over: Partial<HouseholdLedgerView>): HouseholdLedgerView => ({
    householdId: 9, balanceCents: 0, transfers: [], balances: {},
    pendingSettlements: [], suggestedNextShopper: null, members: [], leaving: false,
    ...over,
});

describe('§5.2 family feed assembly', () => {
    it('identifies family trips by the shared basket id', () => {
        expect(isFamilyTrip(trip({}), 77)).toBe(true);
        expect(isFamilyTrip(trip({}), 78)).toBe(false);
        expect(isFamilyTrip(trip({ basket: null }), 77)).toBe(false);
        expect(isFamilyTrip(trip({}), null)).toBe(false);
    });

    it('classifies started-no-receipt as PENDING and receipted as resolved', () => {
        const pending = trip({ id: 2, stage: 3, receiptCount: 0 });
        const resolved = trip({ id: 3, stage: 5, receiptCount: 1 });
        const feed = buildFamilyFeed([pending, resolved], ledger({}), 77);
        expect(feed.map(e => e.kind)).toEqual(['trip', 'pendingTrip']); // newest-first by date/id
    });

    it('excludes non-family trips and the still-forming basket (stages 1–2)', () => {
        const foreign = trip({ id: 4, basket: { id: 50, status: 'draft', itemCount: 1 } });
        const forming = trip({ id: 5, stage: 1, receiptCount: 0 });
        const compared = trip({ id: 6, stage: 2, receiptCount: 0 });
        expect(buildFamilyFeed([foreign, forming, compared], ledger({}), 77)).toEqual([]);
    });

    it('orders trips newest-first', () => {
        const older = trip({ id: 7, anchorDate: '2026-07-01' });
        const newer = trip({ id: 8, anchorDate: '2026-07-25' });
        const feed = buildFamilyFeed([older, newer], ledger({}), 77);
        expect(feed.map(e => (e.kind === 'trip' ? e.trip.id : null))).toEqual([8, 7]);
    });

    it('puts pending settlements and leaving members before trips', () => {
        const lv = ledger({
            pendingSettlements: [{
                settlementId: 'abc', from: 'laura', to: 'john',
                amountCents: 700, by: 'laura', proposedAt: '2026-07-27',
            }],
            members: [
                { userId: 'laura', role: 'member', leaving: true },
                { userId: 'john', role: 'owner', leaving: false },
            ],
        });
        const feed = buildFamilyFeed([trip({})], lv, 77);
        expect(feed.map(e => e.kind)).toEqual(['settlement', 'leaving', 'trip']);
    });

    it('a pending settlement is display state only — it moves no balance here', () => {
        // The feed builder must not touch balances at all: they arrive derived.
        const lv = ledger({
            balances: { laura: -700, john: 700 },
            pendingSettlements: [{
                settlementId: 'abc', from: 'laura', to: 'john',
                amountCents: 700, by: 'laura', proposedAt: '2026-07-27',
            }],
        });
        buildFamilyFeed([], lv, 77);
        expect(lv.balances).toEqual({ laura: -700, john: 700 });
    });
});

// ── §5.2 history feed ────────────────────────────────────────────────────────

const hist = (over: Partial<HouseholdHistoryEntry>): HouseholdHistoryEntry => ({
    id: 1, at: '2026-07-10 12:00:00', kind: 'settlement', amountCents: 700,
    actor: { userId: 'laura', label: 'Laura' }, counterparty: { userId: 'john', label: 'John' },
    receiptId: null, settlementId: 'abc', storeName: null, chainName: null,
    reason: null, deltaByMember: null, title: 'Laura atsiskaitė su John', subtitle: null,
    ...over,
});

const pendingAbc: PendingSettlement = {
    settlementId: 'abc', from: 'laura', to: 'john',
    amountCents: 700, by: 'laura', proposedAt: '2026-07-27',
};

describe('§5.2 history page accumulation (mergeHistoryPages)', () => {
    it('appends an older page after the loaded entries', () => {
        const p1 = [hist({ id: 30, at: '2026-07-20' }), hist({ id: 20, at: '2026-07-10' })];
        const p2 = [hist({ id: 10, at: '2026-07-01' })];
        expect(mergeHistoryPages(p1, p2).map(e => e.id)).toEqual([30, 20, 10]);
    });

    it('drops duplicates by event id (refresh overlap / onEndReached double-fire)', () => {
        const p1 = [hist({ id: 30 }), hist({ id: 20 })];
        const overlap = [hist({ id: 20 }), hist({ id: 10 })];
        expect(mergeHistoryPages(p1, overlap).map(e => e.id)).toEqual([30, 20, 10]);
        // Re-applying the same page changes nothing.
        const merged = mergeHistoryPages(p1, overlap);
        expect(mergeHistoryPages(merged, overlap)).toBe(merged);
    });

    it('is pure — neither input array is mutated', () => {
        const p1 = [hist({ id: 30 })];
        const p2 = [hist({ id: 10 })];
        mergeHistoryPages(p1, p2);
        expect(p1.map(e => e.id)).toEqual([30]);
        expect(p2.map(e => e.id)).toEqual([10]);
    });
});

describe('§5.2 live-vs-confirmed settlement reconciliation', () => {
    it('a pending settlement confirmed in history renders ONCE — as the history row', () => {
        const lv = ledger({ pendingSettlements: [pendingAbc] });
        const feed = buildFamilyFeed([], lv, 77, [hist({ settlementId: 'abc' })]);
        expect(feed.map(e => e.kind)).toEqual(['history']);
        expect(feed[0]).toMatchObject({ key: 'hist:1' });
    });

    it('a settlement confirmed THIS SESSION is suppressed before the refetch lands', () => {
        const lv = ledger({ pendingSettlements: [pendingAbc] });
        const feed = buildFamilyFeed([], lv, 77, [], new Set(['abc']));
        expect(feed).toEqual([]);
    });

    it('an unrelated confirmed settlement does not touch a live pending one', () => {
        const lv = ledger({ pendingSettlements: [pendingAbc] });
        const feed = buildFamilyFeed([], lv, 77, [hist({ id: 2, settlementId: 'other' })]);
        expect(feed.map(e => e.kind)).toEqual(['settlement', 'history']);
    });
});

describe('§5.2 receipt-row dedup against trip cards', () => {
    const resolvedTrip = trip({ id: 9, anchorDate: '2026-07-10', receiptCount: 1 });

    it('cutoff day is the oldest RESOLVED family trip; pending/foreign trips do not count', () => {
        const pending = trip({ id: 2, stage: 3, receiptCount: 0, anchorDate: '2026-07-01' });
        const foreign = trip({ id: 3, anchorDate: '2026-06-01', basket: { id: 50, status: 'x', itemCount: 1 } });
        expect(historyReceiptCutoffDay([resolvedTrip, pending, foreign], 77)).toBe('2026-07-10');
        expect(historyReceiptCutoffDay([pending, foreign], 77)).toBe(null);
    });

    it('a receipt entry covered by a trip card is dropped; an older one renders', () => {
        const covered = hist({ id: 5, kind: 'receipt', at: '2026-07-15 09:00:00', settlementId: null });
        const older = hist({ id: 4, kind: 'receipt', at: '2026-07-05 09:00:00', settlementId: null });
        const feed = buildFamilyFeed([resolvedTrip], ledger({}), 77, [covered, older]);
        expect(feed.map(e => e.key)).toEqual(['trip:9', 'hist:4']);
    });

    it('with no trip cards at all every receipt entry renders (older-member / clipped list)', () => {
        const feed = buildFamilyFeed([], ledger({}), 77,
            [hist({ id: 5, kind: 'receipt', at: '2026-07-15', settlementId: null })]);
        expect(feed.map(e => e.key)).toEqual(['hist:5']);
    });

    it('non-receipt history kinds are never suppressed by trip coverage', () => {
        const joined = hist({ id: 6, kind: 'member_joined', at: '2026-07-15', amountCents: null, settlementId: null });
        const feed = buildFamilyFeed([resolvedTrip], ledger({}), 77, [joined]);
        expect(feed.map(e => e.key)).toEqual(['hist:6', 'trip:9']);
    });
});

describe('§5.2 merged ordering', () => {
    it('live rows pinned first, then trips and history interleaved newest-day first', () => {
        const lv = ledger({ pendingSettlements: [pendingAbc] });
        const trips = [
            trip({ id: 9, anchorDate: '2026-07-20' }),
            trip({ id: 8, anchorDate: '2026-07-10' }),
        ];
        const history = [
            // A DIFFERENT settlement (else it would rightly suppress set:abc).
            hist({ id: 3, at: '2026-07-15 10:00:00', settlementId: 'zzz' }),                   // between the trips
            hist({ id: 2, kind: 'member_left', at: '2026-07-05', amountCents: null, settlementId: null }),
        ];
        const feed = buildFamilyFeed(trips, lv, 77, history);
        expect(feed.map(e => e.key)).toEqual(['set:abc', 'trip:9', 'hist:3', 'trip:8', 'hist:2']);
    });

    it('same day: the trip card outranks the bookkeeping row', () => {
        const feed = buildFamilyFeed(
            [trip({ id: 9, anchorDate: '2026-07-10' })], ledger({}), 77,
            // The settlement is NOT one of the trips' receipts — same day only.
            [hist({ id: 3, at: '2026-07-10 23:00:00' })]);
        expect(feed.map(e => e.key)).toEqual(['trip:9', 'hist:3']);
    });
});

describe('§5.2 member strip', () => {
    const roster = [
        { userId: 'laura', label: 'Laura', avatarColor: '#f00', leaving: false },
        { userId: 'john', label: null, avatarColor: null, leaving: true },
    ];

    it('reads balances from the LEDGER (server-derived), zero when absent', () => {
        const strip = buildMemberStrip(roster, ledger({
            balances: { laura: -700 }, suggestedNextShopper: 'laura',
        }), 'Narys');
        expect(strip).toEqual([
            { userId: 'laura', label: 'Laura', avatarColor: '#f00', balanceCents: -700, suggested: true, leaving: false },
            { userId: 'john', label: 'Narys', avatarColor: null, balanceCents: 0, suggested: false, leaving: true },
        ]);
    });

    it('survives a missing ledger (all zero, nobody suggested)', () => {
        const strip = buildMemberStrip(roster, null, 'Narys');
        expect(strip.every(m => m.balanceCents === 0 && !m.suggested)).toBe(true);
    });
});
