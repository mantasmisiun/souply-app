import { useEffect, useState, type ReactNode } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, useWindowDimensions } from 'react-native';
import { GestureHandlerRootView, GestureDetector, Gesture } from 'react-native-gesture-handler';
import Animated, {
    useSharedValue, useAnimatedStyle, withSpring, withTiming, runOnJS, interpolate, Extrapolation,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, spacing, radius, typography, type AppTheme } from '../constants/theme';

/**
 * A single-detent bottom sheet: slides up on open, drag its header down to
 * dismiss. Uses react-native-gesture-handler + reanimated (the app's working
 * sheet stack) — PanResponder inside an RN Modal doesn't receive drags on the
 * new architecture, so the Modal body is wrapped in its OWN
 * GestureHandlerRootView (required for RNGH gestures inside a Modal).
 *
 * Header: close ✕ on the LEFT, optional icon, then the title — standard sheet
 * chrome, title at the app's heading size. The whole header is the drag handle.
 */
export function BottomSheet({
    visible, onClose, title, icon, children,
}: {
    visible: boolean;
    onClose: () => void;
    title?: string;
    icon?: keyof typeof Ionicons.glyphMap;
    children: ReactNode;
}) {
    const colors = useTheme();
    const insets = useSafeAreaInsets();
    const { height: screenH } = useWindowDimensions();
    const styles = makeStyles(colors);
    const [mounted, setMounted] = useState(visible);

    const ty = useSharedValue(screenH);
    const sheetH = useSharedValue(screenH);

    useEffect(() => {
        if (visible) {
            setMounted(true);
            ty.value = withSpring(0, { damping: 20, stiffness: 200, mass: 0.7 });
        } else if (mounted) {
            ty.value = withTiming(sheetH.value, { duration: 200 }, f => { if (f) runOnJS(setMounted)(false); });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    const pan = Gesture.Pan()
        .onUpdate(e => { ty.value = Math.max(0, e.translationY); })
        .onEnd(e => {
            if (e.translationY > 110 || e.velocityY > 700) runOnJS(onClose)();
            else ty.value = withSpring(0, { damping: 20, stiffness: 200 });
        });

    const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: ty.value }] }));
    const backdropStyle = useAnimatedStyle(() => ({
        opacity: interpolate(ty.value, [0, sheetH.value], [1, 0], Extrapolation.CLAMP),
    }));

    if (!mounted) return null;

    return (
        <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
            <GestureHandlerRootView style={styles.root}>
                <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose}>
                    <Animated.View style={[styles.backdrop, backdropStyle]} />
                </TouchableOpacity>
                <Animated.View
                    style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }, sheetStyle]}
                    onLayout={e => { const h = e.nativeEvent.layout.height; if (h > 0) sheetH.value = h; }}
                >
                    <GestureDetector gesture={pan}>
                        <View style={styles.header}>
                            <View style={styles.grabber} />
                            <View style={styles.headerRow}>
                                <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.closeBtn}>
                                    <Ionicons name="close" size={24} color={colors.textPrimary} />
                                </TouchableOpacity>
                                {icon && <Ionicons name={icon} size={20} color={colors.primary} />}
                                {!!title && <Text style={styles.title} numberOfLines={1}>{title}</Text>}
                            </View>
                        </View>
                    </GestureDetector>
                    {children}
                </Animated.View>
            </GestureHandlerRootView>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    root: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { ...StyleSheet.absoluteFill, backgroundColor: c.overlayBackdrop },
    sheet: {
        backgroundColor: c.cardBackground,
        borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
        paddingHorizontal: spacing.lg, paddingTop: spacing.sm,
    },
    header: { marginHorizontal: -spacing.lg, paddingHorizontal: spacing.lg },
    grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: c.border, marginBottom: spacing.md },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.lg },
    closeBtn: { marginRight: 2 },
    title: { ...typography.heading, fontWeight: '800', color: c.textPrimary, flex: 1 },
});
