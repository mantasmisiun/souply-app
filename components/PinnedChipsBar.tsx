import React from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

/**
 * THE container behind every pinned chips/filter row (L2 category bubbles,
 * product-page store filter, shopping-list store tabs, …).
 *
 * One place decides the banner look. The 2026-07 decision is NO banner —
 * chips float transparently and the header's fade gradient handles content
 * passing beneath. If a background/border/padding ever comes back, change it
 * HERE and every screen follows — never restyle the rows screen by screen.
 */
export function PinnedChipsBar({ children, style }: {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
}) {
    return <View style={[styles.bar, style]}>{children}</View>;
}

const styles = StyleSheet.create({
    bar: {
        backgroundColor: 'transparent',
        borderBottomWidth: 0,
        flexGrow: 0,
        flexShrink: 0,
    },
});
