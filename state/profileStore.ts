import { create } from 'zustand';
import { API_BASE_URL } from '../config/api';
import { getUserId, reclaimAnonSessionToken } from '../config/user';

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
    role?: string | null;
    // Identity (profile header)
    firstName?: string | null;
    lastName?: string | null;
    displayName?: string | null;
    username?: string | null;
    avatarUrl?: string | null;
    avatarColor?: string | null;
    // Aggregate template stats (profile cards)
    templateCount?: number;
    totalVisits?: number;
    totalUses?: number;
    totalFollowerSavingsEur?: number;
}

export interface StoreSlice { chainName: string; total: number; color: string; miniLogoUrl?: string | null; }
export interface CategorySlice { categoryName: string; total: number; color: string; }
export interface MonthSlice { month: string; label: string; total: number; }

export interface StatsData {
    storeBreakdown: StoreSlice[];
    /** Per-month store breakdown keyed by `YYYY-MM` — drives the month-paged
     *  Stores donut. Absent months simply have no key (empty donut). */
    storeBreakdownByMonth?: Record<string, StoreSlice[]>;
    categoryBreakdown: CategorySlice[];
    kitaBreakdown?: CategorySlice[];
    /** Full per-month category breakdown keyed by `YYYY-MM` (not truncated —
     *  the client applies its own top-N/"Kitos" split). Drives the month-paged
     *  Categories donut. */
    categoryBreakdownByMonth?: Record<string, CategorySlice[]>;
    monthlySpending: MonthSlice[];
    totalSavings: number;
    /** Savings for the current calendar month only (same avg-vs-paid formula
     *  as totalSavings, scoped to this month). */
    savingsThisMonth: number;
    /** Last month's savings figure (same avg-vs-paid formula). The card shows
     *  the € delta (thisMonth − lastMonth) as a "vs last month" chip, hidden
     *  when last month has no baseline (=== 0). */
    savingsLastMonth: number;
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
            const load = () => Promise.all([
                fetch(`${API_BASE_URL}/api/users/${userId}/profile`),
                fetch(`${API_BASE_URL}/api/users/${userId}/stats`),
            ]);
            let [profileRes, statsRes] = await load();
            // Stale/pre-hardening session token → the self-only routes 401.
            // Re-claim the anon token once and retry (empty charts + missing
            // savings card came from storing the 401 error body as "stats").
            if (profileRes.status === 401 || statsRes.status === 401) {
                if (await reclaimAnonSessionToken()) [profileRes, statsRes] = await load();
            }
            // NEVER store a non-OK body — `{error}` parsed as stats blanked the
            // whole profile screen. Keep previous data instead.
            if (!profileRes.ok || !statsRes.ok) return;
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
