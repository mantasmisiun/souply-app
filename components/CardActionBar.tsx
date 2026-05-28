import React from 'react';
import { Pressable, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../constants/theme';

export interface CardAction {
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    onPress: () => void;
    /** Use a destructive red colour instead of the primary tint. */
    destructive?: boolean;
}

interface Props {
    /** Optional context label shown above the buttons. Omit for multi-select flows where the selection is communicated on the cards themselves. */
    title?: string;
    actions: CardAction[];
    onDismiss: () => void;
    /**
     * `modal` — full-screen backdrop, tap outside dismisses (used by single-target flows like admin/product).
     * `inline` — bar floats at the bottom without blocking touches on the rest of the screen; an X button on the bar dismisses (used by multi-select flows).
     * Defaults to `modal` for backwards compatibility.
     */
    mode?: 'modal' | 'inline';
}

const DESTRUCTIVE_COLOR = '#E53E3E';

export function CardActionBar({ title, actions, onDismiss, mode = 'modal' }: Props) {
    const colors = useTheme();
    const styles = makeStyles(colors);

    const barContent = (
        <>
            {mode === 'inline' && (
                <TouchableOpacity style={styles.closeBtn} onPress={onDismiss} hitSlop={8}>
                    <Ionicons name="close" size={20} color={colors.textSecondary} />
                </TouchableOpacity>
            )}
            {title ? <Text style={styles.title} numberOfLines={1}>{title}</Text> : null}
            <View style={styles.btns}>
                {actions.map((a, i) => {
                    const tint = a.destructive ? DESTRUCTIVE_COLOR : colors.primary;
                    return (
                        <React.Fragment key={`${a.label}-${i}`}>
                            {i > 0 && <View style={styles.sep} />}
                            <TouchableOpacity style={styles.btn} onPress={a.onPress}>
                                <Ionicons name={a.icon} size={18} color={tint} />
                                <Text style={[styles.btnText, { color: tint }]}>{a.label}</Text>
                            </TouchableOpacity>
                        </React.Fragment>
                    );
                })}
            </View>
        </>
    );

    if (mode === 'inline') {
        return <View style={styles.inlineBar}>{barContent}</View>;
    }

    return (
        <Pressable style={styles.backdrop} onPress={onDismiss}>
            <Pressable style={styles.bar} onPress={e => e.stopPropagation()}>
                {barContent}
            </Pressable>
        </Pressable>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    backdrop: {
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        justifyContent: 'flex-end',
    },
    bar: {
        backgroundColor: c.cardBackground,
        borderTopWidth: 1, borderTopColor: c.border,
        paddingTop: 12, paddingHorizontal: 16, paddingBottom: 32,
        gap: 12,
    },
    inlineBar: {
        position: 'absolute', left: 0, right: 0, bottom: 0,
        backgroundColor: c.cardBackground,
        borderTopWidth: 1, borderTopColor: c.border,
        paddingTop: 12, paddingHorizontal: 16, paddingBottom: 32,
        gap: 12,
        elevation: 8, shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.08, shadowRadius: 6,
    },
    closeBtn: { position: 'absolute', top: 8, right: 8, padding: 4, zIndex: 1 },
    title: { fontSize: 13, fontWeight: '600', color: c.textSecondary, textAlign: 'center' },
    btns: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
    sep: { width: 1, height: 24, backgroundColor: c.border, marginHorizontal: 4 },
    btn: {
        alignItems: 'center', gap: 4,
        paddingHorizontal: 16, paddingVertical: 8,
        borderRadius: 10, backgroundColor: c.surfaceMuted, minWidth: 80,
    },
    btnText: { fontSize: 12, fontWeight: '600' },
});
