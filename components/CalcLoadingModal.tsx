import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, View, Text, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { useTheme, spacing, radius, typography, type AppTheme } from '../constants/theme';

/**
 * Full-screen calc loading modal: a centered card over a dimmed backdrop with a
 * spinner and a rotating "silly" message. Shown while the store-price
 * calculation runs (initial Shopping→Map load and every saver / location
 * recalc); the caller hides it when the data lands, and the map's pill overlay
 * reveals afterwards.
 *
 * The message rotates every ~2.2s and starts on a random one, so repeated calcs
 * don't always open on the same line. Rotation is paused while hidden.
 */
export default function CalcLoadingModal({ visible }: { visible: boolean }) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const messages = useMemo(() => {
        const m = t('results.loadingMessages', { returnObjects: true });
        return Array.isArray(m) && m.length ? (m as string[]) : [t('results.loading')];
    }, [t]);

    const [idx, setIdx] = useState(0);
    const idxRef = useRef(0);
    idxRef.current = idx;

    useEffect(() => {
        if (!visible) return;
        // Fresh random starting message each time the modal opens.
        setIdx(Math.floor(Math.random() * messages.length));
        const timer = setInterval(() => {
            setIdx(prev => (prev + 1) % messages.length);
        }, 2200);
        return () => clearInterval(timer);
    }, [visible, messages.length]);

    return (
        <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
            <View style={styles.backdrop}>
                <View style={styles.card}>
                    <MaterialProgress size="large" color={colors.primary} />
                    {/* Cross-fade the message so the rotation feels alive, not a jump. */}
                    <Animated.Text
                        key={idx}
                        entering={FadeIn.duration(280)}
                        exiting={FadeOut.duration(160)}
                        style={styles.message}
                    >
                        {messages[idx]}
                    </Animated.Text>
                </View>
            </View>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        alignItems: 'center',
        justifyContent: 'center',
        padding: spacing.xl,
    },
    card: {
        minWidth: 240,
        maxWidth: 340,
        alignItems: 'center',
        gap: spacing.lg,
        paddingVertical: spacing.xl,
        paddingHorizontal: spacing.lg,
        borderRadius: radius.lg,
        backgroundColor: c.cardBackground,
    },
    message: {
        ...typography.body,
        color: c.textSecondary,
        textAlign: 'center',
    },
});
