import { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';
import { useTheme } from '../constants/theme';

/**
 * Top-edge progress glow — a thin 3px fill from the left with a soft downward
 * SVG bloom, pinned absolutely over the very top of its parent. The fill's
 * width animates to `fraction` (0..1). Extracted from ShoppingListDetail's
 * list glow (same styles/gradient); a keyed remount resets it to the new
 * context's own fraction.
 */
export function ProgressGlow({ fraction, color, edge = 'top' }: { fraction: number; color?: string; edge?: 'top' | 'bottom' }) {
    const colors = useTheme();
    const tint = color ?? colors.primary;
    const glow = useSharedValue(0);
    useEffect(() => { glow.value = withTiming(fraction, { duration: 400 }); }, [fraction]);
    const glowStyle = useAnimatedStyle(() => ({ width: `${glow.value * 100}%` }));
    return (
        // Bottom edge = flip the top-edge treatment vertically (line at the very
        // edge, bloom trailing inward), pinned to the bottom instead.
        //
        // The flip lives on an INNER view on purpose. With `transform` on the same
        // view that carries `elevation`, Android renders the glow BENEATH opaque
        // siblings — inside a row card the icon circle and text then punched holes
        // through the bloom. Keeping the elevated wrapper untransformed preserves
        // the stacking; only the artwork inside is mirrored.
        <View pointerEvents="none" style={[styles.glowWrap, edge === 'bottom' ? styles.glowWrapBottom : styles.glowWrapTop]}>
            <View style={[styles.glowFlipHost, edge === 'bottom' && styles.glowFlipped]}>
                <Animated.View style={[styles.glowFill, glowStyle]}>
                    <View style={[styles.glowLine, { backgroundColor: tint }]} />
                    <Svg width="100%" height={14} style={styles.glowBloom}>
                        <Defs>
                            <SvgLinearGradient id="progressGlow" x1="0" y1="0" x2="0" y2="1">
                                <Stop offset="0" stopColor={tint} stopOpacity="0.55" />
                                <Stop offset="1" stopColor={tint} stopOpacity="0" />
                            </SvgLinearGradient>
                        </Defs>
                        <Rect x="0" y="0" width="100%" height="14" fill="url(#progressGlow)" />
                    </Svg>
                </Animated.View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    glowWrap: { position: 'absolute', left: 0, right: 0, height: 17, zIndex: 30, elevation: 30 },
    glowWrapTop: { top: 0 },
    glowWrapBottom: { bottom: 0 },
    // The vertical mirror — kept OFF the elevated wrapper (see the note above).
    glowFlipHost: { height: '100%' },
    glowFlipped: { transform: [{ scaleY: -1 }] },
    glowFill: { height: '100%' },
    glowLine: { height: 3 },
    glowBloom: { marginTop: 0 },
});
