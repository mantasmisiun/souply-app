import { API_BASE_URL } from '../config/api';

/**
 * FAMILY SHOPPING client (spec §3 + §5 + §7). Auth rides the global fetch
 * interceptor. Shapes mirror souply-api:
 *   · households/roster  — joinController.getOwnHousehold
 *   · ledger view        — householdMembership.getHouseholdLedgerView
 *   · settlements        — householdSettlementController
 *   · family receipt     — receiptFamilyScope.FamilyReceiptView
 *
 * MONEY IS INTEGER CENTS everywhere in this file (§1.3). Format for display
 * with utils/familyShopping.formatCents — never do arithmetic on a formatted
 * value, and never introduce a float field here.
 */

async function jsonOrThrow(res: Response): Promise<any> {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
}

// ── Household + roster (GET /households/mine) ────────────────────────────────

export interface FamilyMember {
    userId: string;
    role: 'owner' | 'member' | string;
    joinedAt: string;
    /** §3.2.2 — "leaving" is visible to EVERYONE, not just the leaver. */
    leaving: boolean;
    /** Display name (displayName > @username > firstName > own email local-part). */
    label: string | null;
    avatarColor: string | null;
}

export interface FamilyHousehold {
    id: number;
    name: string | null;
    /** The persistent shared basket — the family Basket tab's data source. */
    sharedBasketId: number | null;
    members: FamilyMember[];
}

/** null = the caller has no household (404). */
export const fetchFamilyHousehold = async (): Promise<FamilyHousehold | null> => {
    const res = await fetch(`${API_BASE_URL}/api/households/mine`);
    if (res.status === 404) return null;
    return jsonOrThrow(res);
};

// ── Ledger view (GET /households/mine/settlements) ───────────────────────────

export interface SettlementTransfer {
    /** Hands the money over. */
    from: string;
    /** Receives it. */
    to: string;
    amountCents: number;
}

export interface PendingSettlement {
    settlementId: string;
    from: string;
    to: string;
    amountCents: number;
    /** Who proposed it — the OTHER party is the one who may confirm (§3.2.1). */
    by: string;
    proposedAt: string;
}

export interface HouseholdLedgerView {
    householdId: number;
    /** The caller's balance. POSITIVE = is owed, NEGATIVE = owes (§1.2). */
    balanceCents: number;
    /** §3.2 — the minimal transfer set that clears the CALLER. */
    transfers: SettlementTransfer[];
    /** Balance per member id — includes departed members (always 0). */
    balances: Record<string, number>;
    pendingSettlements: PendingSettlement[];
    suggestedNextShopper: string | null;
    members: { userId: string; role: string; leaving: boolean }[];
    /** True once the caller has requested to leave (§3.2.2). */
    leaving: boolean;
}

/** null = the caller has no household (404). */
export const fetchHouseholdLedger = async (): Promise<HouseholdLedgerView | null> => {
    const res = await fetch(`${API_BASE_URL}/api/households/mine/settlements`);
    if (res.status === 404) return null;
    return jsonOrThrow(res);
};

// ── History feed (§5.2 — GET /households/mine/history) ───────────────────────

export type HistoryEntryKind =
    /** A family receipt entered the ledger (amountCents = FAMILY subtotal). */
    | 'receipt'
    /** A settlement was CONFIRMED. Proposals never appear here (§3.2.1) —
     *  the pending proposal is live state on the ledger view instead. */
    | 'settlement'
    | 'member_joined'
    | 'member_left'
    /** §4.4 — a post-lock re-categorisation, visible by design. */
    | 'adjustment';

export interface HistoryParty {
    userId: string;
    label: string;
}

export interface HouseholdHistoryEntry {
    /** Ledger event id — stable; the feed's React key. */
    id: number;
    at: string;
    kind: HistoryEntryKind;
    /** INTEGER CENTS or null when the entry carries no money. Never a receipt
     *  grand total — the ledger only holds family subtotals (§4.5). */
    amountCents: number | null;
    /** The payer / joiner / leaver / debtor / adjuster. */
    actor: HistoryParty | null;
    /** The other side, where one exists (a settlement's payee). */
    counterparty: HistoryParty | null;
    receiptId: number | null;
    settlementId: string | null;
    storeName: string | null;
    chainName: string | null;
    /** §4.4 audit reason — adjustments only. */
    reason: string | null;
    /** §4.4 — how the correction moved each member (sums to zero). */
    deltaByMember: Record<string, number> | null;
    /** Server-rendered Lithuanian sentence WITHOUT the amount ("Laura
     *  atsiskaitė su John") — the client owns money formatting (formatCents). */
    title: string;
    /** Secondary line: store, reason, or how a settlement was confirmed. */
    subtitle: string | null;
}

export interface HouseholdHistoryPage {
    householdId: number;
    /** Newest first. */
    entries: HouseholdHistoryEntry[];
    /** Keyset cursor for the next (older) page; null = end of the log. */
    nextCursor: string | null;
}

/** null = the caller has no household (404). Pass the previous page's
 *  nextCursor to read older entries; omit it for the newest page. */
export const fetchHouseholdHistory = async (
    cursor?: string | null,
): Promise<HouseholdHistoryPage | null> => {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const res = await fetch(`${API_BASE_URL}/api/households/mine/history${qs}`);
    if (res.status === 404) return null;
    return jsonOrThrow(res);
};

// ── Settlements (§3.2.1 — propose / confirm) ─────────────────────────────────

/** "Mark as settled" — writes settlement_proposed; moves NO money. */
export const proposeSettlement = async (
    transfer: SettlementTransfer,
): Promise<PendingSettlement> =>
    jsonOrThrow(await fetch(`${API_BASE_URL}/api/households/mine/settlements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(transfer),
    }));

/** COUNTERPARTY-only (server 403s the proposer). Moves the balance. */
export const confirmSettlement = async (settlementId: string): Promise<void> => {
    await jsonOrThrow(await fetch(
        `${API_BASE_URL}/api/households/mine/settlements/${encodeURIComponent(settlementId)}/confirm`,
        { method: 'POST' },
    ));
};

// ── Membership (§3.1 / §3.3 — leave / remove) ────────────────────────────────

/**
 * DELETE /households/mine/membership answers two ways (§3.1's balance gate):
 *   204  → gone (balance was zero). Returns null.
 *   200  → ACCEPTED but pending: the member is now "leaving", excluded from
 *          new trips, and the body carries the transfers that will clear them
 *          — exactly what the settle-and-leave dialog renders.
 */
export interface LeavePendingOutcome {
    status: 'leaving';
    balanceCents: number;
    transfers: SettlementTransfer[];
    blockedBy?: 'own-balance' | 'household-balances';
}

const departureOutcome = async (res: Response): Promise<LeavePendingOutcome | null> => {
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
};

export const requestLeaveHousehold = async (): Promise<LeavePendingOutcome | null> =>
    departureOutcome(await fetch(`${API_BASE_URL}/api/households/mine/membership`, { method: 'DELETE' }));

/** Owner-only: remove a member (same dual 200/204 contract as leaving). */
export const requestRemoveMember = async (memberUserId: string): Promise<LeavePendingOutcome | null> =>
    departureOutcome(await fetch(
        `${API_BASE_URL}/api/households/mine/members/${encodeURIComponent(memberUserId)}`,
        { method: 'DELETE' },
    ));

// ── Family receipt view (§4.5 — for a non-uploading member) ──────────────────

export interface FamilyReceiptItem {
    lineIdx: number;
    name: string;
    price: number | null;
    promoPrice: number | null;
    quantity: number | null;
    unit: string | null;
    amount: number | null;
    sizeUnit: string | null;
    isWeighable: boolean;
    storeProductId: number | null;
    matchedName: string | null;
    storeProductImageUrl: string | null;
    categoryId: number | null;
    categoryName: string | null;
    categoryL2Name: string | null;
    lineTotalCents: number;
}

export interface FamilyReceiptStats {
    itemCount: number;
    subtotalCents: number;
    promoItemCount: number;
    promoSavingsCents: number;
    categoryBreakdown: { name: string; totalCents: number }[];
}

export interface ScopeLockState {
    householdId: number | null;
    recorded: boolean;
    /** True once a toggle must go through a visible `adjustment` (§4.4). */
    locked: boolean;
    reason: string;
    windowClosesAt: string | null;
}

/**
 * §4.5 — family items ONLY: no personal items, no grand total, no image.
 * The uploader's own full view stays at GET /receipts/:id.
 */
export interface FamilyReceiptView {
    receiptId: number;
    tripId: number | null;
    householdId: number;
    storeName: string | null;
    chainName: string | null;
    receiptDate: string | null;
    uploadedAt: string;
    uploaderUserId: string;
    familyItems: FamilyReceiptItem[];
    familySubtotalCents: number;
    stats: FamilyReceiptStats;
    lock: ScopeLockState;
}

/** null = not found / not your household (the server 404s both, unprobeably). */
export const fetchFamilyReceipt = async (receiptId: number): Promise<FamilyReceiptView | null> => {
    const res = await fetch(`${API_BASE_URL}/api/receipts/${receiptId}/family`);
    if (res.status === 404) return null;
    return jsonOrThrow(res);
};

// ── Item scope (§4.1 one-tap / §4.2 bulk — the §7 Receipt screen uses this) ──

export interface ScopeChangeResult {
    receiptId: number;
    changedLineIdxs: number[];
    isPersonal: boolean;
    familySubtotalCents: number;
    previousFamilySubtotalCents: number | null;
    /** 'none' | 'restated' (pre-lock) | 'adjusted' (post-lock, visible §4.4). */
    ledger: 'none' | 'restated' | 'adjusted';
    adjustment: { reason: string; deltaByMember: Record<string, number> } | null;
    lock: ScopeLockState;
}

export const setFamilyReceiptScope = async (
    receiptId: number,
    scope: 'family' | 'personal',
    lineIdxs: number[],
): Promise<ScopeChangeResult> =>
    jsonOrThrow(await fetch(`${API_BASE_URL}/api/receipts/${receiptId}/family/scope`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, lineIdxs }),
    }));

// ── §7 "Convert to family shopping" ─────────────────────────────────────────

export interface TripConversionRecord {
    receiptId: number;
    /** The receipt's UPLOADER — never the converter (nobody is credited with
     *  money they did not spend). */
    payer: string;
    /** §4.3 — the FAMILY subtotal that entered the ledger, integer cents. */
    amountCents: number;
    alreadyRecorded: boolean;
}

export interface TripConversionResult {
    tripId: number;
    householdId: number;
    /** §1.1 — the set frozen onto every receipt this conversion recorded. */
    participants: string[];
    recorded: TripConversionRecord[];
    /** Receipts left OUT of the ledger: their uploader is not an eligible
     *  member of this household, so there is no payer to credit. */
    skipped: { receiptId: number; reason: 'payer-not-eligible' }[];
}

/**
 * POST /trips/:id/convert-to-family — spec §7's menu action, for real.
 *
 * This USED TO BE device-local AsyncStorage state (state/familyTripStore.ts,
 * now deleted): the section and the toggles appeared, and nothing reached the
 * ledger or any other member. The server is the source of truth now — on
 * success the trip carries `householdId` and the screen's family mode follows
 * from that, exactly like a trip born from the shared family basket.
 *
 * ONE-WAY. There is no un-convert, by design: the ledger is append-only and
 * members may already have settled against the balances a conversion created.
 * The server refuses a second convert with 409.
 *
 * Throws on failure (including 409 already-family / 403 not yours) — the caller
 * must not pretend it worked, which is the whole bug this replaces.
 */
export const convertTripToFamily = async (tripId: number): Promise<TripConversionResult> =>
    jsonOrThrow(await fetch(`${API_BASE_URL}/api/trips/${tripId}/convert-to-family`, {
        method: 'POST',
    }));
