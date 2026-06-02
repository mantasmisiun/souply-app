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
            set({
                token: token ?? null,
                user: userRaw ? JSON.parse(userRaw) as VerifiedUser : null,
                hydrating: false,
            });
        } catch {
            set({ hydrating: false });
        }
    },

    setSession: async (token, user) => {
        try {
            await SecureStore.setItemAsync(TOKEN_KEY, token);
            await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
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
        try {
            await SecureStore.deleteItemAsync(TOKEN_KEY);
            await SecureStore.deleteItemAsync(USER_KEY);
        } catch {}
        set({ token: null, user: null });
    },
}));
