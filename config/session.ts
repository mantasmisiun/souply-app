import * as SecureStore from 'expo-secure-store';

/**
 * Active session token for the API. The server now requires a Bearer token on every
 * per-user route (receipts, swipe votes) — see souply-api middleware/sessionAuth. The
 * global fetch interceptor injects whatever `getActiveSessionToken()` returns.
 *
 * Two slots, checked verified-first:
 *   - verifiedToken: the OAuth session JWT (authState) — set on sign-in, cleared on logout.
 *   - anonToken:     the anonymous session JWT minted by POST /api/users on first launch.
 * A signed-in user sends their verified token; everyone else sends their anonymous one.
 *
 * The in-memory copies make the token available to the SYNCHRONOUS fetch interceptor; the
 * anonymous token is also persisted so it survives restarts without a round-trip.
 */

const ANON_TOKEN_KEY = 'souply_anon_session_token';

let verifiedToken: string | null = null;
let anonToken: string | null = null;

/** The token the interceptor should send: verified account token wins, else anonymous. */
export function getActiveSessionToken(): string | null {
    return verifiedToken ?? anonToken;
}

/** authState calls this on hydrate/sign-in (token) and logout (null). */
export function setVerifiedSessionToken(token: string | null): void {
    verifiedToken = token;
}

/** In-memory anonymous token (set by the bootstrap after load/mint). */
export function setAnonSessionTokenMem(token: string | null): void {
    anonToken = token;
}

export async function loadPersistedAnonToken(): Promise<string | null> {
    try {
        return await SecureStore.getItemAsync(ANON_TOKEN_KEY);
    } catch {
        return null;
    }
}

export async function saveAnonSessionToken(token: string): Promise<void> {
    anonToken = token;
    try {
        await SecureStore.setItemAsync(ANON_TOKEN_KEY, token);
    } catch {
        /* keychain unavailable — in-memory copy still serves this session */
    }
}

export async function clearAnonSessionToken(): Promise<void> {
    anonToken = null;
    try {
        await SecureStore.deleteItemAsync(ANON_TOKEN_KEY);
    } catch {
        /* ignore */
    }
}
