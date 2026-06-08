import { useRef, useState } from 'react';
import { Text, View, Pressable, StyleSheet } from 'react-native';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ENV_BADGE } from '../config/env';

/**
 * Floating environment marker for non-production builds (Flutter-style debug
 * banner). Rendered ONCE at the app root as a top-layer overlay, so it can
 * never push the navigator down (the "nudge") or sit on top of the header
 * (the "cover") — both were caused by the old in-flow strip fighting the
 * native iOS header for the same space under the status bar.
 *
 * It sits in the header bar's empty centre (titles are left-aligned, actions
 * right-aligned), reads as part of the chrome, and is pixel-identical on iOS
 * and Android because it's a plain RN overlay, not native header chrome.
 *
 * The wrap is `box-none` so its transparent area passes touches through to the
 * header beneath; only the pill itself is tappable. Double-tap hides it for the
 * session (handy for taking clean screenshots on a staging build) — it's local
 * state, so a restart brings it back. Nothing in prod (ENV_BADGE is null).
 */
export function EnvBadge() {
    const insets = useSafeAreaInsets();
    const [hidden, setHidden] = useState(false);
    const lastTap = useRef(0);

    if (!ENV_BADGE || hidden) return null;

    const onTap = () => {
        const now = Date.now();
        if (now - lastTap.current < 300) setHidden(true);
        lastTap.current = now;
    };

    // Stable top inset from frame 1 (hook value resolves 0 → real a frame late;
    // the Constants fallback keeps the pill in place from the start).
    const top = (insets.top || Constants.statusBarHeight || 0) + 8;
    return (
        <View pointerEvents="box-none" style={[styles.wrap, { top }]}>
            <Pressable onPress={onTap} hitSlop={12} style={[styles.pill, { backgroundColor: ENV_BADGE.color }]}>
                <Text style={styles.text}>{ENV_BADGE.label}</Text>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: {
        position: 'absolute',
        left: 0,
        right: 0,
        alignItems: 'center',
        zIndex: 1000,
        elevation: 1000,
    },
    pill: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 8,
    },
    text: {
        color: '#FFFFFF',
        fontSize: 10,
        fontWeight: '800',
        letterSpacing: 1.5,
    },
});
