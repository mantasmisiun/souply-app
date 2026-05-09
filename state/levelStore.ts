import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_LAST_SEEN  = 'levelup_last_seen';
const KEY_NEVER_SHOW = 'levelup_never_show';
const KEY_CANDIDATE  = 'levelup_candidate';

interface LevelState {
    pendingLevel: number | null;
    // Call on each vote response — writes to AsyncStorage so the level
    // survives an app close and can be picked up on the next focus.
    stashLevel: (level: number) => Promise<void>;
    // Call on focus of any screen the user lands on after swiping.
    // Reads the stashed candidate and fires the modal if it's a new level.
    checkCandidate: () => Promise<void>;
    triggerIfNewLevel: (level: number) => Promise<void>;
    acknowledge: (neverShow: boolean, level: number) => Promise<void>;
}

export const useLevelStore = create<LevelState>((set, get) => ({
    pendingLevel: null,

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
        const [lastSeenRaw, neverShowRaw] = await Promise.all([
            AsyncStorage.getItem(KEY_LAST_SEEN),
            AsyncStorage.getItem(KEY_NEVER_SHOW),
        ]);
        if (neverShowRaw === '1') return;
        const lastSeen = lastSeenRaw ? Number(lastSeenRaw) : 1;
        if (level > lastSeen) set({ pendingLevel: level });
    },

    acknowledge: async (neverShow: boolean, level: number) => {
        set({ pendingLevel: null });
        await Promise.all([
            AsyncStorage.setItem(KEY_LAST_SEEN, String(level)),
            AsyncStorage.removeItem(KEY_CANDIDATE),
            neverShow ? AsyncStorage.setItem(KEY_NEVER_SHOW, '1') : Promise.resolve(),
        ]);
    },
}));
