import {
    View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView, Alert,
} from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../../constants/theme';
import { formatDate } from '../../../utils/formatCurrency';
import {
    getFailedReceipts,
    resolveFailedReceipt,
    type FailedReceiptRow,
} from '../../../services/adminClient';

const REASON_LABEL: Record<string, string> = {
    ocr_no_text: 'OCR be teksto',
    ocr_error: 'OCR klaida',
    chain_unrecognized: 'Neatpažintas tinklas',
    store_unrecognized: 'Neatpažinta parduotuvė',
    parse_failed: 'Nepavyko išanalizuoti',
    mask_failed: 'Nepavyko paslėpti kortelės',
};

export function FailedReceiptsQueue({ onEmpty }: { onEmpty?: () => void }) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [rows, setRows] = useState<FailedReceiptRow[] | null>(null);
    const [resolvingId, setResolvingId] = useState<number | null>(null);

    const load = useCallback(async () => {
        try {
            const data = await getFailedReceipts('new');
            setRows(data);
            if (data.length === 0) onEmpty?.();
        } catch {
            setRows([]);
        }
    }, [onEmpty]);

    useFocusEffect(useCallback(() => { load(); }, [load]));

    const resolve = useCallback(async (id: number) => {
        setResolvingId(id);
        try {
            await resolveFailedReceipt(id);
            setRows(prev => {
                const next = (prev ?? []).filter(r => r.id !== id);
                if (next.length === 0) onEmpty?.();
                return next;
            });
        } catch {
            Alert.alert('Klaida', 'Nepavyko atmesti įrašo.');
        } finally {
            setResolvingId(null);
        }
    }, [onEmpty]);

    if (rows === null) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator color={colors.primary} />
            </View>
        );
    }

    if (rows.length === 0) {
        return (
            <View style={styles.centered}>
                <Ionicons name="checkmark-done-circle-outline" size={48} color={colors.textMuted} />
                <Text style={styles.emptyText}>{t('admin.failed.empty')}</Text>
            </View>
        );
    }

    return (
        <ScrollView contentContainerStyle={styles.list}>
            {rows.map(r => (
                <View key={r.id} style={styles.card}>
                    <View style={styles.cardHeader}>
                        <View style={styles.reasonPill}>
                            <Text style={styles.reasonText}>{REASON_LABEL[r.failReason] ?? r.failReason}</Text>
                        </View>
                        <Text style={styles.date}>{formatDate(r.createdAt)}</Text>
                    </View>

                    {(r.detectedChainName || r.extractedStoreAddress) && (
                        <Text style={styles.metaLine} numberOfLines={2}>
                            {[r.detectedChainName, r.extractedStoreAddress].filter(Boolean).join(' · ')}
                        </Text>
                    )}
                    <Text style={styles.metaDim}>
                        {t('admin.failed.lines', { count: r.ocrLineCount ?? 0 })}
                        {r.shoppingListId != null ? ` · sąrašas #${r.shoppingListId}` : ''}
                        {r.failedBucketPath ? ' · 🖼' : ''}
                    </Text>

                    {r.ocrPreview ? (
                        <Text style={styles.preview} numberOfLines={6}>{r.ocrPreview}</Text>
                    ) : null}

                    <TouchableOpacity
                        style={styles.resolveBtn}
                        onPress={() => resolve(r.id)}
                        disabled={resolvingId === r.id}
                    >
                        {resolvingId === r.id ? (
                            <ActivityIndicator size="small" color={colors.onPrimary} />
                        ) : (
                            <>
                                <Ionicons name="checkmark" size={16} color={colors.onPrimary} />
                                <Text style={styles.resolveText}>{t('admin.failed.resolve')}</Text>
                            </>
                        )}
                    </TouchableOpacity>
                </View>
            ))}
        </ScrollView>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
    emptyText: { fontSize: 14, color: c.textSecondary, textAlign: 'center' },
    list: { padding: 12, gap: 10 },
    card: {
        backgroundColor: c.cardBackground, borderRadius: 12, padding: 14, gap: 6,
        borderWidth: 1, borderColor: c.borderSubtle,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    reasonPill: { backgroundColor: c.warningMuted, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
    reasonText: { fontSize: 12, fontWeight: '700', color: c.warning },
    date: { fontSize: 11, color: c.textMuted },
    metaLine: { fontSize: 13, fontWeight: '600', color: c.textPrimary },
    metaDim: { fontSize: 11, color: c.textMuted },
    preview: {
        fontSize: 11, color: c.textSecondary, fontFamily: 'monospace',
        backgroundColor: c.surfaceMuted, borderRadius: 8, padding: 8, marginTop: 2,
    },
    resolveBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
        backgroundColor: c.primary, borderRadius: 999, paddingVertical: 10, marginTop: 6,
    },
    resolveText: { fontSize: 14, fontWeight: '700', color: c.onPrimary },
});
