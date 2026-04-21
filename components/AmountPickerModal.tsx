import { View, Text, TouchableOpacity, StyleSheet, Modal, TextInput } from 'react-native';
import { useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../constants/theme';

interface AmountPickerModalProps {
    visible: boolean;
    productName: string;
    minAmount: number;
    maxAmount: number;
    unit: string;
    onConfirm: (amount: number) => void;
    onCancel: () => void;
}

export default function AmountPickerModal({
    visible,
    productName,
    minAmount,
    maxAmount,
    unit,
    onConfirm,
    onCancel,
}: AmountPickerModalProps) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const isKg = unit === 'kg' || unit === 'g';
    const step = isKg ? 0.1 : 1;
    const defaultAmount = isKg ? 1.0 : 1;
    const [amount, setAmount] = useState(defaultAmount);
    const displayAmount = isKg ? amount.toFixed(1) : amount.toString();
    const [inputText, setInputText] = useState(isKg ? '1.0' : '1');
    const displayUnit = isKg ? 'kg' : unit;
    const decrease = () => {
        const current = parseFloat(inputText) || 0;
        const newAmount = Math.round((current - step) * 10) / 10;
        if (newAmount >= step) {
            setInputText(isKg ? newAmount.toFixed(1) : newAmount.toString());
        }
    };

    const increase = () => {
        const current = parseFloat(inputText) || 0;
        const newAmount = Math.round((current + step) * 10) / 10;
        setInputText(isKg ? newAmount.toFixed(1) : newAmount.toString());
    };

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onCancel}
        >
            <View style={styles.overlay}>
                <View style={styles.modal}>
                    <Text style={styles.title}>{productName}</Text>
                    <Text style={styles.subtitle}>
                        Pakuotės: {minAmount === maxAmount
                            ? `${minAmount} ${unit}`
                            : `${minAmount} – ${maxAmount} ${unit}`
                        }
                    </Text>

                    <Text style={styles.label}>Kiek jums reikia?</Text>

                    <View style={styles.pickerRow}>
                        <TouchableOpacity style={styles.roundButton} onPress={decrease}>
                            <Ionicons name="remove" size={22} color={colors.primary} />
                        </TouchableOpacity>

                        <View style={styles.inputContainer}>
                            <TextInput
                                style={styles.input}
                                value={inputText}
                                onChangeText={setInputText}
                                keyboardType="decimal-pad"
                                selectTextOnFocus
                            />
                            <Text style={styles.unitText}>{displayUnit}</Text>
                        </View>

                        <TouchableOpacity style={styles.roundButton} onPress={increase}>
                            <Ionicons name="add" size={22} color={colors.primary} />
                        </TouchableOpacity>
                    </View>

                    <Text style={styles.hint}>
                        Kiekis bus suapvalintas pagal pakuotės dydį
                    </Text>

                    <View style={styles.actions}>
                        <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
                            <Text style={styles.cancelText}>Atšaukti</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.confirmButton}
                            onPress={() => {
                                const parsed = parseFloat(inputText.replace(',', '.'));
                                if (!isNaN(parsed) && parsed > 0) {
                                    onConfirm(Math.round(parsed * 10) / 10);
                                }
                            }}
                        >
                            <Text style={styles.confirmText}>Pridėti</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: c.overlayBackdrop,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    modal: {
        backgroundColor: c.cardBackground,
        borderRadius: 16,
        padding: 24,
        width: '100%',
        maxWidth: 340,
    },
    title: {
        fontSize: 17,
        fontWeight: '700',
        color: c.textPrimary,
        textAlign: 'center',
        marginBottom: 4,
    },
    subtitle: {
        fontSize: 13,
        color: c.textSecondary,
        textAlign: 'center',
        marginBottom: 20,
    },
    label: {
        fontSize: 14,
        color: c.textPrimary,
        textAlign: 'center',
        marginBottom: 12,
    },
    pickerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        marginBottom: 8,
    },
    roundButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        borderWidth: 1.5,
        borderColor: c.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 4,
    },
    input: {
        fontSize: 28,
        fontWeight: '700',
        color: c.primary,
        textAlign: 'center',
        minWidth: 60,
        paddingVertical: 4,
        borderBottomWidth: 2,
        borderBottomColor: c.primary,
    },
    unitText: {
        fontSize: 16,
        color: c.textSecondary,
        fontWeight: '500',
    },
    hint: {
        fontSize: 11,
        color: c.textMuted,
        textAlign: 'center',
        marginBottom: 20,
    },
    actions: {
        flexDirection: 'row',
        gap: 12,
    },
    cancelButton: {
        flex: 1,
        paddingVertical: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.border,
        alignItems: 'center',
    },
    cancelText: {
        fontSize: 14,
        color: c.textSecondary,
        fontWeight: '600',
    },
    confirmButton: {
        flex: 1,
        paddingVertical: 12,
        borderRadius: 10,
        backgroundColor: c.primary,
        alignItems: 'center',
    },
    confirmText: {
        fontSize: 14,
        color: c.onPrimary,
        fontWeight: '600',
    },
});
