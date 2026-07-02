import { create } from 'zustand';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { API_BASE_URL } from '../config/api';

/**
 * Client version gate. The server (ClientVersionPolicy) decides whether this build is too
 * old to run against the current backend. Two signals feed this store:
 *   1. A launch call to GET /api/app/version-check → 'ok' | 'soft' | 'hard'.
 *   2. Any request that comes back 426 Upgrade Required (the global fetch interceptor calls
 *      triggerHard) — so a floor flipped mid-session blocks immediately, not just next launch.
 *
 * 'hard' renders a NON-dismissible full-screen gate with a store button; 'soft' a dismissible
 * "update available" nudge (remembered for the session). FAIL-OPEN everywhere: any network/
 * parse error leaves the status 'ok' so the gate can never lock a user out on a blip.
 */

export type GateStatus = 'ok' | 'soft' | 'hard';

interface VersionGateState {
    status: GateStatus;
    storeUrl: string | null;
    message: string | null;
    softDismissed: boolean;
    triggerHard: (storeUrl: string | null, message: string | null) => void;
    triggerSoft: (storeUrl: string | null, message: string | null) => void;
    dismissSoft: () => void;
    checkVersion: () => Promise<void>;
}

export const CLIENT_PLATFORM: 'ios' | 'android' | 'web' =
    Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

export const CLIENT_VERSION: string = Constants.expoConfig?.version ?? '';

export const useVersionGate = create<VersionGateState>((set, get) => ({
    status: 'ok',
    storeUrl: null,
    message: null,
    softDismissed: false,

    triggerHard: (storeUrl, message) => {
        // Hard is terminal — never downgrade back to soft/ok within a session.
        if (get().status === 'hard') return;
        set({ status: 'hard', storeUrl, message });
    },

    triggerSoft: (storeUrl, message) => {
        const s = get();
        if (s.status === 'hard' || s.softDismissed) return; // hard wins; don't re-nag after dismiss
        set({ status: 'soft', storeUrl, message });
    },

    dismissSoft: () => set({ softDismissed: true, status: 'ok' }),

    checkVersion: async () => {
        if (!CLIENT_VERSION) return; // no version to report → nothing to gate (fail open)
        try {
            const url = `${API_BASE_URL}/api/app/version-check?platform=${CLIENT_PLATFORM}&version=${encodeURIComponent(CLIENT_VERSION)}`;
            const res = await fetch(url);
            if (!res.ok) return; // fail open
            const data = await res.json();
            if (data?.status === 'hard') get().triggerHard(data.storeUrl ?? null, data.message ?? null);
            else if (data?.status === 'soft') get().triggerSoft(data.storeUrl ?? null, data.message ?? null);
        } catch {
            // Offline / server unreachable → stay 'ok'. The per-request 426 catcher still
            // fires the hard gate the moment a real gated call happens.
        }
    },
}));
