import { useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import { useTheme } from '../constants/theme';

interface Props {
    width?: number | `${number}%`;
    height?: number;
    borderRadius?: number;
    style?: object;
}

export function SkeletonBox({ width = '100%', height = 16, borderRadius = 8, style }: Props) {
    const colors = useTheme();
    const opacity = useRef(new Animated.Value(0.35)).current;

    useEffect(() => {
        Animated.loop(
            Animated.sequence([
                Animated.timing(opacity, { toValue: 0.8, duration: 750, useNativeDriver: true }),
                Animated.timing(opacity, { toValue: 0.35, duration: 750, useNativeDriver: true }),
            ])
        ).start();
    }, []);

    return (
        <Animated.View
            style={[{ width, height, borderRadius, backgroundColor: colors.borderSubtle, opacity }, style]}
        />
    );
}
