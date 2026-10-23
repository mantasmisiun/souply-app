import React, { useCallback, useMemo, useState } from 'react';
import { Text, TouchableOpacity, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { QuantityControl } from './QuantityControl';
import AmountPickerModal from './AmountPickerModal';
import { productStep, productUsesPicker, productAmountParts, unitLabel } from '../utils/amountDisplay';
import { useTheme, radius, type AppTheme } from '../constants/theme';

/**
 * AddOrStepper — the ONE "Add ⇄ stepper" control, reused across the product
 * card, product detail, list sheet, search and discounts. It owns everything
 * those surfaces used to copy-paste:
 *   · the toggle: an Add button when quantity is 0, else the QuantityControl;
 *   · the weight/count decision: WEIGHT items (canonicalFamily 'fluid') open the
 *     AmountPickerModal on tap and step 0.1; COUNT items add one directly and
 *     step 1 — all via utils/amountDisplay (productUsesPicker / productStep);
 *   · the amount + unit shown next to the stepper, with grams/ml polish, via
 *     productAmountParts + unitLabel — the SAME formatter every surface uses.
 *
 * Persistence stays with the caller: `onCommit(qty)` is called with the new
 * quantity (0 = remove) and the parent writes it (draft basket / session /
 * template). `size` adapts it to each surface.
 */

export interface SteppableProduct {
    id?: number;
    name?: string | null;
    canonicalUnit?: string | null;
    canonicalStep?: number | null;
    canonicalFamily?: 'fluid' | 'count' | null;
    isWeighable?: boolean;
    hasWeighable?: boolean | number;
    minAmount?: number | null;
    maxAmount?: number | null;
    unit?: string | null;
}

interface Props {
    product: SteppableProduct;
    quantity: number;
    /** Persist the new quantity. 0 = remove. */
    onCommit: (qty: number) => void;
    size?: 'default' | 'large';
    /** Add-button label (defaults to the generic "Add"). */
    addLabel?: string;
    addIcon?: keyof typeof Ionicons.glyphMap;
    /** Spinner + disabled on the Add button (in-flight add). */
    busy?: boolean;
    fullWidth?: boolean;
    /** Skip the amount picker (contexts that can't re-edit, e.g. plain lists). */
    noPicker?: boolean;
    /** Drop the leading icon on the Add button (grid cards keep a text-only CTA). */
    noIcon?: boolean;
    style?: StyleProp<ViewStyle>;
}

const weighable = (p: SteppableProduct) => !!(p.isWeighable ?? p.hasWeighable);

export function AddOrStepper({
    product, quantity, onCommit, size = 'default', addLabel, addIcon = 'cart-outline',
    busy, fullWidth, noPicker, noIcon, style,
}: Props) {
    const colors = useTheme();
    const { t } = useTranslation();
    const lg = size === 'large';
    const styles = useMemo(() => makeStyles(colors, lg), [colors, lg]);
    const [pickerOpen, setPickerOpen] = useState(false);

    // ONE signal drives step / picker / display — canonicalFamily (see
    // utils/amountDisplay). Weight items step 0.1 and open the picker; count
    // items step 1 and add directly.
    const step = productStep(product);
    const usesPicker = !noPicker && productUsesPicker(product);
    // The amount + unit shown in the stepper: weight items in kg/l with grams/ml
    // polish (0.5 → "500 g"), count items as an integer count. Never divides.
    const parts = productAmountParts(product, quantity);
    const unit = unitLabel(parts.unit, t);

    const onAdd = useCallback(() => {
        if (busy) return;
        if (usesPicker) { setPickerOpen(true); return; }
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        onCommit(step);
    }, [busy, usesPicker, step, onCommit]);

    const inc = useCallback(() => {
        onCommit(Math.round((quantity + step) * 1000) / 1000);
    }, [quantity, step, onCommit]);
    const dec = useCallback(() => {
        const next = Math.round((quantity - step) * 1000) / 1000;
        onCommit(next < step - 1e-9 ? 0 : next);
    }, [quantity, step, onCommit]);

    const flat = StyleSheet.flatten([fullWidth ? { width: '100%' as const } : null, style]);

    return (
        <>
            {quantity > 0 ? (
                <QuantityControl
                    quantity={parts.value}
                    unit={unit}
                    size={size}
                    onDecrement={dec}
                    onIncrement={inc}
                    onCenterPress={usesPicker ? () => setPickerOpen(true) : undefined}
                    style={flat}
                />
            ) : (
                <TouchableOpacity
                    style={[styles.addBtn, fullWidth && styles.addBtnFull, busy && styles.addBtnBusy, style]}
                    onPress={onAdd}
                    disabled={busy}
                    activeOpacity={0.85}
                >
                    {busy
                        ? <MaterialProgress size="small" color={colors.onPrimary} />
                        : !noIcon && <Ionicons name={addIcon} size={lg ? 20 : 16} color={colors.onPrimary} />}
                    <Text style={styles.addText} numberOfLines={1}>{addLabel ?? t('basketSession.add')}</Text>
                </TouchableOpacity>
            )}

            {usesPicker && (
                <AmountPickerModal
                    visible={pickerOpen}
                    productName={product.name ?? ''}
                    productId={product.id}
                    canonicalUnit={product.canonicalUnit}
                    canonicalStep={product.canonicalStep}
                    canonicalFamily={product.canonicalFamily}
                    minAmount={product.minAmount ?? 0}
                    maxAmount={product.maxAmount ?? 0}
                    unit={product.unit ?? ''}
                    isWeighable={weighable(product)}
                    initialAmount={quantity > 0 ? quantity : undefined}
                    onConfirm={(amount) => {
                        setPickerOpen(false);
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                        onCommit(amount);
                    }}
                    onCancel={() => setPickerOpen(false)}
                />
            )}
        </>
    );
}

const makeStyles = (c: AppTheme, lg: boolean) => StyleSheet.create({
    addBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
        backgroundColor: c.primary,
        borderRadius: radius.pill,
        paddingHorizontal: lg ? 20 : 14,
        paddingVertical: lg ? 13 : 8,
    },
    addBtnFull: { width: '100%' },
    addBtnBusy: { opacity: 0.6 },
    addText: { color: c.onPrimary, fontWeight: '800', fontSize: lg ? 16 : 14 },
});
