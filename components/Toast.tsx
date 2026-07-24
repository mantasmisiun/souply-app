import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Animated, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export interface ToastHandle {
    show: (message: string) => void;
}

export const Toast = forwardRef<ToastHandle, { bottomOffset?: number }>(({ bottomOffset }, ref) => {
    const opacity = useRef(new Animated.Value(0)).current;
    const translateY = useRef(new Animated.Value(12)).current;
    const [message, setMessage] = useState('');
    const animRef = useRef<Animated.CompositeAnimation | null>(null);

    useImperativeHandle(ref, () => ({
        show(msg: string) {
            setMessage(msg);
            animRef.current?.stop();
            opacity.setValue(0);
            translateY.setValue(12);
            animRef.current = Animated.sequence([
                Animated.parallel([
                    Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
                    Animated.timing(translateY, { toValue: 0, duration: 180, useNativeDriver: true }),
                ]),
                Animated.delay(1400),
                Animated.timing(opacity, { toValue: 0, duration: 280, useNativeDriver: true }),
            ]);
            animRef.current.start();
        },
    }));

    return (
        <Animated.View pointerEvents="none" style={[styles.toast, bottomOffset != null && { bottom: bottomOffset }, { opacity, transform: [{ translateY }] }]}>
            <Ionicons name="checkmark-circle" size={16} color="#fff" style={{ marginRight: 6 }} />
            <Text style={styles.text}>{message}</Text>
        </Animated.View>
    );
});
Toast.displayName = 'Toast';

const styles = StyleSheet.create({
    toast: {
        position: 'absolute',
        bottom: 88,
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#1F2937',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 24,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 8,
        elevation: 8,
    },
    text: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '600',
    },
});
