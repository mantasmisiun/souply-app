/**
 * Auth state — Pass B.4.
 *
 * Stores the verified-user JWT in expo-secure-store (keychain on iOS,
 * encrypted SharedPreferences on Android). Exposes a Zustand-shaped
 * store API consumed by the publish wall, username screen, and any
 * future verified-only surfaces.
 */
import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import * as Updates from 'expo-updates';
import { setUserId, getUserId } from '../config/user';
import { API_BASE_URL } from '../config/api';

const TOKEN_KEY = 'souply_session_token';
const USER_KEY = 'souply_verified_user';

/** Fake session token set by the DEV quick-login (creator-auth screen). The
 *  server rejects it on verified-only endpoints, so UI that needs a real
 *  creator session checks for it to show a clearer "sign in for real" message
 *  instead of a generic error. */
export const DEV_SESSION_TOKEN = 'dev-session-token';

export interface VerifiedUser {
    id: string;
    username: string | null;
    displayName: string | null;
    bio: string | null;
    avatarUrl: string | null;
    email: string | null;
    authProvider: 'google' | 'apple' | null;
}

interface AuthState {
    token: string | null;
    user: VerifiedUser | null;
    hydrating: boolean;
    hydrate: () => Promise<void>;
    setSession: (token: string, user: VerifiedUser) => Promise<void>;
    updateUser: (patch: Partial<VerifiedUser>) => Promise<void>;
    clear: () => Promise<void>;
}

export const useAuthState = create<AuthState>((set, get) => ({
    token: null,
    user: null,
    hydrating: true,

    hydrate: async () => {
        try {
            const [token, userRaw] = await Promise.all([
                SecureStore.getItemAsync(TOKEN_KEY),
                SecureStore.getItemAsync(USER_KEY),
            ]);
            const user = userRaw ? JSON.parse(userRaw) as VerifiedUser : null;
            set({ token: token ?? null, user, hydrating: false });

            // Self-heal the account-id adoption bug. Older builds stored the
            // verified account but never adopted its id as the device userId,
            // so receipts / templates / personal equivalences kept keying to
            // the throwaway anonymous UUID generated on (re)install — making a
            // signed-in user's own data look "gone". If we detect that mismatch
            // now, adopt the account id and reload so every store re-fetches
            // against the right identity. Guarded out of __DEV__ where the
            // userId is a fixed constant (adoption there would loop forever).
            if (!__DEV__ && user?.id) {
                const current = await getUserId();
                if (current !== user.id) {
                    await setUserId(user.id);
                    try { await Updates.reloadAsync(); } catch {}
                }
            }
        } catch {
            set({ hydrating: false });
        }
    },

    setSession: async (token, user) => {
        try {
            await SecureStore.setItemAsync(TOKEN_KEY, token);
            await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
            // Adopt the verified account id as the device's userId so EVERY
            // userId-keyed call (profile, templates, stats, the merge-map)
            // targets the signed-in account — not the pre-sign-in anonymous id.
            // Critical for `loginExisting`, where the account id differs from
            // this device's anonymous id (the cause of "edits don't save" +
            // "couldn't load template" after signing into an existing account).
            if (user?.id) await setUserId(user.id);
        } catch {}
        set({ token, user });
    },

    updateUser: async (patch) => {
        const cur = get().user;
        const next = { ...(cur ?? {} as VerifiedUser), ...patch };
        try { await SecureStore.setItemAsync(USER_KEY, JSON.stringify(next)); } catch {}
        set({ user: next });
    },

    clear: async () => {
        // End the SERVER session, not just the local token. The OAuth exchange
        // set an httpOnly session cookie that the native cookie store keeps
        // sending — so without this the server still resolves `verifiedUser` to
        // the account after "logout", and anonymous template create (device id)
        // mismatches that cookie-account on the ownership check → 403. Hitting
        // the logout endpoint returns a Set-Cookie that expires it.
        try {
            await fetch(`${API_BASE_URL}/api/auth/logout`, { method: 'POST' });
        } catch {}
        try {
            await SecureStore.deleteItemAsync(TOKEN_KEY);
            await SecureStore.deleteItemAsync(USER_KEY);
        } catch {}
        set({ token: null, user: null });
    },
}));
