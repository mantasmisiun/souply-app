import React, { useMemo } from 'react';
import {
    View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../constants/theme';

interface Props {
    visible: boolean;
    title: string;
    body?: string;
    confirmLabel: string;
    cancelLabel: string;
    /** Red confirm button + warning icon — for deletes / irreversible actions. */
    destructive?: boolean;
    /** Shows a spinner on the confirm button and blocks dismissal. */
    busy?: boolean;
    onConfirm: () => void;
    onClose: () => void;
}

/**
 * Souply-themed confirmation dialog — a centered, theme-aware replacement for
 * the platform `Alert.alert` confirm prompt (which renders the ugly Android
 * stock alert). Reusable for any confirm / destructive-action flow.
 */
export function ConfirmModal({
    visible, title, body, confirmLabel, cancelLabel, destructive = false, busy = false, onConfirm, onClose,
}: Props) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={busy ? () => {} : onClose}>
            <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={busy ? undefined : onClose}>
                <View style={styles.card} onStartShouldSetResponder={() => true}>
                    {destructive && (
                        <View style={styles.iconWrap}>
                            <Ionicons name="trash-outline" size={26} color={colors.error} />
                        </View>
                    )}
                    <Text style={styles.title}>{title}</Text>
                    {!!body && <Text style={styles.body}>{body}</Text>}

                    <View style={styles.actions}>
                        <TouchableOpacity
                            style={[styles.btn, styles.cancelBtn]}
                            onPress={onClose}
                            disabled={busy}
                            activeOpacity={0.8}
                        >
                            <Text style={styles.cancelText}>{cancelLabel}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.btn, destructive ? styles.destructiveBtn : styles.confirmBtn, busy && { opacity: 0.6 }]}
                            onPress={onConfirm}
                            disabled={busy}
                            activeOpacity={0.8}
                        >
                            {busy
                                ? <ActivityIndicator color="#fff" />
                                : <Text style={styles.confirmText}>{confirmLabel}</Text>}
                        </TouchableOpacity>
                    </View>
                </View>
            </TouchableOpacity>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 28 },
    card: { backgroundColor: c.cardBackground, borderRadius: 18, padding: 20, gap: 10, width: '100%', maxWidth: 420 },
    iconWrap: {
        width: 52, height: 52, borderRadius: 26, alignSelf: 'center',
        backgroundColor: (c as any).errorMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center', marginBottom: 2,
    },
    title: { fontSize: 17, fontWeight: '700', color: c.textPrimary, textAlign: 'center' },
    body: { fontSize: 14, color: c.textSecondary, textAlign: 'center', lineHeight: 20 },
    actions: { flexDirection: 'row', gap: 10, marginTop: 8 },
    btn: { flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
    cancelBtn: { backgroundColor: c.surfaceMuted },
    cancelText: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    confirmBtn: { backgroundColor: c.primary },
    destructiveBtn: { backgroundColor: c.error },
    confirmText: { fontSize: 15, fontWeight: '700', color: '#fff' },
});
