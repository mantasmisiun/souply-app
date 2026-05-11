import { useRef } from 'react';
import { Animated, TouchableOpacity, type TouchableOpacityProps } from 'react-native';

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

interface Props extends TouchableOpacityProps {
    children: React.ReactNode;
    scaleTo?: number;
}

export function ScalePressable({ children, scaleTo = 0.95, style, onPressIn, onPressOut, ...props }: Props) {
    const anim = useRef(new Animated.Value(1)).current;

    const handlePressIn = (e: any) => {
        Animated.spring(anim, { toValue: scaleTo, useNativeDriver: true, speed: 60, bounciness: 0 }).start();
        onPressIn?.(e);
    };

    const handlePressOut = (e: any) => {
        Animated.spring(anim, { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 4 }).start();
        onPressOut?.(e);
    };

    return (
        <AnimatedTouchable
            activeOpacity={0.9}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            style={[style, { transform: [{ scale: anim }] }]}
            {...props}
        >
            {children}
        </AnimatedTouchable>
    );
}
