import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useMemo } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../../constants/theme';
import { useAdminModeStore } from '../../../state/adminModeStore';
import { useProfileStore } from '../../../state/profileStore';
import Animated from 'react-native-reanimated';
import { ScreenHeading } from '../../../components/ScreenHeading';
import { useCollapsingHeader, CollapsingHeader } from '../../../components/CollapsingHeader';

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
    const header = useCollapsingHeader();
    const router = useRouter();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const setMode = useAdminModeStore(s => s.setMode);
    const profile = useProfileStore(s => s.profile);

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
            const { releaseAdminImageBatch } = await import('../../../services/adminClient');
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
            const Updates = await import('expo-updates');
            await Updates.reloadAsync();
        } catch (e) {
            console.warn('[adminMode] reloadAsync failed, falling back to router replace', e);
            router.replace('/');
        }
    };

    const settingsGear = (
        <TouchableOpacity
            onPress={() => router.push('/settings' as any)}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
            <Ionicons name="settings-outline" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
    );

    return (
        <View style={{ flex: 1, backgroundColor: colors.pageBackground }}>
        <CollapsingHeader
            controller={header}
            right={settingsGear}
        />
        <Animated.ScrollView {...header.scroll} contentContainerStyle={[styles.scroll, { paddingTop: header.paddingTop + 20 }]}>
            <ScreenHeading title={t('tabs.profilis')} />
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

            <TouchableOpacity style={[styles.row, styles.switchRow]} onPress={onSwitchToUser}>
                <Ionicons name="person-outline" size={22} color={colors.onPrimary} />
                <Text style={[styles.rowText, { color: colors.onPrimary }]}>
                    {t('admin.switchToUser')}
                </Text>
                <Ionicons name="chevron-forward" size={18} color={colors.onPrimary} />
            </TouchableOpacity>
        </Animated.ScrollView>
        </View>
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

});
