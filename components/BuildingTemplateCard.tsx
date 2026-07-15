import React, { useEffect, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, radius, type AppTheme } from '../constants/theme';

/**
 * Placeholder card shown while the default template is being built — a pulsing
 * sparkle (AI working) + a progress bar that fills over ~5s. Replaced by the
 * real card once generation + the minimum display time both complete.
 */
export function BuildingTemplateCard() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const progress = useRef(new Animated.Value(0)).current;
    const pulse = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        // Bar fills to ~95% over the artificial 5s "thinking" window; the real
        // card swaps in before it reaches 100%.
        Animated.timing(progress, { toValue: 1, duration: 5000, useNativeDriver: false }).start();
        Animated.loop(
            Animated.sequence([
                Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: true }),
                Animated.timing(pulse, { toValue: 0, duration: 650, useNativeDriver: true }),
            ]),
        ).start();
    }, [progress, pulse]);

    const width = progress.interpolate({ inputRange: [0, 1], outputRange: ['8%', '95%'] });
    const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });
    const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] });

    return (
        <View style={styles.card}>
            <Animated.View style={[styles.iconWrap, { transform: [{ scale }], opacity }]}>
                <Ionicons name="sparkles" size={20} color={colors.primary} />
            </Animated.View>
            <View style={styles.body}>
                <Text style={styles.title}>{t('basketTab.templates.buildingTitle')}</Text>
                <Text style={styles.sub}>{t('basketTab.templates.buildingBody')}</Text>
                <View style={styles.track}>
                    <Animated.View style={[styles.fill, { width }]} />
                </View>
            </View>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    card: {
        flexDirection: 'row', alignItems: 'center', gap: 12,
        backgroundColor: c.cardBackground, borderRadius: radius.lg, padding: 14, marginBottom: 10,
        borderWidth: 1, borderColor: c.primary, borderStyle: 'dashed',
    },
    iconWrap: {
        width: 40, height: 40, borderRadius: radius.md,
        backgroundColor: (c as any).primaryMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    body: { flex: 1, gap: 5 },
    title: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    sub: { fontSize: 12, color: c.textSecondary },
    track: { height: 5, borderRadius: 3, backgroundColor: c.surfaceMuted, overflow: 'hidden', marginTop: 2 },
    fill: { height: 5, borderRadius: 3, backgroundColor: c.primary },
});
