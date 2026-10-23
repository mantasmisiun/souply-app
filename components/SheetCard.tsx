import { useContext, type ReactNode } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { SheetSolidContext } from './DockedGlassSheet';
import { useResolvedScheme, radius, spacing } from '../constants/theme';
// The halo radius lives in the sheet tokens (ONE home): SheetContent — which
// every sheet component renders around its content — reserves exactly this
// much top and bottom, so the reserve and the halo can never drift apart.
import { SHEET_CARD_SHADOW_RADIUS } from './dock/sheetTokens';

/**
 * A section card inside a DockedGlassSheet. It reads the sheet's solid/dock
 * progress (SheetSolidContext) and animates from a light TRANSLUCENT panel while
 * the sheet is a floating glass (medium — still clearly a section, just blended)
 * to an OPAQUE raised card with a soft shadow once the sheet docks at full.
 *
 * The fill is WHITE at every progress and only the ALPHA animates — interpolating
 * from `transparent` would pass through gray (that produced the ugly gray tint).
 * One component so the chooser sections and the list card never diverge.
 */
export function SheetCard({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
    const isDark = useResolvedScheme() === 'dark';
    const solidP = useContext(SheetSolidContext);
    const animStyle = useAnimatedStyle(() => {
        const p = solidP?.value ?? 1; // no context → treat as fully raised
        // Dark: a subtle light overlay that lifts the panel off the glass.
        if (isDark) return { backgroundColor: `rgba(255,255,255,${0.09 + 0.05 * p})` };
        // Light: the card is only a NOTCH less transparent than the sheet glass
        // (~0.08 tint) at medium — a subtle glassy panel, not a solid card —
        // and still reaches full white at stage 3, where only the shadow
        // separates it from the white sheet.
        return { backgroundColor: `rgba(255,255,255,${0.25 + 0.75 * p})` };
    });
    return (
        <Animated.View style={[styles.card, !isDark && styles.lightShadow, style, animStyle]}>
            {children}
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    card: {
        borderRadius: radius.lg,
        paddingHorizontal: spacing.lg,
        paddingBottom: spacing.sm,
    },
    // A soft, SYMMETRIC halo — offset 0 on every side, wide blur for a large,
    // gradual fade. Constant (identical at stage 2 and stage 3), NOT ramped.
    // boxShadow (not elevation) renders cleanly on the translucent medium card,
    // avoiding Android's elevation gray-border artifact.
    lightShadow: {
        boxShadow: [{ offsetX: 0, offsetY: 0, blurRadius: SHEET_CARD_SHADOW_RADIUS, spreadDistance: 0, color: 'rgba(90,34,51,0.15)' }],
    },
});
