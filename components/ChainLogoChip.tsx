import React from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { chainGlyphScale, chainMiniLogo } from '../utils/chainLogoAssets';
import { chainBrandColorById } from '../utils/chainBrandName';

/**
 * Round chain badge: the chain glyph centred on its brand-coloured disc. One
 * component for every surface (results sheet + map pill) so the logo treatment
 * stays identical everywhere.
 *
 * `onLogoLoad` fires when the glyph image finishes decoding — the map pill uses
 * it to take its marker snapshot only AFTER the logo has painted (a React
 * <Image> inside a custom marker otherwise rasterises empty on Android).
 */
export function ChainLogoChip({
    chainId,
    name,
    size,
    onLogoLoad,
    style,
}: {
    chainId: number;
    name?: string;
    size: number;
    onLogoLoad?: () => void;
    style?: StyleProp<ViewStyle>;
}) {
    const brand = chainBrandColorById(chainId);
    const glyph = chainMiniLogo(chainId);
    const scale = chainGlyphScale(chainId);

    return (
        <View
            style={[
                styles.chip,
                { width: size, height: size, borderRadius: size / 2, backgroundColor: brand },
                style,
            ]}
        >
            {glyph != null ? (
                <Image
                    source={glyph}
                    onLoad={onLogoLoad}
                    style={{ width: size * scale, height: size * scale }}
                    resizeMode="contain"
                />
            ) : (
                <Text style={[styles.fallback, { fontSize: size * 0.5 }]}>
                    {(name?.[0] ?? '?').toUpperCase()}
                </Text>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    chip: {
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        // Hairline so the light chips (Lidl yellow) stay defined on white.
        borderWidth: 1,
        borderColor: 'rgba(0,0,0,0.12)',
    },
    fallback: { color: '#FFFFFF', fontWeight: '800' },
});
