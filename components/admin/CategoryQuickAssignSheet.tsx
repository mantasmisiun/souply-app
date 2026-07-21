import { View, Text, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import { useEffect, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../../constants/theme';
import { MaterialProgress } from '../MaterialProgress';
import CategoryPickerModal from './CategoryPickerModal';
import {
    getProductCategorySuggestions, adminMoveProducts, type CategorySuggestion,
} from '../../services/adminClient';

/**
 * One-tap category assignment: suggestions from the matcher + leaf-name
 * engines first ("kaip <example>"), full L1→L2→L3 picker as fallback.
 * On assign: adminMoveProducts (also clears categoryReviewPending server-side).
 */
export function CategoryQuickAssignSheet({
    productId, productName, visible, onClose, onAssigned,
}: {
    productId: number;
    productName: string;
    visible: boolean;
    onClose: () => void;
    onAssigned: (categoryId: number, categoryName: string) => void;
}) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [suggestions, setSuggestions] = useState<CategorySuggestion[] | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!visible) { setSuggestions(null); setError(null); return; }
        getProductCategorySuggestions(productId)
            .then(setSuggestions)
            .catch(() => setSuggestions([]));
    }, [visible, productId]);

    const assign = async (categoryId: number, categoryName: string) => {
        setSaving(true); setError(null);
        try {
            await adminMoveProducts([productId], categoryId);
            onAssigned(categoryId, categoryName);
            onClose();
        } catch (e: any) {
            setError(e?.message ?? 'Nepavyko priskirti');
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            <Modal visible={visible && !pickerOpen} transparent animationType="fade" onRequestClose={onClose}>
                <View style={styles.overlay}>
                    <View style={styles.card}>
                        <Text style={styles.title} numberOfLines={2}>{productName}</Text>
                        <Text style={styles.subtitle}>Priskirti kategoriją</Text>

                        {suggestions == null ? (
                            <MaterialProgress color={colors.primary} style={{ marginVertical: 20 }} />
                        ) : suggestions.length === 0 ? (
                            <Text style={styles.emptyText}>Pasiūlymų nėra — rinkitės ranka.</Text>
                        ) : (
                            suggestions.map(s => (
                                <TouchableOpacity
                                    key={s.categoryId}
                                    style={styles.suggRow}
                                    disabled={saving}
                                    onPress={() => assign(s.categoryId, s.categoryName)}
                                >
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.suggName}>{s.categoryName}</Text>
                                        <Text style={styles.suggMeta} numberOfLines={1}>
                                            {s.parentName ? `${s.parentName} · ` : ''}
                                            {s.example ? `kaip „${s.example}“` : 'pagal pavadinimą'}
                                        </Text>
                                    </View>
                                    <Text style={styles.suggScore}>{s.score.toFixed(1)}</Text>
                                    <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                                </TouchableOpacity>
                            ))
                        )}

                        {error && <Text style={styles.errorText}>{error}</Text>}

                        <View style={styles.actions}>
                            <TouchableOpacity onPress={onClose} disabled={saving}>
                                <Text style={styles.cancel}>Atšaukti</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.otherBtn} onPress={() => setPickerOpen(true)} disabled={saving}>
                                <Text style={styles.otherText}>Kita…</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>

            <CategoryPickerModal
                visible={pickerOpen}
                selectionCount={1}
                sourceL3Ids={[]}
                onConfirm={(categoryId, categoryName) => { setPickerOpen(false); assign(categoryId, categoryName); }}
                onCancel={() => setPickerOpen(false)}
            />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 24 },
    card: { backgroundColor: c.cardBackground, borderRadius: 14, padding: 16, gap: 8 },
    title: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    subtitle: { fontSize: 12, color: c.textSecondary, marginBottom: 4 },
    suggRow: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingVertical: 10, paddingHorizontal: 10,
        borderRadius: 10, backgroundColor: c.pageBackground,
    },
    suggName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    suggMeta: { fontSize: 11, color: c.textSecondary, marginTop: 1 },
    suggScore: { fontSize: 12, color: c.textMuted, fontVariant: ['tabular-nums'] },
    emptyText: { fontSize: 13, color: c.textSecondary, marginVertical: 12 },
    errorText: { fontSize: 12, color: '#d9534f' },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 18, marginTop: 6 },
    cancel: { color: c.textSecondary, fontSize: 14 },
    otherBtn: { backgroundColor: c.primary, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
    otherText: { color: c.onPrimary, fontWeight: '600' },
});
