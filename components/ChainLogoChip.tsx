import React from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle, type ImageStyle } from 'react-native';
import { chainBadgeImage } from '../utils/chainLogoAssets';
import { chainBrandColorById } from '../utils/chainBrandName';

/**
 * Round chain badge — the EXACT baked map-pin asset (chip_N: the chain logo on
 * its brand-coloured disc + white ring, glyph centred with even padding around
 * it). Rendered as a plain <Image> so every off-map surface (results sheet,
 * shopping list, …) is pixel-identical to the map markers. Falls back to a brand
 * disc + initial only for chains with no bundled badge (e.g. Barbora).
 *
 * `onLogoLoad` fires when the image decodes (the map pill timed its snapshot off
 * this; kept for API compatibility).
 */
export function ChainLogoChip({
    chainId,
    name,
    size,
    logoUrl,
    onLogoLoad,
    style,
}: {
    chainId: number;
    name?: string;
    size: number;
    /** Fetched logo URL — used only when the chain has no bundled baked badge
     *  (e.g. an arbitrary scanned-receipt store), so it keeps its real logo
     *  instead of dropping to an initial. */
    logoUrl?: string | null;
    onLogoLoad?: () => void;
    style?: StyleProp<ViewStyle>;
}) {
    const badge = chainBadgeImage(chainId);

    if (badge != null) {
        return (
            <Image
                source={badge}
                onLoad={onLogoLoad}
                style={[{ width: size, height: size }, style as StyleProp<ImageStyle>]}
                resizeMode="contain"
            />
        );
    }

    // Unbundled chain: its fetched logo on a brand disc, or an initial as a last
    // resort — same round shape as the baked pin either way.
    return (
        <View
            style={[
                styles.chip,
                { width: size, height: size, borderRadius: size / 2, backgroundColor: chainBrandColorById(chainId) },
                style,
            ]}
        >
            {logoUrl ? (
                <Image source={{ uri: logoUrl }} onLoad={onLogoLoad} style={{ width: size * 0.66, height: size * 0.66 }} resizeMode="contain" />
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
