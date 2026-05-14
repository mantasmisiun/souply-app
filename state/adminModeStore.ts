import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Sticky admin/user mode toggle. Persisted to AsyncStorage so that an
 * admin who restarts the app comes back to whichever panel they were in.
 *
 * Mode flips are explicit — the user taps "Admin panel" on Profilis or
 * "User panel" on the admin Profilis. There's no auto-switch.
 *
 * Why a store and not a route param: the tab bar in `app/(tabs)/_layout`
 * vs `app/(admin)/_layout` is the same surface at the same root, and we
 * want the choice persisted across cold starts. A Zustand store gives
 * both: observable for the tab layout to re-render on switch, and a
 * plain function to write to storage on toggle.
 */

const KEY = 'admin_mode';

interface AdminModeStore {
    mode: 'user' | 'admin';
    hydrated: boolean;
    hydrate: () => Promise<void>;
    setMode: (mode: 'user' | 'admin') => Promise<void>;
}

export const useAdminModeStore = create<AdminModeStore>((set) => ({
    mode: 'user',
    hydrated: false,
    hydrate: async () => {
        const raw = await AsyncStorage.getItem(KEY);
        const mode = raw === 'admin' ? 'admin' : 'user';
        set({ mode, hydrated: true });
    },
    setMode: async (mode) => {
        await AsyncStorage.setItem(KEY, mode);
        set({ mode });
    },
}));
