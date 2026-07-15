import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme, radius, type AppTheme } from '../constants/theme';

interface Props {
    quantity: number;
    onDecrement: () => void;
    onIncrement: () => void;
    /** Unit label shown between quantity and + button, e.g. "kg", "l". Omit for count items. */
    unit?: string | null;
    /** 'large' renders a taller control suited for bottom bars. Default: 'default'. */
    size?: 'default' | 'large';
    /** Makes the centre (number + unit) tappable — used to re-open the amount
     *  picker instead of stepping +/- many times. */
    onCenterPress?: () => void;
    style?: ViewStyle;
}

export function QuantityControl({ quantity, onDecrement, onIncrement, unit, size = 'default', onCenterPress, style }: Props) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const lg = size === 'large';
    const formatted = Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(1);

    return (
        <View style={[styles.quantityControl, lg && styles.quantityControlLg, style]}>
            <TouchableOpacity
                style={[styles.qtyButton, lg && styles.qtyButtonLg]}
                onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onDecrement(); }}
            >
                <Ionicons name="remove" size={lg ? 22 : 16} color={colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity
                style={styles.qtyCenter}
                disabled={!onCenterPress}
                onPress={onCenterPress}
                hitSlop={{ top: 8, bottom: 8 }}
            >
                <Text style={[styles.qtyText, lg && styles.qtyTextLg]}>{formatted}</Text>
                {unit ? <Text style={[styles.qtyUnit, lg && styles.qtyUnitLg]}>{unit}</Text> : null}
            </TouchableOpacity>
            <TouchableOpacity
                style={[styles.qtyButton, lg && styles.qtyButtonLg]}
                onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onIncrement(); }}
            >
                <Ionicons name="add" size={lg ? 22 : 16} color={colors.primary} />
            </TouchableOpacity>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    quantityControl: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderWidth: 1,
        borderColor: c.primary,
        borderRadius: radius.pill,
        paddingVertical: 6,
        paddingHorizontal: 10,
    },
    quantityControlLg: {
        paddingVertical: 13,
        paddingHorizontal: 16,
        borderRadius: radius.pill,
        borderWidth: 1.5,
    },
    qtyButton: {
        padding: 2,
    },
    qtyButtonLg: {
        padding: 6,
    },
    qtyCenter: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 3,
    },
    qtyText: {
        fontSize: 14,
        fontWeight: '700',
        color: c.primary,
        minWidth: 20,
        textAlign: 'center',
    },
    qtyTextLg: {
        fontSize: 20,
        minWidth: 32,
    },
    qtyUnit: {
        fontSize: 12,
        fontWeight: '500',
        color: c.textMuted,
    },
    qtyUnitLg: {
        fontSize: 16,
    },
});
