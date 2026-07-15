import React, { useEffect } from 'react';
import { Modal, View, Text, Pressable, StyleSheet, Linking, BackHandler, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, radius, spacing, type AppTheme } from '../constants/theme';
import { useVersionGate } from '../state/versionGate';

/**
 * Server-driven client version gate UI. Mounted once at the app root.
 *   - status 'hard' → a NON-dismissible full-screen block (no close, hardware-back suppressed)
 *     with a single button that deep-links to the store. The user cannot proceed until they
 *     update — this is what forces old builds off a breaking backend.
 *   - status 'soft' → a dismissible "update available" card. "Later" remembers the dismissal
 *     for the session; "Update" opens the store.
 * Store URL comes from the server (per-platform ClientVersionPolicy.storeUrl); the message is
 * an optional operator override, else localized default copy.
 */
export default function UpdateGateModal() {
    const { t } = useTranslation();
    const colors = useTheme();
    const styles = makeStyles(colors);
    const status = useVersionGate((s) => s.status);
    const storeUrl = useVersionGate((s) => s.storeUrl);
    const message = useVersionGate((s) => s.message);
    const dismissSoft = useVersionGate((s) => s.dismissSoft);

    const isHard = status === 'hard';
    const visible = status === 'hard' || status === 'soft';

    // Suppress the Android hardware back button while the HARD gate is up, so it can't be
    // dismissed. Soft gate leaves back alone (it's meant to be dismissible).
    useEffect(() => {
        if (Platform.OS !== 'android' || !isHard) return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
        return () => sub.remove();
    }, [isHard]);

    const openStore = () => {
        const url = storeUrl
            ?? (Platform.OS === 'ios'
                ? 'https://apps.apple.com/app/lt.souply.app'
                : 'https://play.google.com/store/apps/details?id=lt.souply.app');
        Linking.openURL(url).catch(() => { /* store not installed / bad url — nothing else to do */ });
    };

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            statusBarTranslucent
            // A hard gate must NOT close on the OS dismiss gesture; a soft one may.
            onRequestClose={isHard ? undefined : dismissSoft}
        >
            <View style={styles.backdrop}>
                <View style={styles.card}>
                    <View style={styles.iconWrap}>
                        <Ionicons name="rocket-outline" size={30} color={colors.primary} />
                    </View>
                    <Text style={styles.title}>
                        {isHard ? t('updateGate.hardTitle') : t('updateGate.softTitle')}
                    </Text>
                    <Text style={styles.body}>
                        {message || (isHard ? t('updateGate.hardBody') : t('updateGate.softBody'))}
                    </Text>

                    <Pressable style={styles.primaryBtn} onPress={openStore} accessibilityRole="button">
                        <Text style={styles.primaryBtnText}>{t('updateGate.updateButton')}</Text>
                    </Pressable>

                    {!isHard && (
                        <Pressable style={styles.laterBtn} onPress={dismissSoft} accessibilityRole="button">
                            <Text style={styles.laterBtnText}>{t('updateGate.later')}</Text>
                        </Pressable>
                    )}
                </View>
            </View>
        </Modal>
    );
}

const makeStyles = (colors: AppTheme) => StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: colors.overlayBackdrop,
        alignItems: 'center',
        justifyContent: 'center',
        padding: spacing.lg,
    },
    card: {
        width: '100%',
        maxWidth: 420,
        backgroundColor: colors.cardBackground,
        borderRadius: radius.lg,
        padding: spacing.xl,
        alignItems: 'center',
    },
    iconWrap: {
        width: 60, height: 60, borderRadius: radius.pill,
        backgroundColor: colors.primaryMuted,
        alignItems: 'center', justifyContent: 'center',
        marginBottom: spacing.md,
    },
    title: {
        fontSize: 20, fontWeight: '700', color: colors.textPrimary,
        textAlign: 'center', marginBottom: spacing.sm,
    },
    body: {
        fontSize: 15, lineHeight: 21, color: colors.textMuted,
        textAlign: 'center', marginBottom: spacing.lg,
    },
    primaryBtn: {
        width: '100%',
        backgroundColor: colors.primary,
        borderRadius: radius.md,
        paddingVertical: spacing.md,
        alignItems: 'center',
    },
    primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
    laterBtn: { marginTop: spacing.sm, paddingVertical: spacing.sm, alignItems: 'center' },
    laterBtnText: { color: colors.textMuted, fontSize: 15, fontWeight: '600' },
});
