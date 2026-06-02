import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Animated, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type AppTheme } from '../../constants/theme';

export type ResultsView = 'stores' | 'map';

type Props = {
    value: ResultsView;
    onChange: (v: ResultsView) => void;
    colors: AppTheme;
};

/**
 * Parduotuvės / Žemėlapis segmented slider that lives in the nav bar in place
 * of the title. Mirrors the Privatus/Viešas slider style.
 */
export default function ViewToggle({ value, onChange, colors }: Props) {
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [w, setW] = useState(0);
    const x = useRef(new Animated.Value(value === 'map' ? 1 : 0)).current;

    useEffect(() => {
        Animated.timing(x, { toValue: value === 'map' ? 1 : 0, duration: 180, useNativeDriver: true }).start();
    }, [value, x]);

    const capsuleW = w > 0 ? (w - 8) / 2 : 0;
    const tx = x.interpolate({ inputRange: [0, 1], outputRange: [0, capsuleW] });

    return (
        <View style={styles.segment} onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}>
            {capsuleW > 0 && (
                <Animated.View style={[styles.capsule, { width: capsuleW, transform: [{ translateX: tx }] }]} />
            )}
            <TouchableOpacity style={styles.btn} activeOpacity={0.8} onPress={() => onChange('stores')}>
                <Ionicons name="storefront-outline" size={13} color={value === 'stores' ? colors.onPrimary : colors.textSecondary} />
                <Text style={[styles.txt, { color: value === 'stores' ? colors.onPrimary : colors.textSecondary }]}>Parduotuvės</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btn} activeOpacity={0.8} onPress={() => onChange('map')}>
                <Ionicons name="map-outline" size={13} color={value === 'map' ? colors.onPrimary : colors.textSecondary} />
                <Text style={[styles.txt, { color: value === 'map' ? colors.onPrimary : colors.textSecondary }]}>Žemėlapis</Text>
            </TouchableOpacity>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    segment: {
        position: 'relative', flexDirection: 'row', width: 224,
        backgroundColor: c.surfaceMuted, borderRadius: 11, padding: 4,
        borderWidth: 1, borderColor: c.border,
    },
    capsule: {
        position: 'absolute', top: 4, bottom: 4, left: 4,
        borderRadius: 8, backgroundColor: c.primary,
    },
    btn: {
        flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 5, paddingVertical: 6,
    },
    txt: { fontSize: 12, fontWeight: '700' },
});
