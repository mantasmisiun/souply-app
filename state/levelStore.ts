import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_LAST_SEEN  = 'levelup_last_seen';
const KEY_NEVER_SHOW = 'levelup_never_show';
const KEY_CANDIDATE  = 'levelup_candidate';

interface LevelState {
    pendingLevel: number | null;
    // In-memory lastSeen so acknowledge() blocks re-fire immediately without
    // waiting for an AsyncStorage round-trip (prevents race-condition stacking).
    lastSeen: number;
    stashLevel: (level: number) => Promise<void>;
    checkCandidate: () => Promise<void>;
    triggerIfNewLevel: (level: number) => Promise<void>;
    acknowledge: (neverShow: boolean, level: number) => Promise<void>;
}

export const useLevelStore = create<LevelState>((set, get) => ({
    pendingLevel: null,
    lastSeen: 1,

    stashLevel: async (level: number) => {
        const existing = await AsyncStorage.getItem(KEY_CANDIDATE);
        if (!existing || level > Number(existing)) {
            await AsyncStorage.setItem(KEY_CANDIDATE, String(level));
        }
    },

    checkCandidate: async () => {
        const raw = await AsyncStorage.getItem(KEY_CANDIDATE);
        if (raw) await get().triggerIfNewLevel(Number(raw));
    },

    triggerIfNewLevel: async (level: number) => {
        // Never stack a second modal while one is already visible.
        if (get().pendingLevel !== null) return;

        const [lastSeenRaw, neverShowRaw] = await Promise.all([
            AsyncStorage.getItem(KEY_LAST_SEEN),
            AsyncStorage.getItem(KEY_NEVER_SHOW),
        ]);
        if (neverShowRaw === '1') return;

        // Take the higher of in-memory and persisted so we survive the
        // acknowledge → AsyncStorage write race on simultaneous focus events.
        const persisted = lastSeenRaw ? Number(lastSeenRaw) : 1;
        const lastSeen = Math.max(get().lastSeen, persisted);

        if (level > lastSeen) {
            set({ pendingLevel: level, lastSeen: level });
        }
    },

    acknowledge: async (neverShow: boolean, level: number) => {
        // Update in-memory immediately so concurrent triggerIfNewLevel calls
        // that fire before the AsyncStorage write won't re-show the modal.
        set({ pendingLevel: null, lastSeen: level });
        await Promise.all([
            AsyncStorage.setItem(KEY_LAST_SEEN, String(level)),
            AsyncStorage.removeItem(KEY_CANDIDATE),
            neverShow ? AsyncStorage.setItem(KEY_NEVER_SHOW, '1') : Promise.resolve(),
        ]);
    },
}));
