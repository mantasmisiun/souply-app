import { memo, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ProductImage } from '../ProductImage';
import { ChainLogoStrip } from '../ChainLogoStrip';
import { ScalePressable } from '../ScalePressable';
import { useTheme, type AppTheme } from '../../constants/theme';

type ImageUrlList = (string | null | undefined)[] | string | null;
type ChainLogo = { chainId: number; logoUrl: string | null };

export interface AdminProduct {
    id: number;
    name: string;
    categoryId?: number | null;
    imageUrls?: ImageUrlList;
    chainLogos?: ChainLogo[] | string | null;
    categoryName?: string | null;
    minAmount: number | null;
    maxAmount: number | null;
    unit: string | null;
    canonicalUnit: string | null;
    canonicalStep: number | null;
    canonicalFamily: 'fluid' | 'count' | null;
    hasWeighable: boolean;
    globalScore?: number | null;
}

interface Props {
    product: AdminProduct;
    selectionMode: boolean;
    selected: boolean;
    onPress: () => void;
    onLongPress: () => void;
}

function AdminProductCard({ product, selectionMode, selected, onPress, onLongPress }: Props) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const isVolume = product.unit === 'ml' || product.canonicalUnit === 'l';
    const bigUnit = isVolume ? 'l' : 'kg';
    const smallUnit = isVolume ? 'ml' : 'g';
    const fmt = (v: number) => v >= 1000 ? `${v / 1000} ${bigUnit}` : `${v} ${smallUnit}`;
    const amountText = product.minAmount != null && product.maxAmount != null
        ? (() => {
            const mn = Number(product.minAmount);
            const mx = Number(product.maxAmount);
            return mn === mx ? fmt(mn) : `${fmt(mn)} – ${fmt(mx)}`;
        })()
        : null;

    return (
        <ScalePressable
            style={[styles.card, selected && styles.cardSelected]}
            onPress={onPress}
            onLongPress={onLongPress}
        >
            {/* Checkbox (selection mode) */}
            {selectionMode && (
                <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
                    {selected && <Ionicons name="checkmark" size={13} color="#fff" />}
                </View>
            )}

            {/* Product ID badge */}
            <View style={styles.idBadge}>
                <Text style={styles.idText}>{product.id}</Text>
            </View>

            {/* Image */}
            <TouchableOpacity
                activeOpacity={0.8}
                style={styles.imageContainer}
                onPress={onPress}
                onLongPress={onLongPress}
            >
                <ProductImage
                    uris={product.imageUrls}
                    imageStyle={styles.image}
                    placeholderStyle={styles.imagePlaceholder}
                    emojiStyle={styles.imageEmoji}
                />
                {product.chainLogos && (
                    <ChainLogoStrip
                        chainLogos={product.chainLogos}
                        style={{ position: 'absolute', bottom: 4, left: 4 }}
                    />
                )}
            </TouchableOpacity>

            {/* Info */}
            <View style={styles.info}>
                <Text style={styles.name} numberOfLines={3}>{product.name}</Text>
                {product.categoryName ? (
                    <Text style={styles.categoryLabel} numberOfLines={1}>{product.categoryName}</Text>
                ) : null}
                {amountText ? (
                    <Text style={styles.amount}>{amountText}</Text>
                ) : null}
            </View>
        </ScalePressable>
    );
}

export default memo(AdminProductCard);

const makeStyles = (c: AppTheme) => StyleSheet.create({
    card: {
        backgroundColor: c.cardBackground,
        borderRadius: 12,
        padding: 12,
        alignItems: 'center',
        elevation: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
        flex: 1,
        maxWidth: '50%',
        borderWidth: 1.5,
        borderColor: 'transparent',
    },
    cardSelected: {
        borderColor: c.primary,
        backgroundColor: c.primary + '10',
    },
    checkbox: {
        position: 'absolute',
        top: 8,
        left: 8,
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 1.5,
        borderColor: c.textMuted,
        backgroundColor: c.cardBackground,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
    },
    checkboxSelected: {
        backgroundColor: c.primary,
        borderColor: c.primary,
    },
    idBadge: {
        position: 'absolute',
        top: 8,
        right: 8,
        backgroundColor: c.surfaceMuted,
        borderRadius: 4,
        paddingHorizontal: 4,
        paddingVertical: 2,
        zIndex: 10,
    },
    idText: {
        fontSize: 9,
        fontWeight: '700',
        color: c.textMuted,
        letterSpacing: 0.3,
    },
    imageContainer: {
        width: '100%',
        height: 120,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 8,
    },
    image: { width: '100%', height: '100%' },
    imagePlaceholder: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c.surfaceMuted,
        borderRadius: 8,
    },
    imageEmoji: { fontSize: 40, opacity: 0.4 },
    info: { flex: 1, width: '100%' },
    name: { fontSize: 13, color: c.textPrimary, lineHeight: 18 },
    categoryLabel: {
        fontSize: 11,
        color: c.primary,
        marginTop: 3,
        fontWeight: '500',
    },
    amount: { fontSize: 11, color: c.textMuted, marginTop: 2 },
});
