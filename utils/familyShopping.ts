import type {
    HouseholdHistoryEntry, HouseholdLedgerView, PendingSettlement,
} from './familyShoppingApi';
import type { TripSummary } from './tripsApi';

/**
 * FAMILY SHOPPING — the pure logic behind app/family/index.tsx (spec §5),
 * kept out of the screen so it is unit-testable:
 *   · §5.1 select-all state transitions (modelled as the UNCHECKED set)
 *   · §1.3 cents display formatting (presentation ONLY — cents stay the truth)
 *   · §3.2.1 the "who may confirm a settlement" rule
 *   · §5.2 history-feed assembly from trips + the ledger view
 */

// ── §5.1 Selection — modelled as the UNCHECKED id set ────────────────────────
// "Checked by default" then means the EMPTY set, and items that arrive on a
// refetch are born checked with no reconciliation step.

/** The "Select all" checkbox is checked ⇔ nothing is unchecked (and the list
 *  isn't empty — an empty list has nothing to select). */
export const isAllSelected = (itemCount: number, unchecked: ReadonlySet<number>): boolean =>
    itemCount > 0 && unchecked.size === 0;

/** One item's checkbox: checked ⇔ not in the unchecked set. */
export const isItemSelected = (unchecked: ReadonlySet<number>, id: number): boolean =>
    !unchecked.has(id);

/** Toggle one item. Unchecking any item drops "Select all"; re-checking the
 *  last unchecked one restores it (both fall out of isAllSelected). */
export const toggleItem = (unchecked: ReadonlySet<number>, id: number): Set<number> => {
    const next = new Set(unchecked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
};

/** The "Select all" tap: all currently selected → uncheck everything;
 *  anything else (some or none selected) → select everything. */
export const toggleSelectAll = (unchecked: ReadonlySet<number>, allIds: number[]): Set<number> =>
    isAllSelected(allIds.length, unchecked) ? new Set(allIds) : new Set();

/** After a refetch: forget unchecked ids that no longer exist (removed items
 *  must not silently hold "Select all" off), keep the user's choices for the
 *  rest. New ids are absent from the set — i.e. checked by default. */
export const pruneSelection = (unchecked: ReadonlySet<number>, allIds: number[]): Set<number> => {
    const live = new Set(allIds);
    return new Set([...unchecked].filter(id => live.has(id)));
};

export const selectedCount = (allIds: number[], unchecked: ReadonlySet<number>): number =>
    allIds.reduce((n, id) => n + (unchecked.has(id) ? 0 : 1), 0);

// ── §1.3 Cents formatting (display ONLY) ─────────────────────────────────────

/** 700 → "€7.00". Always two decimals; never used for arithmetic. */
export const formatCents = (cents: number): string =>
    `€${(Math.abs(cents) / 100).toFixed(2)}`;

/**
 * Signed balance for the member strip (§5.2): "Laura −€7.00", "John +€7.00".
 * Zero renders unsigned. U+2212 minus, not a hyphen — it matches the spec's
 * examples and reads as maths, not a dash.
 */
export const formatBalanceCents = (cents: number): string => {
    if (cents === 0) return '€0.00';
    return `${cents > 0 ? '+' : '−'}${formatCents(cents)}`;
};

// ── §3.2.1 Who may confirm ───────────────────────────────────────────────────

/**
 * ONLY the counterparty may confirm: a party to the settlement who is NOT the
 * proposer. The proposer must see no confirm affordance for their own
 * proposal — otherwise mutual confirmation is decorative.
 */
export const mayConfirmSettlement = (
    s: Pick<PendingSettlement, 'from' | 'to' | 'by'>,
    userId: string | null,
): boolean =>
    userId != null && userId !== s.by && (userId === s.from || userId === s.to);

// ── §5.2 History feed ────────────────────────────────────────────────────────

export type FamilyFeedEntry =
    /** A settlement awaiting confirmation (actionable for the counterparty). */
    | { kind: 'settlement'; key: string; settlement: PendingSettlement }
    /** A member in the "leaving" state (§3.2.2 — visible to everyone). */
    | { kind: 'leaving'; key: string; userId: string }
    /** A family trip in progress — no receipt yet, affects no balances. */
    | { kind: 'pendingTrip'; key: string; trip: TripSummary }
    /** A resolved family trip (receipt uploaded) — CTA "Stats ›". */
    | { kind: 'trip'; key: string; trip: TripSummary }
    /** A past ledger event from GET /households/mine/history (§5.2). */
    | { kind: 'history'; key: string; entry: HouseholdHistoryEntry };

/**
 * A trip belongs to the family iff the SERVER says so — `Trip.householdId` —
 * with the shared basket as a fallback signal.
 *
 * THE HOUSEHOLD ID HAD TO COME FIRST once §7's "Convert to family shopping"
 * became a real endpoint. A converted trip grew out of a PERSONAL basket, so
 * the shared-basket test alone missed it: no trip card, and — worse — its
 * ledger `receipt` row was then suppressed too, because
 * `historyReceiptCutoffDay` drops history rows inside the trip cards' coverage
 * window. A conversion made today would have moved everyone's balance while
 * the feed showed nothing that explained it.
 *
 * The basket clause STAYS as an OR, not as a replacement: `Trip.householdId`
 * was never written until the family work landed (see tripLinkService's
 * `ensureTripForBasket`), so trips created from the shared basket before then
 * carry NULL and are recognised only by their basket.
 */
export const isFamilyTrip = (trip: TripSummary, sharedBasketId: number | null): boolean =>
    trip.householdId != null
    || (sharedBasketId != null && trip.basket?.id === sharedBasketId);

/** "Started but no receipt yet" (§5.2) — lists exist / shopping is underway. */
const isPendingTrip = (trip: TripSummary): boolean =>
    trip.receiptCount === 0 && trip.stage >= 3;

/**
 * Accumulate one history page onto the already-loaded entries, deduped by the
 * stable event id. Order is preserved (existing first — pages arrive newest →
 * older), so a page that overlaps a refresh, or an onEndReached double-fire,
 * cannot duplicate a row. Pure; never mutates the inputs.
 */
export const mergeHistoryPages = (
    existing: HouseholdHistoryEntry[],
    incoming: HouseholdHistoryEntry[],
): HouseholdHistoryEntry[] => {
    const seen = new Set(existing.map(e => e.id));
    const fresh = incoming.filter(e => !seen.has(e.id));
    return fresh.length === 0 ? existing : [...existing, ...fresh];
};

/** Day (YYYY-MM-DD) of a trip anchorDate or a history `at` — both start with
 *  the day regardless of whether a time / T-separator follows. */
const dayOf = (stamp: string | null | undefined): string => String(stamp ?? '').slice(0, 10);

/**
 * §4.5-shaped dedup between the two sources of "a family shop happened":
 * a resolved family TRIP CARD (rich: calendar, chains, "Stats ›") and the
 * ledger's `receipt` history entry. TripSummary exposes no receipt ids, so an
 * exact receiptId→trip join is impossible client-side; instead the trip cards
 * are taken as covering their era, and a `receipt` history row renders only
 * when it is strictly OLDER (by day) than the oldest resolved family trip
 * card. This also reads correctly for a member who joined later: pre-join
 * trips are not in their trips list, so those shops surface as history rows.
 */
export const historyReceiptCutoffDay = (
    trips: TripSummary[],
    sharedBasketId: number | null,
): string | null => {
    let oldest: string | null = null;
    for (const tr of trips) {
        if (!isFamilyTrip(tr, sharedBasketId) || tr.stage < 3 || isPendingTrip(tr)) continue;
        const day = dayOf(tr.anchorDate);
        if (oldest == null || day < oldest) oldest = day;
    }
    return oldest;
};

/**
 * Assemble the History feed. LIVE state is pinned first — pending settlements
 * (actionable), then leaving members — followed by the past: family trip cards
 * and history rows merged newest-first by day. Trips in stages 1–2 are the
 * CURRENT basket being planned — that is the Basket tab, not history — so they
 * are excluded.
 *
 * Reconciliation (the log wins):
 *   · A pending settlement whose settlementId already appears in history as
 *     CONFIRMED is dropped — the two must never render as contradictory rows.
 *     `suppressedSettlementIds` extends the same rule to settlements confirmed
 *     in this session whose history refetch hasn't landed yet.
 *   · `receipt` history rows inside the trip cards' coverage window are
 *     dropped in favour of the richer TripCard (see historyReceiptCutoffDay).
 *   · A LIVE "leaving" row and a later `member_left` history row are different
 *     facts (announced vs happened) and never coexist for the same member —
 *     the ledger drops `leaving` the moment the departure completes.
 */
export const buildFamilyFeed = (
    trips: TripSummary[],
    ledger: HouseholdLedgerView | null,
    sharedBasketId: number | null,
    history: HouseholdHistoryEntry[] = [],
    suppressedSettlementIds?: ReadonlySet<string>,
): FamilyFeedEntry[] => {
    const out: FamilyFeedEntry[] = [];

    const confirmedIds = new Set(
        history.filter(e => e.kind === 'settlement' && e.settlementId != null)
            .map(e => e.settlementId as string));
    for (const s of ledger?.pendingSettlements ?? []) {
        if (confirmedIds.has(s.settlementId) || suppressedSettlementIds?.has(s.settlementId)) continue;
        out.push({ kind: 'settlement', key: `set:${s.settlementId}`, settlement: s });
    }
    for (const m of ledger?.members ?? []) {
        if (m.leaving) out.push({ kind: 'leaving', key: `leave:${m.userId}`, userId: m.userId });
    }

    const dated: { day: string; entry: FamilyFeedEntry }[] = [];
    for (const tr of trips) {
        if (!isFamilyTrip(tr, sharedBasketId) || tr.stage < 3) continue;
        dated.push({
            day: dayOf(tr.anchorDate),
            entry: isPendingTrip(tr)
                ? { kind: 'pendingTrip', key: `pend:${tr.id}`, trip: tr }
                : { kind: 'trip', key: `trip:${tr.id}`, trip: tr },
        });
    }
    const cutoff = historyReceiptCutoffDay(trips, sharedBasketId);
    for (const e of history) {
        if (e.kind === 'receipt' && cutoff != null && dayOf(e.at) >= cutoff) continue;
        dated.push({ day: dayOf(e.at), entry: { kind: 'history', key: `hist:${e.id}`, entry: e } });
    }
    // Newest day first; within a day trip cards above history rows (the shop
    // outranks the bookkeeping), then newest id first (both id spaces grow
    // with time, so within a source id order IS time order).
    const rank = (e: FamilyFeedEntry): number => (e.kind === 'history' ? 1 : 0);
    const idOf = (e: FamilyFeedEntry): number =>
        e.kind === 'history' ? e.entry.id : e.kind === 'settlement' || e.kind === 'leaving' ? 0 : e.trip.id;
    dated.sort((a, b) =>
        b.day.localeCompare(a.day)
        || rank(a.entry) - rank(b.entry)
        || idOf(b.entry) - idOf(a.entry));
    for (const d of dated) out.push(d.entry);
    return out;
};

/**
 * The member strip's model (§5.2): every ACTIVE member with a resolved label,
 * colour and balance, the suggested next shopper flagged. Balance source is
 * the LEDGER (derived server-side); roster label/colour come from the
 * household. Members missing from the roster (shouldn't happen) still render,
 * as an id-less fallback would hide money.
 */
export interface MemberStripEntry {
    userId: string;
    label: string;
    avatarColor: string | null;
    balanceCents: number;
    suggested: boolean;
    leaving: boolean;
}

export const buildMemberStrip = (
    roster: { userId: string; label: string | null; avatarColor: string | null; leaving: boolean }[],
    ledger: HouseholdLedgerView | null,
    fallbackLabel: string,
): MemberStripEntry[] =>
    roster.map(m => ({
        userId: m.userId,
        label: m.label ?? fallbackLabel,
        avatarColor: m.avatarColor,
        balanceCents: ledger?.balances[m.userId] ?? 0,
        suggested: ledger?.suggestedNextShopper === m.userId,
        leaving: m.leaving,
    }));
