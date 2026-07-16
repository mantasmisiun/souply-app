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
    anchorDate: string;
    basket: { id: number; status: string; itemCount: number } | null;
    slots: TripSlot[];
    receiptCount: number;
}

async function jsonOrThrow(res: Response): Promise<any> {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
}

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

/** Trip invite QR value (web landing + app-link chain), member-gated. */
export const createTripInviteUrl = async (tripId: number): Promise<string> => {
    const r = await jsonOrThrow(await fetch(`${API_BASE_URL}/api/trips/${tripId}/invites`, { method: 'POST' }));
    return `https://souply.lt/join/${r.code}`;
};
