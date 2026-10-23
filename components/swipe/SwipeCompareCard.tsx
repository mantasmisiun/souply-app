import { useMemo } from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import { ProductImage } from '../ProductImage';
import { useTheme, type AppTheme } from '../../constants/theme';

/**
 * THE product-pair card — "are these two the same product?" — as seen in the
 * mandatory/voluntary swipe queue.
 *
 * Extracted so the queue and the vote-history sheet render the SAME component
 * rather than two drifting copies of the same card: chain row (logo + name),
 * product image, product name, one side above the other with a hairline between.
 *
 * Purely presentational — no gestures, no buttons. The queue wraps
 * `ComparePairContent` in its animated, swipeable shell; anywhere else,
 * `SwipeCompareCard` supplies the same shell as a plain card.
 */
export interface CompareSide {
    name: string;
    chainName: string;
    chainLogoUrl?: string | null;
    imageUrl?: string | null;
}

const { width: SCREEN_W } = Dimensions.get('window');
const STAGE_H_PAD = 16;
const CARD_W = SCREEN_W - STAGE_H_PAD * 2;
/** Image edge: half the card's inner width, capped — same maths as the queue. */
const IMG_SIZE = Math.min(140, Math.floor((CARD_W - 24) / 2) - 8);

function CardSide({ side, styles, onSettled }: {
    side: CompareSide;
    styles: ReturnType<typeof makeStyles>;
    onSettled?: (ok: boolean) => void;
}) {
    return (
        <View style={styles.half}>
            <View style={styles.chainRow}>
                {side.chainLogoUrl ? (
                    <Image source={{ uri: side.chainLogoUrl }} style={styles.chainLogo} contentFit="contain" />
                ) : null}
                <Text style={styles.chainName} numberOfLines={1}>{side.chainName}</Text>
            </View>

            <ProductImage
                uris={side.imageUrl ? [side.imageUrl] : []}
                imageStyle={styles.productImg}
                placeholderStyle={styles.productImgPlaceholder}
                emojiStyle={styles.productImgEmoji}
                resizeMode="contain"
                onSettled={onSettled}
            />

            <Text style={styles.productName} numberOfLines={5}>{side.name}</Text>
        </View>
    );
}

/** The card's INNER content — for hosts that draw their own card shell. */
export function ComparePairContent({ left, right, onSettledLeft, onSettledRight }: {
    left: CompareSide;
    right: CompareSide;
    onSettledLeft?: (ok: boolean) => void;
    onSettledRight?: (ok: boolean) => void;
}) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    return (
        <>
            <CardSide side={left} styles={styles} onSettled={onSettledLeft} />
            <View style={styles.horizontalDivider} />
            <CardSide side={right} styles={styles} onSettled={onSettledRight} />
        </>
    );
}

/** The whole card, shell included. */
export function SwipeCompareCard({ left, right, style }: {
    left: CompareSide;
    right: CompareSide;
    style?: any;
}) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    return (
        <View style={[styles.card, style]}>
            <View style={styles.cardInner}>
                <ComparePairContent left={left} right={right} />
            </View>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    card: {
        alignSelf: 'stretch',
        maxWidth: CARD_W,
        backgroundColor: c.cardBackground,
        borderRadius: 20,
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.12,
        shadowRadius: 10,
        elevation: 4,
    },
    cardInner: { flexDirection: 'column', paddingHorizontal: 14, paddingVertical: 14 },
    horizontalDivider: { height: 1, backgroundColor: c.border, width: '100%', marginVertical: 10 },
    half: { width: '100%', alignItems: 'center', paddingVertical: 4 },
    chainRow: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        marginBottom: 6, width: '100%', justifyContent: 'center',
    },
    chainLogo: { width: 16, height: 16 },
    chainName: {
        fontSize: 10, fontWeight: '700', color: c.textMuted,
        letterSpacing: 0.8, textTransform: 'uppercase', flexShrink: 1,
    },
    productImg: { width: IMG_SIZE, height: IMG_SIZE },
    productImgPlaceholder: {
        width: IMG_SIZE, height: IMG_SIZE,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.surfaceMuted, borderRadius: 8,
    },
    productImgEmoji: { fontSize: IMG_SIZE * 0.55, opacity: 0.4 },
    productName: {
        fontSize: 12, fontWeight: '600', color: c.textPrimary,
        textAlign: 'center', marginTop: 8, lineHeight: 17,
    },
});
