import { View, Text, TouchableOpacity, StyleSheet, Modal } from 'react-native';
import { useMemo } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../constants/theme';

export interface ComparedBasketChoice {
    id: number;
    name: string | null;
    itemCount: number;
    updatedAt: string;
}

interface ComparedBasketChoiceModalProps {
    visible: boolean;
    compared: ComparedBasketChoice | null;
    onUseExisting: () => void;
    onCreateNew: () => void;
    onCancel: () => void;
}

/**
 * When the user has no draft basket but has at least one compared basket
 * and taps "Į krepšelį", this modal asks whether to (a) revert the most
 * recent compared basket back to draft and add there, or (b) create a
 * fresh draft.
 *
 * We only surface the most recent compared basket — if the user has
 * multiple and wants to target a specific one, they're better served by
 * navigating to that basket's detail screen and adding from within it.
 */
export default function ComparedBasketChoiceModal({
    visible,
    compared,
    onUseExisting,
    onCreateNew,
    onCancel,
}: ComparedBasketChoiceModalProps) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    if (!compared) return null;

    const title =
        compared.name || new Date(compared.updatedAt).toLocaleDateString('lt-LT');

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
            <View style={styles.overlay}>
                <View style={styles.card}>
                    <Text style={styles.title}>Kur pridėti prekę?</Text>
                    <Text style={styles.sub}>
                        Turite palygintą krepšelį. Jei pridėsite į jį, krepšelis
                        vėl taps redaguojamu juodraščiu.
                    </Text>

                    <TouchableOpacity style={styles.optionRow} onPress={onUseExisting}>
                        <Ionicons name="cart-outline" size={22} color={colors.primary} />
                        <View style={styles.optionBody}>
                            <Text style={styles.optionTitle} numberOfLines={1}>{title}</Text>
                            <Text style={styles.optionSub}>
                                {compared.itemCount} prek{compared.itemCount === 1 ? 'ė' : 'ės'} ·
                                {' '}{new Date(compared.updatedAt).toLocaleDateString('lt-LT')}
                            </Text>
                        </View>
                        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.optionRow} onPress={onCreateNew}>
                        <Ionicons name="add-circle-outline" size={22} color={colors.primary} />
                        <View style={styles.optionBody}>
                            <Text style={styles.optionTitle}>Kurti naują krepšelį</Text>
                            <Text style={styles.optionSub}>Pradėti nuo tuščio</Text>
                        </View>
                        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
                        <Text style={styles.cancelText}>Atšaukti</Text>
                    </TouchableOpacity>
                </View>
            </View>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) =>
    StyleSheet.create({
        overlay: {
            flex: 1,
            backgroundColor: c.overlayBackdrop,
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
        },
        card: {
            backgroundColor: c.cardBackground,
            borderRadius: 16,
            padding: 18,
            width: '100%',
            maxWidth: 420,
            gap: 8,
        },
        title: { fontSize: 17, fontWeight: '700', color: c.textPrimary },
        sub: { fontSize: 12, color: c.textSecondary, marginBottom: 4 },
        optionRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingVertical: 12,
            paddingHorizontal: 10,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: c.border,
        },
        optionBody: { flex: 1 },
        optionTitle: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
        optionSub: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
        cancelButton: {
            alignSelf: 'center',
            paddingVertical: 10,
            paddingHorizontal: 16,
            marginTop: 4,
        },
        cancelText: { fontSize: 13, color: c.textSecondary, fontWeight: '600' },
    });
