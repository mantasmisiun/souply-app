import React, { useRef, useMemo } from 'react';
import { Animated, PanResponder, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../constants/theme';

interface Props {
    children: React.ReactNode;
    onDelete?: () => void;
    onComplete?: () => void;
    /** Pass true to hide the complete action (e.g. already-completed items). */
    isCompleted?: boolean;
}

const THRESHOLD = 72;
const MAX_DRAG = 110;

export function SwipeableRow({ children, onDelete, onComplete, isCompleted }: Props) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const translateX = useRef(new Animated.Value(0)).current;

    const snapBack = () =>
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, friction: 7, tension: 80 }).start();

    const panResponder = useRef(PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, g) =>
            Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderGrant: () => {
            (translateX as any).stopAnimation();
        },
        onPanResponderMove: (_, g) => {
            let dx = g.dx;
            if (!onComplete || isCompleted) dx = Math.min(dx, 0);
            if (!onDelete) dx = Math.max(dx, 0);
            if (Math.abs(dx) > MAX_DRAG) {
                dx = Math.sign(dx) * (MAX_DRAG + (Math.abs(dx) - MAX_DRAG) * 0.15);
            }
            translateX.setValue(dx);
        },
        onPanResponderRelease: (_, g) => {
            if (g.dx > THRESHOLD && onComplete && !isCompleted) {
                Animated.timing(translateX, { toValue: 0, duration: 200, useNativeDriver: true }).start();
                onComplete();
            } else if (g.dx < -THRESHOLD && onDelete) {
                onDelete();
                Animated.timing(translateX, { toValue: 0, duration: 150, useNativeDriver: true }).start();
            } else {
                snapBack();
            }
        },
        onPanResponderTerminate: snapBack,
    })).current;

    const rightOpacity = translateX.interpolate({ inputRange: [0, THRESHOLD * 0.5, THRESHOLD], outputRange: [0, 0.6, 1], extrapolate: 'clamp' });
    const leftOpacity  = translateX.interpolate({ inputRange: [-THRESHOLD, -THRESHOLD * 0.5, 0], outputRange: [1, 0.6, 0], extrapolate: 'clamp' });

    return (
        <View style={styles.container}>
            {onComplete && !isCompleted && (
                <Animated.View style={[styles.bg, styles.bgRight, { opacity: rightOpacity }]}>
                    <Ionicons name="checkmark-done-outline" size={22} color={colors.onSuccess} />
                </Animated.View>
            )}
            {onDelete && (
                <Animated.View style={[styles.bg, styles.bgLeft, { opacity: leftOpacity }]}>
                    <Ionicons name="trash-outline" size={20} color={colors.onPrimary} />
                </Animated.View>
            )}
            <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
                {children}
            </Animated.View>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { overflow: 'hidden' },
    bg: {
        ...StyleSheet.absoluteFill,
        alignItems: 'center',
        justifyContent: 'center',
    },
    bgRight: {
        backgroundColor: c.success,
        alignItems: 'flex-start',
        paddingLeft: 24,
    },
    bgLeft: {
        backgroundColor: c.error,
        alignItems: 'flex-end',
        paddingRight: 24,
    },
});
