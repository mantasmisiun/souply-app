import { API_BASE_URL } from '../config/api';

/**
 * Souply 2.0 trips client (Apsipirkimai tab). Auth rides the global fetch
 * interceptor. Shapes mirror souply-api's tripListService.TripSummary.
 */

export interface TripSlot {
    listId: number;
    storeId: number;
    storeName: string | null;
    chainName: string | null;
    chainId: number | null;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    listStatus: 'active' | 'completed';
    hasReceipt: boolean;
    receiptSkipped: boolean;
    checkedCount: number;
    itemCount: number;
}

export interface TripSummary {
    id: number;
    name: string | null;
    isAdHoc: boolean;
    scoreExempt: boolean;
    archivedAt: string | null;
    createdAt: string;
    stage: 1 | 2 | 3 | 4 | 5;
    memberCount: number;
    /** Trip owner/creator — the client uses this to decide who may moderate
     *  (remove another member's receipt from the trip). */
    ownerUserId: string;
    /** Member avatar previews (owner first) for the stacked circles on shared cards. */
    members?: { initial: string; color: string | null }[];
    anchorDate: string;
    basket: {
        id: number; status: string; itemCount: number;
        /** User-given basket name (renames replace the date title). */
        name?: string | null;
        /** Newest-first item-name preview (max 5). */
        itemPreview?: string[];
    } | null;
    slots: TripSlot[];
    receiptCount: number;
}

async function jsonOrThrow(res: Response): Promise<any> {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
}

export interface TripReceiptItem {
    /** ReceiptItem row id — links a line to the planning-score classification. */
    id: number;
    lineIdx: number;
    name: string;
    price: number | null;
    quantity: number | null;
    unit: string | null;
    /** Pack size label (e.g. "400 g") when known — drives "2 × 400 g" merges. */
    sizeUnit: string | null;
    /** Matched store-product id — the grouping key for merging duplicate lines. */
    matchedSpId: number | null;
    matchedName: string | null;
    storeProductImageUrl: string | null;
    /** promo-adjusted line total (the ACTUAL price paid) — price × qty. */
    lineTotal: number | null;
}

export interface TripReceipt {
    id: number;
    storeId: number | null;
    storeName: string | null;
    storeAddress: string | null;
    chainName: string | null;
    chainId: number | null;
    receiptDate: string | null;
    processingStatus: string | null;
    /** The receipt's OWN printed footer total (what the user paid) — the truth the
     *  detail card shows, vs a line-item sum a mis-parsed line can skew. Null when
     *  the total wasn't readable. */
    printedTotal: number | null;
    mandatorySwipesRequired: number;
    mandatorySwipesCompleted: number;
    /** Who uploaded it — the sheet shows delete only to the uploader. */
    uploaderUserId: string;
    /** 1 when the purchase date is >30 days old — a stale-receipt flag shown to
     *  all trip members (red badge + red note). */
    staleReceipt?: number;
    /** Low scan quality (unreadable-line fraction OR a reconciliation gap) →
     *  offer a retake/heal. `unmatchedCount` is the user-facing "N unrecognised". */
    lowQuality?: boolean;
    unmatchedCount?: number;
    items: TripReceiptItem[];
}

export const fetchTripReceipts = async (tripId: number): Promise<TripReceipt[]> =>
    jsonOrThrow(await fetch(`${API_BASE_URL}/api/trips/${tripId}/receipts`));

/** "Wrong receipt" — detach from the trip (server enforces the time window). */
export const detachTripReceipt = async (tripId: number, receiptId: number): Promise<void> => {
    await jsonOrThrow(await fetch(`${API_BASE_URL}/api/trips/${tripId}/receipts/${receiptId}`, { method: 'DELETE' }));
};

export const fetchTrips = async (): Promise<TripSummary[]> =>
    jsonOrThrow(await fetch(`${API_BASE_URL}/api/trips`));

export const archiveTrip = async (id: number): Promise<void> => {
    await jsonOrThrow(await fetch(`${API_BASE_URL}/api/trips/${id}/archive`, { method: 'POST' }));
};

export const unarchiveTrip = async (id: number): Promise<void> => {
    await jsonOrThrow(await fetch(`${API_BASE_URL}/api/trips/${id}/unarchive`, { method: 'POST' }));
};

// ── Household (the "Sukurti šeimos sąrašą" card) ─────────────────────────────

export interface HouseholdInfo {
    id: number;
    name: string | null;
    role: string;
    sharedBasketId: number | null;
    members: { userId: string; role: string; joinedAt: string; label?: string | null; avatarColor?: string | null }[];
}

export const fetchOwnHousehold = async (): Promise<HouseholdInfo | null> => {
    const res = await fetch(`${API_BASE_URL}/api/households/mine`);
    if (res.status === 404) return null;
    return jsonOrThrow(res);
};

export const createOwnHousehold = async (name?: string): Promise<{ householdId: number; sharedBasketId: number }> =>
    jsonOrThrow(await fetch(`${API_BASE_URL}/api/households`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(name ? { name } : {}),
    }));

/** Returns the join URL to encode in the QR (web landing + app-link chain). */
export const createHouseholdInviteUrl = async (): Promise<string> => {
    const r = await jsonOrThrow(await fetch(`${API_BASE_URL}/api/households/mine/invites`, { method: 'POST' }));
    return `https://souply.lt/join/${r.code}`;
};

/** Addressed household invite: registered user → in-app notification; unknown
 *  email → branded invite email. Oracle-free response either way. */
export const sendAddressedHouseholdInvite = async (
    target: { email?: string; handle?: string },
): Promise<void> => {
    await jsonOrThrow(await fetch(`${API_BASE_URL}/api/households/mine/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
    }));
};

/** Leave the current household (last member leaving dissolves it). */
export const leaveHousehold = async (): Promise<void> => {
    const res = await fetch(`${API_BASE_URL}/api/households/mine/membership`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
};

/** Owner-only: remove a member from the own household. */
export const removeHouseholdMember = async (memberUserId: string): Promise<void> => {
    const res = await fetch(`${API_BASE_URL}/api/households/mine/members/${encodeURIComponent(memberUserId)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
};

/** Trip invite QR value (web landing + app-link chain), member-gated. */
export const createTripInviteUrl = async (tripId: number): Promise<string> => {
    const r = await jsonOrThrow(await fetch(`${API_BASE_URL}/api/trips/${tripId}/invites`, { method: 'POST' }));
    return `https://souply.lt/join/${r.code}`;
};

/** Addressed invite: registered user → in-app notification; unknown email →
 *  branded invite email. Oracle-free response either way. */
export const sendAddressedTripInvite = async (
    tripId: number,
    target: { email?: string; handle?: string },
): Promise<void> => {
    await jsonOrThrow(await fetch(`${API_BASE_URL}/api/trips/${tripId}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
    }));
};

export interface TripMemberInfo { userId: string; role: 'owner' | 'member'; label: string; avatarColor?: string | null; }

export const fetchTripMembers = async (tripId: number): Promise<TripMemberInfo[]> => {
    const r = await jsonOrThrow(await fetch(`${API_BASE_URL}/api/trips/${tripId}/members`));
    return r.members ?? [];
};

/** Owner-only: remove a member (bans rejoin via member-created invites). */
export const removeTripMember = async (tripId: number, userId: string): Promise<void> => {
    const res = await fetch(`${API_BASE_URL}/api/trips/${tripId}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
};

export interface TripStats {
    tripId: number;
    savedVsMedian: number | null;
    couldHaveSaved: number | null;
    receiptCount: number;
    totalSpent: number;
    /** Live avg-across-stores minus paid (the saved/overpaid metric). */
    savings: number;
    promoItemCount: number;
    promoSavings: number;
    categoryBreakdown: { categoryName: string; total: number }[];
    chainBreakdown: { chainName: string; total: number }[];
    memberSpend: { userId: string; name: string | null; avatarColor: string | null; total: number; receiptCount: number }[];
}

export const fetchTripStats = async (tripId: number): Promise<TripStats> =>
    jsonOrThrow(await fetch(`${API_BASE_URL}/api/trips/${tripId}/stats`));

export interface TripSpendEntry { tripId: number; name: string | null; anchorDate: string; totalSpent: number }

/** Per-trip spend for a month (default current) — the "Kelionės" donut. */
export const fetchMonthlyTripSpend = async (month?: string): Promise<TripSpendEntry[]> =>
    jsonOrThrow(await fetch(`${API_BASE_URL}/api/trips/spend${month ? `?month=${month}` : ''}`));

export interface PlanningScoreMonth { month: string; score: number | null; tripCount: number; adHocCount: number }

export const fetchMonthlyPlanningScore = async (): Promise<PlanningScoreMonth[]> =>
    jsonOrThrow(await fetch(`${API_BASE_URL}/api/planning-score/monthly`));

export interface TripScore {
    tripId: number;
    score: number | null;
    coverage: number;
    discipline: number;
    /** Store-choice quality (0..1, 1 = cheapest available for the basket); null
     *  when there's no informative cross-store comparison. */
    storeChoice: number | null;
    /** € a perfect store-chooser would have saved (paid − cheapest); null when
     *  storeChoice is null. */
    storeHeadroomEur: number | null;
    /** Whether the trip had a shopping list — drives the "reikia plano" empty
     *  state on the coverage/discipline bars for ad-hoc trips. */
    hasList: boolean;
    isAdHoc: boolean;
    listItemCount: number;
    matchedListItemCount: number;
    /** Stats-card counts (fuzzy product/name/L3 match; extra qty NOT impulse). */
    impulseCount: number;
    forgottenCount: number;
    /** € spent on impulse (non-list) receipt lines. */
    impulseEur: number;
    /** % delta of this score vs the user's recent-median planning score; null
     *  when there aren't enough prior trips to compare. */
    deltaPct: number | null;
    /** Prediction accuracy: predicted (list) vs actual (receipt) over matched
     *  priced items; null → hide the prediction card. */
    predictedMatchedTotal: number | null;
    actualMatchedTotal: number | null;
    pairs: {
        listItemId: number; receiptItemId: number; source: 'auto' | 'manual'; productName: string | null;
        /** Planned vs bought display names (differ when matched to two product
         *  rows) + list-side image aggregate for the Prognozė sheet. */
        listName: string | null; receiptName: string | null;
        imageUrls: string | (string | null)[] | null;
        isWeighable: boolean; canonicalStep: number | null;
        /** Predicted (list) vs actual (receipt) LINE totals + quantities — feeds
         *  the Prognozė sheet's per-item forecast rows. listPrice is null when the
         *  plan item had no calculated price. */
        listPrice: number | null; receiptPrice: number; listQty: number; receiptQty: number;
    }[];
    unmatchedListItems: { listItemId: number; name: string | null }[];
    unmatchedReceiptItems: { receiptItemId: number; name: string }[];
    /** ANY-MATCH impulse receipt-item ids — flags each Kvitai card in the Impulse
     *  sheet ✓ planned / ✗ impulse (same rule as impulseCount). */
    impulseReceiptItemIds: number[];
    /** Every plan item classified bought / missed, with render data for the
     *  Missed sheet. */
    listItemsDetail: { listItemId: number; name: string; imageUrls: string | (string | null)[] | null; quantity: number; isWeighable: boolean; canonicalStep: number | null; bought: boolean }[];
}

export const fetchTripScore = async (tripId: number): Promise<TripScore> =>
    jsonOrThrow(await fetch(`${API_BASE_URL}/api/trips/${tripId}/score`));

/** Cross-store basket comparison for the Sutaupyta/Išsvaistyta sheet. */
export interface TripComparisonStore {
    chainId: number;
    chainName: string;
    chainLogoUrl: string | null;
    total: number;
    yours: boolean;
}
export interface TripComparison {
    stores: TripComparisonStore[];
    yoursTotal: number;
    cheapestTotal: number;
    medianTotal: number;
    /** Cheapest store's chain name; null when you were the cheapest. */
    cheaperStoreName: string | null;
    /** medianTotal − yoursTotal (+ saved vs average / − overpaid). */
    savedVsAvg: number;
    /** yoursTotal − cheapestTotal (≥0). */
    headroom: number;
    /** The system couldn't differentiate store prices (imputed/flat) → show the
     *  "couldn't compare" message instead of a savings claim. */
    equalPrices: boolean;
}

export const fetchTripComparison = async (tripId: number): Promise<TripComparison> =>
    jsonOrThrow(await fetch(`${API_BASE_URL}/api/trips/${tripId}/comparison`));
