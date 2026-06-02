import React, { useMemo } from 'react';
import { View, Text, Modal, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../constants/theme';

interface Props {
    visible: boolean;
    onClose: () => void;
}

/**
 * Explains the per-template stats (Vizitai / Panaudojimai / Padėjai sutaupyti).
 * Same copy as the web dashboard's stat explainers so both surfaces describe
 * the numbers identically. Opened by the `?` on the stats view.
 */
export function StatsHelpModal({ visible, onClose }: Props) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const rows: Array<{ icon: keyof typeof Ionicons.glyphMap; label: string; body: string }> = [
        { icon: 'eye-outline', label: t('basketTab.templates.metricVisits'), body: t('basketTab.templates.statsVisitsExplainer') },
        { icon: 'cart-outline', label: t('basketTab.templates.metricUses'), body: t('basketTab.templates.statsUsesExplainer') },
        { icon: 'trending-down-outline', label: t('basketTab.templates.metricSaved'), body: t('basketTab.templates.statsHelpedSaveExplainer') },
    ];

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
            <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
                <View style={styles.card} onStartShouldSetResponder={() => true}>
                    <Text style={styles.title}>{t('basketTab.templates.statsHelpTitle')}</Text>
                    {rows.map((r) => (
                        <View key={r.label} style={styles.row}>
                            <Ionicons name={r.icon} size={18} color={colors.primary} style={{ marginTop: 1 }} />
                            <View style={{ flex: 1 }}>
                                <Text style={styles.rowLabel}>{r.label}</Text>
                                <Text style={styles.rowBody}>{r.body}</Text>
                            </View>
                        </View>
                    ))}
                    <TouchableOpacity style={styles.close} onPress={onClose}>
                        <Text style={styles.closeText}>{t('common.gotIt')}</Text>
                    </TouchableOpacity>
                </View>
            </TouchableOpacity>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 28 },
    card: { backgroundColor: c.cardBackground, borderRadius: 18, padding: 20, gap: 14, width: '100%', maxWidth: 420 },
    title: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
    row: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
    rowLabel: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
    rowBody: { fontSize: 13, color: c.textSecondary, lineHeight: 18, marginTop: 1 },
    close: { alignSelf: 'flex-end', paddingVertical: 8, paddingHorizontal: 12, marginTop: 2 },
    closeText: { fontSize: 14, fontWeight: '700', color: c.primary },
});
