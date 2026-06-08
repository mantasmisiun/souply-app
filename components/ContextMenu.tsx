import React from 'react';
import { Modal, Pressable, Text, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../constants/theme';

export type ContextMenuAction = {
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    onPress: () => void;
    destructive?: boolean;
};

/**
 * Anchored overflow/context menu (NOT a bottom sheet) — the expected pattern
 * for a header three-dot. Drops from the top-right under the trigger, themed
 * per platform: iOS reads label-left / icon-right with hairline separators;
 * Android reads icon-left / label-right, Material elevation. Pure JS over RN
 * Modal — OTA-safe, no native module.
 */
export function ContextMenu({
    visible,
    onDismiss,
    actions,
    top,
    right = 10,
}: {
    visible: boolean;
    onDismiss: () => void;
    actions: ContextMenuAction[];
    top?: number;
    right?: number;
}) {
    const colors = useTheme();
    const insets = useSafeAreaInsets();
    const styles = makeStyles(colors);
    const isIOS = Platform.OS === 'ios';
    const menuTop = top ?? insets.top + 50;
    const danger = (colors as any).danger ?? '#E5484D';

    return (
        <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onDismiss}>
            <Pressable style={styles.backdrop} onPress={onDismiss}>
                {/* Absorb taps on the menu itself so they don't dismiss. */}
                <Pressable style={[styles.menu, { top: menuTop, right }]} onPress={() => {}}>
                    {actions.map((a, i) => {
                        const tint = a.destructive ? danger : colors.textPrimary;
                        return (
                            <Pressable
                                key={a.label}
                                onPress={a.onPress}
                                android_ripple={{ color: colors.surfaceMuted ?? 'rgba(0,0,0,0.08)' }}
                                style={({ pressed }) => [
                                    styles.row,
                                    isIOS ? styles.rowIOS : styles.rowAndroid,
                                    isIOS && i > 0 && styles.divider,
                                    pressed && styles.rowPressed,
                                ]}
                            >
                                {!isIOS && <Ionicons name={a.icon} size={20} color={tint} />}
                                <Text style={[styles.label, { color: tint }]} numberOfLines={1}>{a.label}</Text>
                                {isIOS && <Ionicons name={a.icon} size={19} color={tint} />}
                            </Pressable>
                        );
                    })}
                </Pressable>
            </Pressable>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    backdrop: { flex: 1 },
    menu: {
        position: 'absolute',
        minWidth: 224,
        backgroundColor: c.cardBackground,
        borderRadius: Platform.OS === 'ios' ? 14 : 10,
        paddingVertical: Platform.OS === 'ios' ? 0 : 6,
        overflow: 'hidden',
        elevation: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.18,
        shadowRadius: 16,
        borderWidth: Platform.OS === 'ios' ? StyleSheet.hairlineWidth : 0,
        borderColor: c.border,
    },
    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
    rowIOS: { height: 48, justifyContent: 'space-between' },
    rowAndroid: { height: 48, gap: 18 },
    divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    rowPressed: { backgroundColor: c.surfaceMuted ?? 'rgba(0,0,0,0.06)' },
    label: { fontSize: 16, fontWeight: '500' },
});
