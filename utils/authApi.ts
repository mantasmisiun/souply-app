import { API_BASE_URL } from '../config/api';
import { useAuthState, type VerifiedUser } from '../state/authState';
import { getUserId } from '../config/user';

type Provider = 'google' | 'apple';

export interface OauthResponse {
    token: string;
    action: 'linked' | 'loginExisting';
    user: VerifiedUser;
}

export async function exchangeOauthToken(opts: {
    provider: Provider;
    idToken: string;
    anonymousUserId: string;
}): Promise<OauthResponse> {
    const res = await fetch(`${API_BASE_URL}/api/auth/oauth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
    });
    if (!res.ok) {
        let detail = '';
        try { detail = JSON.stringify(await res.json()); } catch {}
        throw new Error(`oauth HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
    }
    return res.json();
}

/**
 * Fetch wrapper that injects the Bearer JWT from auth state when
 * present. Use for verified-only endpoints (publish wall, profile
 * edits). Anonymous calls keep using plain `fetch`.
 */
export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const token = useAuthState.getState().token;
    const headers = new Headers(init.headers);
    if (token && !headers.has('authorization')) {
        headers.set('authorization', `Bearer ${token}`);
    }
    // X-User-Id lets endpoints that fall back to callerId (profile, avatar)
    // authenticate the caller's OWN id even without a verified session (dev).
    if (!headers.has('x-user-id')) {
        try { headers.set('x-user-id', await getUserId()); } catch {}
    }
    return fetch(input, { ...init, headers });
}

// ── Username flow ─────────────────────────────────────────────────────────

export type UsernameRejectReason =
    | 'too-short' | 'too-long' | 'bad-format' | 'reserved'
    | 'taken' | 'rate-limited';

export async function checkUsernameAvailability(candidate: string): Promise<{
    available: boolean;
    reason?: UsernameRejectReason;
}> {
    const res = await authedFetch(`${API_BASE_URL}/api/users/username-available?u=${encodeURIComponent(candidate)}`);
    if (!res.ok) return { available: false, reason: 'bad-format' };
    return res.json();
}

export async function patchProfileFields(opts: { displayName?: string; bio?: string; firstName?: string; lastName?: string; avatarColor?: string | null }): Promise<boolean> {
    const res = await authedFetch(`${API_BASE_URL}/api/users/me/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
    });
    return res.ok;
}

export async function uploadAvatar(base64: string, mimeType: string): Promise<string | null> {
    const res = await authedFetch(`${API_BASE_URL}/api/users/me/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mimeType }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.avatarUrl ?? null;
}

export async function setUsername(candidate: string): Promise<{ ok: true; username: string } | { ok: false; reason: UsernameRejectReason }> {
    const res = await authedFetch(`${API_BASE_URL}/api/users/me/username`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: candidate }),
    });
    if (res.ok) {
        const data = await res.json();
        return { ok: true, username: String(data.username) };
    }
    let reason: UsernameRejectReason = 'bad-format';
    try {
        const body = await res.json();
        if (body && typeof body.error === 'string') reason = body.error as UsernameRejectReason;
    } catch {}
    return { ok: false, reason };
}
