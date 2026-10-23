import React, { memo } from 'react';
import { View, Image, StyleSheet } from 'react-native';
import QRCodeStyled from 'react-native-qrcode-styled';
import { useTheme } from '../constants/theme';

/**
 * Branded QR with rounded "dotted" modules, pink finder eyes, and a centre
 * logo set in an EXCAVATED hole (modules removed under it via `hidePieces`) —
 * not a sticker on top. Sits on a clean white card with a soft shadow. Renders
 * over react-native-svg (already a dep) so it's OTA-safe — no native rebuild.
 *
 * Colours are FIXED (white bg / ink dots) regardless of theme, because a QR
 * must stay dark-on-light to scan; only the finder eyes take the brand pink.
 */
const QR_DARK = '#16181D';

export const BrandedQR = memo(function BrandedQR({ value, size = 200, flat = false }: {
    value: string;
    size?: number;
    /** No drop-shadow / tighter frame — for clipped containers (in-sheet). */
    flat?: boolean;
}) {
    const colors = useTheme();
    const pink = colors.primary;
    const logoPx = Math.round(size * 0.22);
    return (
        <View style={[styles.card, flat && styles.cardFlat]}>
            <QRCodeStyled
                data={value}
                size={size}
                padding={Math.round(size * 0.04)}
                // High error correction so the excavated centre logo stays
                // scannable. Passed via spread because the `qrcode` option types
                // don't surface on the component props in this setup.
                {...({ errorCorrectionLevel: 'H' } as any)}
                color={QR_DARK}
                pieceBorderRadius={3}
                pieceCornerType="rounded"
                outerEyesOptions={{ borderRadius: 9, color: pink }}
                innerEyesOptions={{ borderRadius: 4, color: pink }}
                logo={{
                    href: require('../assets/images/icon.png'),
                    hidePieces: true,
                    // tight excavation — clear only a sliver beyond the logo
                    padding: 1,
                    width: logoPx,
                    height: logoPx,
                    // INVISIBLE in the SVG: it only drives the excavation. The
                    // RN <Image> overlay below is the single visible logo
                    // (the SVG image was flaky on remounts; two would stack).
                    opacity: 0,
                }}
            />
            {/* The ONLY visible logo — the SVG one above is opacity-0 and just
                excavates the hole (it was flaky on remounts). */}
            <View pointerEvents="none" style={styles.logoOverlayBox}>
                <Image
                    source={require('../assets/images/icon.png')}
                    style={{ width: logoPx, height: logoPx }}
                    resizeMode="contain"
                />
            </View>
        </View>
    );
});

const styles = StyleSheet.create({
    card: {
        backgroundColor: '#FFFFFF',
        borderRadius: 24,
        padding: 18,
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.12,
        shadowRadius: 16,
        elevation: 6,
    },
    // In-sheet: the glass clip would cut a drop-shadow at the sides — flat
    // card (no shadow, no border), tighter frame.
    logoOverlayBox: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
    cardFlat: {
        shadowOpacity: 0, shadowRadius: 0, elevation: 0, padding: 12,
    },
});
