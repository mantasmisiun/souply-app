import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Updates from 'expo-updates';
import { IS_PROD } from '../config/env';

/**
 * Production OTA update-on-launch / on-resume (Phase 3, JS half).
 *
 * COLD START is handled natively (app.config.js updates.fallbackToCacheTimeout) — the
 * launcher applies a fresh bundle behind the splash before first render. This hook covers
 * the WARM case: an EAS Update published while the app is already open. It downloads the
 * update in the background, then applies it on the next foreground return AFTER the app has
 * been backgrounded for a while — a natural "fresh start" moment, so we never yank the app
 * out from under an active user mid-task.
 *
 * PROD-ONLY: dev/staging use the DevUpdateBanner (manual restart button); Metro (__DEV__)
 * has no OTA at all. Fully fail-safe: every expo-updates call is best-effort; a failure just
 * means the update lands on a later launch.
 */

const MIN_BACKGROUND_MS = 15 * 60 * 1000; // only auto-reload if backgrounded ≥ 15 min

export function useAppUpdates(): void {
    const backgroundedAt = useRef<number | null>(null);
    const reloading = useRef(false);
    // isUpdatePending is reactive state from the expo-updates hook; mirror it into a ref so
    // the AppState resume handler (a stable closure) reads the current value.
    const { isUpdatePending } = Updates.useUpdates();
    const pendingRef = useRef(false);
    pendingRef.current = isUpdatePending === true;

    useEffect(() => {
        if (!IS_PROD || __DEV__) return;

        let cancelled = false;

        const checkAndFetch = async () => {
            try {
                const res = await Updates.checkForUpdateAsync();
                if (!cancelled && res.isAvailable) {
                    await Updates.fetchUpdateAsync(); // downloads; flips isUpdatePending when ready
                }
            } catch {
                // OTA endpoint unreachable / rate-limited — retry on the next foreground.
            }
        };

        const maybeReloadOnResume = async () => {
            if (reloading.current) return;
            const pending = pendingRef.current;
            const wasBackgrounded = backgroundedAt.current;
            const longEnough = wasBackgrounded != null && Date.now() - wasBackgrounded >= MIN_BACKGROUND_MS;
            if (pending && longEnough) {
                reloading.current = true;
                try {
                    await Updates.reloadAsync(); // applies the downloaded bundle (fresh start)
                } catch {
                    reloading.current = false; // let a later resume try again
                }
            }
        };

        // Fetch once on mount (warm publish that landed just before this launch).
        void checkAndFetch();

        const onAppStateChange = (next: AppStateStatus) => {
            if (next === 'background' || next === 'inactive') {
                if (backgroundedAt.current == null) backgroundedAt.current = Date.now();
                return;
            }
            if (next === 'active') {
                void maybeReloadOnResume();
                void checkAndFetch(); // pick up anything published while we were away
                backgroundedAt.current = null;
            }
        };

        const sub = AppState.addEventListener('change', onAppStateChange);
        return () => {
            cancelled = true;
            sub.remove();
        };
    }, []);
}
