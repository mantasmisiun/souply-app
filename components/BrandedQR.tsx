import React from 'react';
import { View, StyleSheet } from 'react-native';
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

export function BrandedQR({ value, size = 200 }: { value: string; size?: number }) {
    const colors = useTheme();
    const pink = colors.primary;
    const logoPx = Math.round(size * 0.22);
    return (
        <View style={styles.card}>
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
                    padding: 4,
                    width: logoPx,
                    height: logoPx,
                }}
            />
        </View>
    );
}

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
});
