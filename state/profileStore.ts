import { create } from 'zustand';
import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';

export interface ProfileData {
    points: number;
    level: number;
    pointsIntoLevel: number;
    pointsNeededForNext: number;
    progressFraction: number;
    nextLevelAt: number;
    pendingSwipes: boolean;
    showBurstWarning: boolean;
    isAdmin: boolean;
}

export interface StoreSlice { chainName: string; total: number; color: string; miniLogoUrl?: string | null; }
export interface CategorySlice { categoryName: string; total: number; color: string; }
export interface MonthSlice { month: string; label: string; total: number; }

export interface StatsData {
    storeBreakdown: StoreSlice[];
    categoryBreakdown: CategorySlice[];
    kitaBreakdown?: CategorySlice[];
    monthlySpending: MonthSlice[];
    totalSavings: number;
}

const STALE_MS = 5 * 60 * 1000;

interface ProfileStore {
    profile: ProfileData | null;
    stats: StatsData | null;
    lastFetched: number | null;
    fetching: boolean;
    fetchProfile: () => Promise<void>;
    invalidate: () => void;
}

export const useProfileStore = create<ProfileStore>((set, get) => ({
    profile: null,
    stats: null,
    lastFetched: null,
    fetching: false,

    fetchProfile: async () => {
        if (get().fetching) return;
        set({ fetching: true });
        try {
            const userId = await getUserId();
            const [profileRes, statsRes] = await Promise.all([
                fetch(`${API_BASE_URL}/api/users/${userId}/profile`),
                fetch(`${API_BASE_URL}/api/users/${userId}/stats`),
            ]);
            const profile = await profileRes.json();
            const stats = await statsRes.json();
            set({ profile, stats, lastFetched: Date.now() });
        } catch {
            // keep previous data on network error
        } finally {
            set({ fetching: false });
        }
    },

    invalidate: () => set({ lastFetched: null }),
}));

export const fetchProfileIfStale = () => {
    const { lastFetched, fetchProfile } = useProfileStore.getState();
    if (lastFetched == null || Date.now() - lastFetched > STALE_MS) {
        fetchProfile();
    }
};
