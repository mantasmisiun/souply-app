import React from 'react';
import { View, useColorScheme, type StyleProp, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * One glass surface, best material per OS:
 *   • iOS 26+ (and only when the native module is in THIS build) → Apple's
 *     native **Liquid Glass** (`expo-glass-effect`'s GlassView).
 *   • everything else → the element's ORIGINAL look (`fallback`):
 *       - 'solid' → a plain View showing the style's backgroundColor (used for
 *         things that were solid before — map controls — so Android/old iOS are
 *         unchanged).
 *       - 'blur'  → expo-blur BlurView (the previous glass approximation, kept
 *         for surfaces that were already blur, e.g. the search bar).
 *
 * The native-module gate (`requireOptionalNativeModule` → null when absent)
 * means a build that PREDATES the install — the current dev client over Metro —
 * never tries to render the unregistered native view (no warning, no breakage);
 * it just uses the fallback until you rebuild.
 */
let GlassView: React.ComponentType<any> | null = null;
let HAS_LIQUID_GLASS = false;
try {
    if (requireOptionalNativeModule('ExpoGlassEffect')) {
         
        const mod = require('expo-glass-effect');
        HAS_LIQUID_GLASS = typeof mod?.isLiquidGlassAvailable === 'function' && mod.isLiquidGlassAvailable();
        if (HAS_LIQUID_GLASS) GlassView = mod.GlassView;
    }
} catch {
    HAS_LIQUID_GLASS = false;
    GlassView = null;
}

export function LiquidGlass({
    style,
    children,
    tintColor,
    interactive = true,
    fallback = 'blur',
    glassStyle = 'regular',
    intensity = 50,
    blurTint,
    forceFallback = false,
}: {
    style?: StyleProp<ViewStyle>;
    children?: React.ReactNode;
    tintColor?: string;
    interactive?: boolean;
    fallback?: 'blur' | 'solid';
    /** Skip the native Liquid Glass even when available and render the
     *  fallback material. The native glass draws its own specular RIM at the
     *  view's edges — right for buttons/pills, but on a large sheet surface it
     *  reads as an unwanted edge decoration; the blur fallback has no rim. */
    forceFallback?: boolean;
    /** iOS 26 material flavour: 'regular' (default) or 'clear' — clear carries
     *  almost no tint, for surfaces stacked ON another glass (e.g. option cards
     *  on the results sheet) so glass-on-glass doesn't go muddy. */
    glassStyle?: 'regular' | 'clear';
    /** Blur-fallback strength (expo-blur intensity). Default matches the old
     *  hardcoded 50; lighter stacked surfaces pass more blur + less tint. */
    intensity?: number;
    /** Blur-fallback tint override. Stacking two scheme-tinted blurs COMPOUNDS
     *  the tint (dark-on-dark goes muddier, not lighter) — a surface layered on
     *  another glass passes 'light' so it LIGHTENS what's beneath instead. */
    blurTint?: 'light' | 'dark' | 'default';
}) {
    const scheme = useColorScheme();
    if (!forceFallback && HAS_LIQUID_GLASS && GlassView) {
        // Strip any solid backgroundColor so the glass material shows through.
        return (
            <GlassView
                style={[style, { backgroundColor: 'transparent' }]}
                glassEffectStyle={glassStyle}
                tintColor={tintColor}
                isInteractive={interactive}
            >
                {children}
            </GlassView>
        );
    }
    if (fallback === 'solid') {
        return <View style={style}>{children}</View>;
    }
    return (
        <BlurView intensity={intensity} tint={blurTint ?? (scheme === 'dark' ? 'dark' : 'light')} style={style}>
            {children}
        </BlurView>
    );
}

export { HAS_LIQUID_GLASS };
