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
    lineIdx: number;
    name: string;
    price: number | null;
    quantity: number | null;
    unit: string | null;
    matchedName: string | null;
    storeProductImageUrl: string | null;
    /** promo-adjusted line total (matches the Stats hero) — price × qty. */
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
    mandatorySwipesRequired: number;
    mandatorySwipesCompleted: number;
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
    members: { userId: string; role: string; joinedAt: string }[];
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
    precision: number;
    isAdHoc: boolean;
    listItemCount: number;
    matchedListItemCount: number;
    /** Stats-card counts (fuzzy product/name/L3 match; extra qty NOT impulse). */
    impulseCount: number;
    forgottenCount: number;
    /** Prediction accuracy: predicted (list) vs actual (receipt) over matched
     *  priced items; null → hide the prediction card. */
    predictedMatchedTotal: number | null;
    actualMatchedTotal: number | null;
    pairs: { listItemId: number; receiptItemId: number; source: 'auto' | 'manual'; productName: string | null }[];
    unmatchedListItems: { listItemId: number; name: string | null }[];
    unmatchedReceiptItems: { receiptItemId: number; name: string }[];
}

export const fetchTripScore = async (tripId: number): Promise<TripScore> =>
    jsonOrThrow(await fetch(`${API_BASE_URL}/api/trips/${tripId}/score`));
