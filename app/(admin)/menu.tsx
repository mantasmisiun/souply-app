import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { useMemo, useState, useCallback } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Updates from 'expo-updates';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../constants/theme';
import { useAdminModeStore } from '../../state/adminModeStore';
import { useProfileStore } from '../../state/profileStore';

/**
 * Admin Profilis tab.
 *
 * Mirrors the user-side Profilis at a high level (points, level, etc.)
 * but swaps the entry button: where the user sees "Pereiti į admin
 * panelį", an admin sees "Sugrįžti į vartotojo panelį" that flips
 * `adminModeStore` back to 'user' and routes to the regular tab group.
 *
 * Intentionally lighter than user-Profilis — admins primarily come
 * here to switch back, not to look at stats. The audit-log shortcut
 * lives here too because it's a logical "admin tools" surface.
 */
export default function AdminMenu() {
    const colors = useTheme();
    const router = useRouter();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const setMode = useAdminModeStore(s => s.setMode);
    const profile = useProfileStore(s => s.profile);

    // ── Build / OTA indicator ────────────────────────────────────
    // Without a visible bundle id, force-closing twice after `eas update`
    // is a guessing game — there's no way to tell from inside the app
    // whether the new code is live yet. Expo exposes the active update's
    // metadata; the manual "Tikrinti atnaujinimus" button forces a
    // fetch+reload so the admin can pull the new bundle on demand
    // instead of relying on the launch-time check.
    const updateId = Updates.updateId;
    const channel = Updates.channel ?? 'embedded';
    const createdAt = Updates.createdAt;
    // `manifest.message` is what `--message` on the `eas update` call set.
    const updateMessage = (Updates.manifest as any)?.message
        ?? (Updates.manifest as any)?.extra?.expoClient?.extra?.message
        ?? null;
    const isEmbedded = Updates.isEmbeddedLaunch;
    const shortId = updateId ? updateId.slice(0, 8) : null;
    const fmtDate = createdAt
        ? createdAt.toLocaleString('lt-LT', {
              month: '2-digit', day: '2-digit',
              hour: '2-digit', minute: '2-digit',
          })
        : null;

    const [checking, setChecking] = useState(false);
    const onCheckForUpdates = useCallback(async () => {
        if (checking) return;
        setChecking(true);
        try {
            const check = await Updates.checkForUpdateAsync();
            if (!check.isAvailable) {
                Alert.alert(t('admin.build.upToDateTitle'), t('admin.build.upToDateBody'));
                return;
            }
            await Updates.fetchUpdateAsync();
            Alert.alert(
                t('admin.build.fetchedTitle'),
                t('admin.build.fetchedBody'),
                [{ text: 'OK', onPress: () => Updates.reloadAsync() }],
            );
        } catch (e: any) {
            Alert.alert(
                t('admin.build.errorTitle'),
                String(e?.message ?? e),
            );
        } finally {
            setChecking(false);
        }
    }, [checking, t]);

    const onSwitchToUser = async () => {
        // Persist the new mode FIRST so a crash/restart anywhere below
        // still lands the user in user mode (boot reads AsyncStorage
        // and routes accordingly). Earlier order (release-then-mode)
        // had a window where the navigator could remount RootLayout,
        // re-fire its hydrate effect, and find mode still='admin' →
        // redirected straight back to the admin panel. The visible
        // symptom was "tap button, app appears to restart into admin".
        await setMode('user');

        // Release any in-flight image leases so abandoned cards don't
        // wait the full 2h before another admin can claim them.
        try {
            const { releaseAdminImageBatch } = await import('../../services/adminClient');
            await releaseAdminImageBatch();
        } catch {
            /* non-fatal — release is a nice-to-have */
        }

        // Full reload instead of router.replace across tab groups.
        // Cross-group `router.replace` doesn't always cleanly tear down
        // the (admin) navigator, and the visible behaviour was the
        // user landing back in admin. A controlled reload reads
        // AsyncStorage at boot (now 'user') and lands cleanly in
        // (tabs). ~1.5s but reliable. Same pattern as recovery.
        try {
            await Updates.reloadAsync();
        } catch (e) {
            console.warn('[adminMode] reloadAsync failed, falling back to router replace', e);
            router.replace('/');
        }
    };

    return (
        <ScrollView contentContainerStyle={styles.scroll}>
            <View style={styles.header}>
                <Ionicons name="shield-checkmark" size={48} color={colors.primary} />
                <Text style={styles.title}>{t('admin.title')}</Text>
                <Text style={styles.subtitle}>
                    {t('admin.subtitle', { points: profile?.points ?? 0 })}
                </Text>
            </View>

            <TouchableOpacity style={styles.row} onPress={() => router.push('/profile/audit-log' as any)}>
                <Ionicons name="document-text-outline" size={22} color={colors.textPrimary} />
                <Text style={styles.rowText}>{t('admin.auditLogTitle')}</Text>
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>

            {/* Build indicator — read at module load, so the values
                shown match the JS bundle currently running. After
                Updates.reloadAsync() the new bundle's values appear. */}
            <View style={styles.buildCard}>
                <View style={styles.buildHeaderRow}>
                    <Ionicons name="code-slash" size={18} color={colors.textSecondary} />
                    <Text style={styles.buildTitle}>{t('admin.build.title')}</Text>
                    <View style={[styles.buildChannelChip, isEmbedded && styles.buildChannelChipEmbedded]}>
                        <Text style={styles.buildChannelChipText}>{isEmbedded ? t('admin.build.embedded') : channel}</Text>
                    </View>
                </View>
                {updateMessage && (
                    <Text style={styles.buildMessage} numberOfLines={3}>{updateMessage}</Text>
                )}
                <Text style={styles.buildMeta} numberOfLines={1}>
                    {shortId ? `id ${shortId}` : t('admin.build.noId')}
                    {fmtDate ? ` · ${fmtDate}` : ''}
                </Text>
                <TouchableOpacity
                    style={styles.buildCheckBtn}
                    onPress={onCheckForUpdates}
                    disabled={checking}
                >
                    {checking
                        ? <ActivityIndicator size="small" color={colors.primary} />
                        : <>
                            <Ionicons name="refresh" size={16} color={colors.primary} />
                            <Text style={styles.buildCheckBtnText}>{t('admin.build.checkNow')}</Text>
                          </>}
                </TouchableOpacity>
            </View>

            <TouchableOpacity style={[styles.row, styles.switchRow]} onPress={onSwitchToUser}>
                <Ionicons name="person-outline" size={22} color={colors.onPrimary} />
                <Text style={[styles.rowText, { color: colors.onPrimary }]}>
                    {t('admin.switchToUser')}
                </Text>
                <Ionicons name="chevron-forward" size={18} color={colors.onPrimary} />
            </TouchableOpacity>
        </ScrollView>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    scroll: { padding: 20, gap: 16 },
    header: { alignItems: 'center', padding: 16, gap: 4 },
    title: { fontSize: 20, fontWeight: '700', color: c.textPrimary, marginTop: 4 },
    subtitle: { fontSize: 13, color: c.textSecondary },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 16,
        backgroundColor: c.cardBackground,
        borderRadius: 12,
    },
    switchRow: { backgroundColor: c.primary, marginTop: 8 },
    rowText: { flex: 1, fontSize: 15, fontWeight: '500', color: c.textPrimary },

    buildCard: {
        backgroundColor: c.cardBackground,
        borderRadius: 12,
        padding: 16,
        gap: 8,
    },
    buildHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    buildTitle: { flex: 1, fontSize: 13, fontWeight: '700', color: c.textPrimary, textTransform: 'uppercase' },
    buildChannelChip: {
        paddingHorizontal: 8, paddingVertical: 2,
        borderRadius: 10, backgroundColor: c.primary + '22',
    },
    buildChannelChipEmbedded: { backgroundColor: c.surfaceMuted },
    buildChannelChipText: { fontSize: 11, color: c.primary, fontWeight: '700' },
    buildMessage: { fontSize: 13, color: c.textPrimary },
    buildMeta: { fontSize: 11, color: c.textMuted, fontFamily: 'monospace' },
    buildCheckBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
        marginTop: 4, paddingVertical: 10,
        borderRadius: 8, borderWidth: 1, borderColor: c.primary,
    },
    buildCheckBtnText: { fontSize: 13, fontWeight: '700', color: c.primary },
});
