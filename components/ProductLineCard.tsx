import { memo, useMemo } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ProductImage } from './ProductImage';
import { useTheme, radius, elevation, type AppTheme } from '../constants/theme';

type ImageUrlList = (string | null | undefined)[] | string | null;

type Props = {
    name: string;
    imageUrls?: ImageUrlList;
    /** Read-only mode (in-progress/completed basket, or default/auto template):
     *  hides the stepper + remove and shows a static quantity string. */
    readOnly?: boolean;
    /** Static quantity text shown when `readOnly` (e.g. "2 kg"). */
    readOnlyQtyText?: string;
    /** In-flight editable quantity value (the controlled input string). */
    quantityText?: string;
    /** Unit label after the stepper (e.g. "kg" / "vnt."). */
    unit?: string;
    /** Weighable rows use a decimal keypad; piece rows a number pad. */
    weighable?: boolean;
    /** Raw text passthrough — the caller validates + stores (keeps each
     *  screen's existing validation). Reject by simply not updating state. */
    onChangeQuantity?: (v: string) => void;
    /** Fired on blur with the final text; caller parses + commits. */
    onCommitQuantity?: (text: string) => void;
    onDecrement?: () => void;
    onIncrement?: () => void;
    onRemove?: () => void;
};

/**
 * Unified basket / template line-item card. Single source of truth for the
 * row shown in both basket detail and template detail (and any future
 * item-list surface), so the two stay visually identical. Presentational —
 * each screen passes its own quantity handlers.
 */
function ProductLineCard({
    name, imageUrls,
    readOnly = false, readOnlyQtyText = '',
    quantityText, unit = '', weighable = false,
    onChangeQuantity, onCommitQuantity, onDecrement, onIncrement, onRemove,
}: Props) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    return (
        <View style={styles.card}>
            <ProductImage
                uris={imageUrls}
                imageStyle={styles.productImage}
                placeholderStyle={styles.productImagePlaceholder}
                emojiStyle={styles.productImageEmoji}
            />
            <View style={styles.cardContent}>
                <Text style={styles.itemName} numberOfLines={2}>{name}</Text>
                {readOnly ? (
                    <Text style={styles.readonlyQty}>{readOnlyQtyText}</Text>
                ) : (
                    <View style={styles.controls}>
                        <TouchableOpacity style={styles.controlButton} onPress={onDecrement}>
                            <Ionicons name="remove" size={18} color={colors.primary} />
                        </TouchableOpacity>
                        {/* Box owns the visual border + corner clipping so the
                            Android system TextInput underline has nothing to draw
                            against and can't bleed through. */}
                        <View style={styles.quantityInputBox}>
                            <TextInput
                                style={styles.quantityInput}
                                value={quantityText}
                                onChangeText={onChangeQuantity}
                                onEndEditing={(e) => onCommitQuantity?.(e.nativeEvent.text)}
                                keyboardType={weighable ? 'decimal-pad' : 'number-pad'}
                                selectTextOnFocus
                                underlineColorAndroid="transparent"
                            />
                        </View>
                        <Text style={styles.unitLabel}>{unit}</Text>
                        <TouchableOpacity style={styles.controlButton} onPress={onIncrement}>
                            <Ionicons name="add" size={18} color={colors.primary} />
                        </TouchableOpacity>
                    </View>
                )}
            </View>
            {!readOnly && onRemove && (
                <TouchableOpacity style={styles.removeButton} onPress={onRemove}>
                    <Ionicons name="trash-outline" size={20} color={colors.error} />
                </TouchableOpacity>
            )}
        </View>
    );
}

export default memo(ProductLineCard);

const makeStyles = (c: AppTheme) => StyleSheet.create({
    card: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: c.cardBackground, borderRadius: radius.lg,
        padding: 12, marginBottom: 8, gap: 12,
        ...elevation.level1,
    },
    productImage: { width: 44, height: 44, borderRadius: radius.md },
    productImagePlaceholder: {
        width: 44, height: 44, borderRadius: radius.md,
        backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center',
    },
    productImageEmoji: { fontSize: 24, opacity: 0.5 },
    cardContent: { flex: 1, gap: 6 },
    itemName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    controls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    controlButton: {
        width: 28, height: 28, borderRadius: radius.md,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.primaryMuted,
    },
    quantityInputBox: {
        minWidth: 48, borderWidth: 1, borderColor: c.border, borderRadius: radius.md,
        overflow: 'hidden', backgroundColor: c.cardBackground,
    },
    quantityInput: {
        paddingHorizontal: 8, paddingVertical: 4,
        textAlign: 'center', fontSize: 14, fontWeight: '600',
        color: c.textPrimary, borderWidth: 0,
    },
    unitLabel: { fontSize: 13, fontWeight: '600', color: c.textSecondary, minWidth: 28 },
    readonlyQty: { fontSize: 13, fontWeight: '600', color: c.textSecondary },
    removeButton: { padding: 4 },
});
