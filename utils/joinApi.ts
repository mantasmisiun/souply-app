import { API_BASE_URL } from '../config/api';

/**
 * Souply 2.0 invite claim client — the /join/:code preview→claim flow
 * (trip + household QR/link invites). Auth rides the global fetch
 * interceptor (session Bearer), which is all these endpoints need:
 * the code itself is the capability.
 */

export interface JoinPreview {
    scope: 'trip' | 'household';
    name: string | null;
    memberCount: number;
    alreadyMember: boolean;
    /** household scope only — claiming would 409 until the user leaves. */
    hasOwnHousehold?: boolean;
}

export type JoinClaimResult =
    | { scope: 'trip'; tripId: number; alreadyMember: boolean }
    | { scope: 'household'; householdId: number; alreadyMember: boolean };

/** Thrown on claim 409 — the user must leave their current household first. */
export class HouseholdExistsError extends Error {
    currentHouseholdId: number | null;
    constructor(currentHouseholdId: number | null) {
        super('household-exists');
        this.name = 'HouseholdExistsError';
        this.currentHouseholdId = currentHouseholdId;
    }
}

async function jsonOrThrow(res: Response): Promise<any> {
    if (!res.ok) {
        let detail = '';
        try { detail = JSON.stringify(await res.json()); } catch {}
        throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
    }
    if (res.status === 204) return null;
    return res.json();
}

export async function fetchJoinPreview(code: string): Promise<JoinPreview> {
    const res = await fetch(`${API_BASE_URL}/api/join/${encodeURIComponent(code)}/preview`);
    return jsonOrThrow(res);
}

export async function claimJoin(code: string): Promise<JoinClaimResult> {
    const res = await fetch(`${API_BASE_URL}/api/join/${encodeURIComponent(code)}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    });
    if (res.status === 409) {
        let body: any = null;
        try { body = await res.json(); } catch {}
        if (body?.error === 'household-exists') {
            throw new HouseholdExistsError(body?.currentHouseholdId ?? null);
        }
    }
    return jsonOrThrow(res);
}

/** Leave the current household (retry path for HouseholdExistsError). */
export async function leaveOwnHousehold(): Promise<void> {
    await jsonOrThrow(await fetch(`${API_BASE_URL}/api/households/mine/membership`, { method: 'DELETE' }));
}
