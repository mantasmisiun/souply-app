import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, AppState } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import * as Updates from 'expo-updates';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../constants/theme';
import { IS_PROD } from '../config/env';

/**
 * Thin top banner that polls for OTA updates and prompts the user to restart
 * when one's been downloaded. Mounted at the root layout so it covers every
 * screen.
 *
 * Gate: DEV + STAGING builds only (`!__DEV__ && !IS_PROD`). Excluded from Metro
 * (`__DEV__`, where OTAs don't apply) AND from production (prod updates apply
 * silently on the next cold start — we don't nag real users with a restart bar).
 *
 * Lifecycle:
 *   1. On mount + on every app-foreground: `checkForUpdateAsync`.
 *   2. If available: `fetchUpdateAsync` downloads in the background; the
 *      `useUpdates` hook flips `isUpdatePending` once it's ready.
 *   3. Banner appears with a Restart button → `reloadAsync()`.
 *   4. A 60s poll is a fallback in case foreground events don't fire when the
 *      app already had focus as the EAS publish landed.
 */

const POLL_INTERVAL_MS = 60_000;
const SHOW_UPDATE_BANNER = !__DEV__ && !IS_PROD;

export function DevUpdateBanner() {
    const { t } = useTranslation();
    const colors = useTheme();
    const styles = makeStyles(colors);
    const { isUpdateAvailable, isUpdatePending } = Updates.useUpdates();
    const [reloading, setReloading] = useState(false);

    const checkAndFetch = useCallback(async () => {
        try {
            const result = await Updates.checkForUpdateAsync();
            if (result.isAvailable) {
                await Updates.fetchUpdateAsync();
            }
        } catch {
            // OTA endpoint may be unreachable / rate-limited; failure is
            // non-fatal — keep the banner hidden and try again next interval.
        }
    }, []);

    useEffect(() => {
        if (!SHOW_UPDATE_BANNER) return;
        let cancelled = false;
        let intervalId: ReturnType<typeof setInterval> | null = null;

        checkAndFetch();
        intervalId = setInterval(() => {
            if (!cancelled) checkAndFetch();
        }, POLL_INTERVAL_MS);

        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active' && !cancelled) checkAndFetch();
        });

        return () => {
            cancelled = true;
            if (intervalId) clearInterval(intervalId);
            sub.remove();
        };
    }, [checkAndFetch]);

    if (!SHOW_UPDATE_BANNER) return null;
    if (!isUpdatePending) return null;

    const onRestart = async () => {
        if (reloading) return;
        setReloading(true);
        try {
            await Updates.reloadAsync();
        } catch (e) {
            console.warn('[DevUpdateBanner] reloadAsync failed', e);
            setReloading(false);
        }
    };

    return (
        <SafeAreaView edges={['top']} style={{ backgroundColor: colors.primary }}>
            <View style={styles.bar}>
                <Ionicons name="cloud-download" size={16} color={colors.onPrimary} />
                <Text style={styles.text} numberOfLines={1}>
                    {t('banners.devUpdate.message')}
                </Text>
                <TouchableOpacity
                    style={styles.btn}
                    onPress={onRestart}
                    disabled={reloading}
                >
                    {reloading
                        ? <ActivityIndicator size="small" color={colors.primary} />
                        : <Text style={styles.btnText}>{t('banners.devUpdate.restart')}</Text>}
                </TouchableOpacity>
            </View>
            {isUpdateAvailable && !isUpdatePending && (
                <Text style={styles.subtle}>{t('banners.devUpdate.fetching')}</Text>
            )}
        </SafeAreaView>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 8,
        paddingHorizontal: 12,
    },
    text: { flex: 1, fontSize: 13, fontWeight: '600', color: c.onPrimary },
    btn: {
        paddingVertical: 4, paddingHorizontal: 12,
        borderRadius: 6, backgroundColor: c.cardBackground,
    },
    btnText: { fontSize: 12, fontWeight: '700', color: c.primary },
    subtle: { fontSize: 10, color: c.onPrimary, paddingHorizontal: 12, paddingBottom: 4 },
});
