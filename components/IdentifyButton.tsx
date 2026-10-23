import { useEffect, useState } from 'react';
import { Pressable, Text, View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
    useAnimatedProps, useSharedValue, withRepeat, withTiming, cancelAnimation, Easing,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, radius, spacing, type AppTheme } from '../constants/theme';

const RING = 3;            // gradient border thickness
const GRAD_ID = 'identifyRing';
const AnimatedGradient = Animated.createAnimatedComponent(SvgLinearGradient);

/**
 * The stats "identify products" CTA — a left-aligned labelled pill (sparks icon +
 * "Atpažink" / "Prekes") with two states:
 *   • static  — solid pink + a pink glow.
 *   • loading — muted-pink fill ringed by a band of colour that travels around the
 *     button while the queue count resolves.
 *
 * Built as ONE solid pill so the glow is an ordinary (un-clipped) shadow. The
 * travelling colours are an SVG rounded-rect STROKE overlay whose gradient axis
 * rotates — no overflow:hidden anywhere, so nothing clips the glow, and the icon
 * and text are plain children the ring never covers.
 */
export function IdentifyButton({
    loading,
    onPress,
    titleTop,
    titleBottom,
    accessibilityLabel,
    style,
}: {
    loading: boolean;
    onPress: () => void;
    titleTop: string;
    titleBottom: string;
    accessibilityLabel?: string;
    style?: StyleProp<ViewStyle>;
}) {
    const colors = useTheme();
    const styles = makeStyles(colors);
    const [size, setSize] = useState<{ w: number; h: number } | null>(null);

    // θ ∈ [0,1) sweeps the gradient axis around a full turn → hues travel around the ring.
    const theta = useSharedValue(0);
    useEffect(() => {
        if (loading) {
            theta.value = withRepeat(withTiming(1, { duration: 2600, easing: Easing.linear }), -1, false);
        } else {
            cancelAnimation(theta);
            theta.value = 0;
        }
        return () => cancelAnimation(theta);
    }, [loading, theta]);

    const gradProps = useAnimatedProps(() => {
        const a = theta.value * 2 * Math.PI;
        const cos = Math.cos(a), sin = Math.sin(a);
        return {
            x1: 0.5 + 0.5 * cos, y1: 0.5 + 0.5 * sin,
            x2: 0.5 - 0.5 * cos, y2: 0.5 - 0.5 * sin,
        };
    });

    const contentColor = loading ? colors.primary : colors.onPrimary;

    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel ?? `${titleTop} ${titleBottom}`}
            hitSlop={8}
            style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1 }, style]}
        >
            <View
                style={[styles.pill, loading ? styles.pillLoading : styles.pillStatic]}
                onLayout={(e) => {
                    const { width, height } = e.nativeEvent.layout;
                    setSize((prev) => (prev && prev.w === width && prev.h === height ? prev : { w: width, h: height }));
                }}
            >
                <Ionicons name="sparkles" size={22} color={contentColor} />
                <View style={styles.textCol}>
                    <Text style={[styles.top, { color: contentColor }]} numberOfLines={1}>{titleTop}</Text>
                    <Text style={[styles.bottom, { color: contentColor }]} numberOfLines={1}>{titleBottom}</Text>
                </View>

                {loading && size && (
                    <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width={size.w} height={size.h}>
                        <Defs>
                            <AnimatedGradient id={GRAD_ID} animatedProps={gradProps}>
                                <Stop offset="0" stopColor="#FF4D8D" />
                                <Stop offset="0.25" stopColor="#B65BE8" />
                                <Stop offset="0.5" stopColor="#4F86E8" />
                                <Stop offset="0.75" stopColor="#3FB6A8" />
                                <Stop offset="1" stopColor="#FF4D8D" />
                            </AnimatedGradient>
                        </Defs>
                        <Rect
                            x={RING / 2}
                            y={RING / 2}
                            width={size.w - RING}
                            height={size.h - RING}
                            rx={(size.h - RING) / 2}
                            ry={(size.h - RING) / 2}
                            fill="none"
                            stroke={`url(#${GRAD_ID})`}
                            strokeWidth={RING}
                        />
                    </Svg>
                )}
            </View>
        </Pressable>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        paddingVertical: 7,
        borderRadius: radius.pill,
        // Pink glow — ordinary shadow on a solid, un-clipped view.
        shadowColor: c.primary,
        shadowOpacity: 0.45,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 2 },
        elevation: 6,
    },
    pillStatic: { backgroundColor: c.primary },
    pillLoading: { backgroundColor: c.primaryMuted },
    textCol: { alignItems: 'flex-start' },
    top: { fontSize: 15, fontWeight: '800', letterSpacing: 0.1, lineHeight: 18 },
    bottom: { fontSize: 11, fontWeight: '700', lineHeight: 13, opacity: 0.92, marginTop: -1 },
});
