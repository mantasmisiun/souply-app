import { View, Text, TouchableOpacity, StyleSheet, Modal, TextInput } from 'react-native';
import { useMemo, useState, useEffect } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../constants/theme';

interface AmountPickerModalProps {
    visible: boolean;
    productName: string;
    /**
     * Canonical display unit decided server-side from the Product's SPs.
     * Always kg / l / vnt / pak / rit — never g / ml. Falls back to `unit`
     * (legacy) when canonicalUnit is null (Product has no SPs / unknown).
     */
    canonicalUnit?: string | null;
    /**
     * Step in canonical units (e.g. 0.5 when the smallest pack is 500ml
     * and canonical is l). The +/- buttons step by this amount; the
     * confirmed value is rounded up to the next multiple.
     */
    canonicalStep?: number | null;
    /**
     * Family: `fluid` (kg/l) or `count` (vnt/pak/rit). Drives small UX
     * decisions like decimal formatting.
     */
    canonicalFamily?: 'fluid' | 'count' | null;
    /** Legacy fallback shown in the subtitle when canonical isn't set. */
    minAmount: number;
    maxAmount: number;
    unit: string;
    /** True when the product is sold by weight (bulk fruit/veg/meat). */
    isWeighable?: boolean;
    /**
     * Called with the user's chosen amount in **canonical units** (kg, l,
     * or pack-content count). The server interprets this as the requested
     * total — for non-weighables it rounds up to whole packs and charges
     * accordingly. The picker enforces "multiple of canonicalStep" on
     * confirm so the user can't request a quantity that wastes a fraction
     * of a pack.
     */
    onConfirm: (amount: number) => void;
    onCancel: () => void;
}

export default function AmountPickerModal({
    visible,
    productName,
    canonicalUnit,
    canonicalStep,
    canonicalFamily,
    minAmount,
    maxAmount,
    unit,
    isWeighable = false,
    onConfirm,
    onCancel,
}: AmountPickerModalProps) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    // Resolve effective unit + step. New canonical fields win; legacy
    // props are a fallback for Products fetched before the server attached
    // canonical metadata (e.g. cached responses, older clients).
    const displayUnit = canonicalUnit ?? (unit === 'g' ? 'kg' : unit === 'ml' ? 'l' : unit);
    const step = canonicalStep && canonicalStep > 0
        ? canonicalStep
        : (isWeighable || displayUnit === 'kg' || displayUnit === 'l' ? 0.1 : 1);
    // Fractional steps (kg / l with pack sizes like 0.5) want decimal
    // formatting; whole-number steps (vnt / pak) want integers.
    const isFractional = step < 1 || canonicalFamily === 'fluid';

    const formatValue = (n: number): string => {
        if (!isFractional) return String(Math.round(n));
        // Keep at most 3 significant fractional digits, trim trailing zeros.
        return Number(n.toFixed(3)).toString();
    };

    // Default start: one step. Reset whenever the picker opens for a new
    // product so the previous user's choice doesn't leak.
    const defaultAmount = step;
    const [inputText, setInputText] = useState(formatValue(defaultAmount));

    useEffect(() => {
        if (visible) setInputText(formatValue(defaultAmount));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, productName, step]);

    const parseInput = (): number => {
        const parsed = parseFloat(inputText.replace(',', '.'));
        return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultAmount;
    };

    const decrease = () => {
        const current = parseInput();
        const next = current - step;
        if (next >= step - 1e-9) {
            setInputText(formatValue(Math.round(next / step) * step));
        }
    };

    const increase = () => {
        const current = parseInput();
        const next = current + step;
        setInputText(formatValue(Math.round(next / step) * step));
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
                        {isWeighable
                            ? t('amountPicker.weighable')
                            : (minAmount === maxAmount
                                ? t('amountPicker.packages', { count: 1, value: minAmount, unit })
                                : t('amountPicker.packages', { count: 2, min: minAmount, max: maxAmount, unit }))}
                    </Text>

                    <Text style={styles.label}>{t('amountPicker.label')}</Text>

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

                    {(() => {
                        // Preview the step-snap target when the user has typed
                        // something that doesn't fall on a valid pack multiple.
                        // Communicates "you'll actually get N" before they tap
                        // Add, so the round-up isn't a surprise.
                        const raw = parseInput();
                        const snapped = Math.max(step, Math.ceil(raw / step) * step);
                        const diff = Math.abs(snapped - raw);
                        if (diff < 1e-6) return null;
                        return (
                            <Text style={styles.roundUpHint}>
                                {t('amountPicker.willGet', { amount: formatValue(snapped), unit: displayUnit })}
                            </Text>
                        );
                    })()}

                    <Text style={styles.hint}>
                        {isWeighable ? t('amountPicker.hintWeighable') : t('amountPicker.hintPackages')}
                    </Text>

                    <View style={styles.actions}>
                        <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
                            <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.confirmButton}
                            onPress={() => {
                                const value = parseInput();
                                // Snap to the nearest step multiple ≥ value so the
                                // server doesn't round up surprisingly (avoids the
                                // user typing "1.3" and getting charged for 1.5).
                                const snapped = Math.max(step, Math.ceil(value / step) * step);
                                onConfirm(Math.round(snapped * 1000) / 1000);
                            }}
                        >
                            <Text style={styles.confirmText}>{t('amountPicker.add')}</Text>
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
    // Preview shown when the typed value rounds up to the next pack —
    // primary tint so it reads as "this is what you'll get" rather than
    // a passive hint.
    roundUpHint: {
        fontSize: 12,
        fontWeight: '600',
        color: c.primary,
        textAlign: 'center',
        marginTop: 4,
        marginBottom: 4,
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
