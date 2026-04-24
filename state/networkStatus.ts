import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Global network-connectivity store, driven by NetInfo.
 *
 * `isOnline` is a conservative boolean: we only call it online when
 * both `isConnected === true` AND `isInternetReachable !== false`.
 * `isInternetReachable` can be `null` in transient states (just
 * reconnected, still probing) — we treat that as "assume online"
 * rather than fail closed, because NetInfo's probe sometimes lags.
 *
 * `lastOnlineAt` / `lastOfflineAt` timestamps let consumers trigger
 * auto-retry on the offline→online transition without chasing
 * NetInfo's event listeners themselves. Callers subscribe via the
 * selector form `useNetworkStatus(s => s.lastOnlineAt)` and React
 * re-runs when it changes.
 */
interface NetworkState {
    isOnline: boolean;
    lastOnlineAt: number | null;
    lastOfflineAt: number | null;
    applyNetInfo: (state: NetInfoState) => void;
}

export const useNetworkStatus = create<NetworkState>((set, get) => ({
    // Start optimistic — assume online until NetInfo reports otherwise.
    // Blocks the "offline banner flashes on app launch before NetInfo
    // has polled" UX bug.
    isOnline: true,
    lastOnlineAt: null,
    lastOfflineAt: null,
    applyNetInfo: (state) => {
        const reachable = state.isInternetReachable;
        const online =
            state.isConnected === true && reachable !== false;
        const prev = get().isOnline;
        if (online === prev) return; // no-op if unchanged
        set({
            isOnline: online,
            lastOnlineAt: online ? Date.now() : get().lastOnlineAt,
            lastOfflineAt: !online ? Date.now() : get().lastOfflineAt,
        });
    },
}));

/**
 * Attach NetInfo's event listener to the store. Call once, near the
 * root of the app (e.g., from the root layout). Idempotent — NetInfo
 * returns one unsubscribe per subscription, and only one subscription
 * is needed app-wide. Re-mounting the subscriber just replaces the
 * callback; no listener accumulation.
 */
export function useBindNetInfo() {
    const applyNetInfo = useNetworkStatus((s) => s.applyNetInfo);
    useEffect(() => {
        // Seed the store from the current state so consumers don't
        // wait for the first NetInfo event after boot.
        NetInfo.fetch().then(applyNetInfo).catch(() => {});
        const unsub = NetInfo.addEventListener(applyNetInfo);
        return () => unsub();
    }, [applyNetInfo]);
}
