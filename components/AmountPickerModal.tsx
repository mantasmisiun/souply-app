import { View, Text, TouchableOpacity, StyleSheet, Modal, TextInput } from 'react-native';
import { useMemo, useState, useEffect } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, radius, elevation, type AppTheme } from '../constants/theme';

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
    /** Reopen/edit mode: prefill with the item's CURRENT amount instead of one
     *  step (tapping the quantity on a card re-opens this picker). */
    initialAmount?: number | null;
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

// Easter egg one-shot (per app session, mirrors the web picker's
// sessionStorage flag): tease the 50+ kg/l amount once, then let it through.
let bigAmountJokeShown = false;

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
    initialAmount = null,
    onConfirm,
    onCancel,
}: AmountPickerModalProps) {
    const colors = useTheme();
    const { t, i18n } = useTranslation();
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

    // Convert raw minAmount/maxAmount (stored in g/ml) to canonical unit scale.
    const needsScale = (unit === 'g' || unit === 'ml') && (displayUnit === 'kg' || displayUnit === 'l');
    const scale = needsScale ? 1000 : 1;
    const displayMin = minAmount / scale;
    const displayMax = maxAmount / scale;

    const fmtAmount = (n: number) =>
        new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 3 }).format(n);

    const formatValue = (n: number): string => {
        if (!isFractional) return String(Math.round(n));
        // Keep at most 3 significant fractional digits, trim trailing zeros.
        return Number(n.toFixed(3)).toString();
    };

    // Default start: the item's current amount when re-opened from a card's
    // quantity tap, else one step. Reset whenever the picker opens for a new
    // product so the previous user's choice doesn't leak.
    const defaultAmount = initialAmount != null && initialAmount > 0 ? initialAmount : step;
    const [inputText, setInputText] = useState(formatValue(defaultAmount));
    // Web-parity easter egg: 50+ kg/l gets one "math problem?" tease before
    // going through; a hard cap of 999 always applies.
    const [jokeAmount, setJokeAmount] = useState<number | null>(null);
    const isMassOrVolume = displayUnit === 'kg' || displayUnit === 'l';
    const JOKE_THRESHOLD = 50;
    const HARD_CAP = 999;

    useEffect(() => {
        if (visible) { setInputText(formatValue(defaultAmount)); setJokeAmount(null); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, productName, step, initialAmount]);

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
                {jokeAmount != null ? (
                    /* 50+ kg/l easter egg — same copy as the web picker. */
                    <View style={styles.modal}>
                        <Text style={styles.title}>{t('amountPicker.jokeTitle')}</Text>
                        <Text style={[styles.subtitle, { marginBottom: 24 }]}>
                            {t('amountPicker.jokeBody', { value: formatValue(jokeAmount), unit: displayUnit })}
                        </Text>
                        <View style={styles.actions}>
                            <TouchableOpacity style={styles.cancelButton} onPress={() => setJokeAmount(null)}>
                                <Text style={styles.cancelText}>{t('amountPicker.jokeCancel')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.confirmButton}
                                onPress={() => {
                                    bigAmountJokeShown = true;
                                    const v = jokeAmount;
                                    setJokeAmount(null);
                                    onConfirm(v);
                                }}
                            >
                                <Text style={styles.confirmText}>{t('amountPicker.jokeContinue')}</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                ) : (
                <View style={styles.modal}>
                    <Text style={styles.title}>{productName}</Text>
                    <Text style={styles.subtitle}>
                        {isWeighable
                            ? t('amountPicker.weighable')
                            : (displayMin === displayMax
                                ? t('amountPicker.packages', { count: 1, value: fmtAmount(displayMin), unit: displayUnit })
                                : t('amountPicker.packages', { count: 2, min: fmtAmount(displayMin), max: fmtAmount(displayMax), unit: displayUnit }))}
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
                                // Pass the user's exact requested quantity. The
                                // basket calc service picks the cheapest pack
                                // combination across all SPs to satisfy it —
                                // pre-snapping here would mislead the user
                                // about which pack actually gets picked.
                                const value = Math.min(Math.round(parseInput() * 1000) / 1000, HARD_CAP);
                                if (isMassOrVolume && value >= JOKE_THRESHOLD && !bigAmountJokeShown) {
                                    setJokeAmount(value);
                                    return;
                                }
                                onConfirm(value);
                            }}
                        >
                            <Text style={styles.confirmText}>{t('amountPicker.add')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
                )}
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
        borderRadius: radius.xl,
        padding: 24,
        width: '100%',
        maxWidth: 340,
        ...elevation.level3,
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
        borderRadius: radius.pill,
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
        borderRadius: radius.pill,
        backgroundColor: c.primary,
        alignItems: 'center',
    },
    confirmText: {
        fontSize: 14,
        color: c.onPrimary,
        fontWeight: '600',
    },
});
