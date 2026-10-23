import { useEffect, type ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
    useSharedValue, useAnimatedStyle, withTiming, withDelay, Easing, interpolate,
} from 'react-native-reanimated';
import { useTheme } from '../constants/theme';

export type ScanMode = 'refreshed' | 'inserted' | null | undefined;

const SCAN_MS = 520;

/**
 * A receipt line that got RENEWED (re-OCR'd) or INSERTED by a heal, revealed with
 * a left→right "scanner" sweep: a bright vertical line travels across the row while
 * the content fades in behind it — as if the text is being scanned in. Stagger the
 * `delay` per row so a batch reveals one line at a time. Inserts pair this with the
 * parent's layout animation (the row grows / siblings shift). `mode` null → the row
 * renders plainly (no animation).
 */
export function ScanRevealRow({ mode, delay = 0, children }: {
    mode?: ScanMode;
    delay?: number;
    children: ReactNode;
}) {
    const colors = useTheme();
    const p = useSharedValue(mode ? 0 : 1);

    useEffect(() => {
        if (!mode) { p.value = 1; return; }
        p.value = 0;
        p.value = withDelay(delay, withTiming(1, { duration: SCAN_MS, easing: Easing.out(Easing.cubic) }));
    }, [mode, delay, p]);

    // Content is revealed as the sweep passes — from faint to full.
    const contentStyle = useAnimatedStyle(() => ({
        opacity: mode ? interpolate(p.value, [0, 0.2, 1], [0.0, 0.45, 1]) : 1,
    }));
    // The scanner line rides left→right; its soft trailing glow follows.
    const lineStyle = useAnimatedStyle(() => ({
        left: `${interpolate(p.value, [0, 1], [-2, 100])}%`,
        opacity: mode && p.value > 0.001 && p.value < 0.98 ? 1 : 0,
    }));
    const glowStyle = useAnimatedStyle(() => ({
        left: `${interpolate(p.value, [0, 1], [-14, 88])}%`,
        opacity: mode && p.value > 0.001 && p.value < 0.98 ? 0.35 : 0,
    }));

    return (
        <View>
            <Animated.View style={contentStyle}>{children}</Animated.View>
            {!!mode && (
                <>
                    <Animated.View pointerEvents="none" style={[styles.glow, { backgroundColor: colors.primary }, glowStyle]} />
                    <Animated.View pointerEvents="none" style={[styles.line, { backgroundColor: colors.primary }, lineStyle]} />
                </>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    line: { position: 'absolute', top: 4, bottom: 4, width: 2, borderRadius: 1 },
    glow: { position: 'absolute', top: 2, bottom: 2, width: 16, borderRadius: 8 },
});
