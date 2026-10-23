import { useState } from 'react';
import {
    View, Text, TextInput, TouchableOpacity, Modal, StyleSheet, Platform, KeyboardAvoidingView,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { useTheme, spacing, radius, typography, type AppTheme } from '../constants/theme';
import { AVATAR_PALETTE, UserAvatar } from './UserAvatar';

/**
 * Required name prompt shown before someone joins a shared trip/home without a
 * name yet — they must pick one (and get a coloured avatar) so the other
 * members can tell who's who. Cancelling aborts the join. The colour is
 * optional here (server assigns a random one on save); a live avatar preview
 * updates as they type.
 */
export function NamePromptModal({
    visible, onSubmit, onCancel,
}: {
    visible: boolean;
    onSubmit: (name: string, color: string) => Promise<void> | void;
    onCancel: () => void;
}) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = makeStyles(colors);
    const [name, setName] = useState('');
    const [color, setColor] = useState<string>(AVATAR_PALETTE[0]);
    const [saving, setSaving] = useState(false);
    const trimmed = name.trim();

    const submit = async () => {
        if (!trimmed || saving) return;
        setSaving(true);
        try { await onSubmit(trimmed, color); } finally { setSaving(false); }
    };

    return (
        <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onCancel}>
            <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
                <View style={styles.card}>
                    <View style={styles.previewRow}>
                        <UserAvatar name={trimmed || '?'} color={color} size={52} />
                        <View style={styles.previewText}>
                            <Text style={styles.title}>{t('namePrompt.title')}</Text>
                            <Text style={styles.subtitle}>{t('namePrompt.subtitle')}</Text>
                        </View>
                    </View>
                    <TextInput
                        style={styles.input}
                        value={name}
                        onChangeText={setName}
                        placeholder={t('namePrompt.placeholder')}
                        placeholderTextColor={colors.textMuted}
                        maxLength={60}
                        autoFocus
                        autoCapitalize="words"
                        returnKeyType="done"
                        onSubmitEditing={submit}
                    />
                    <View style={styles.swatchRow}>
                        {AVATAR_PALETTE.map(sw => (
                            <TouchableOpacity
                                key={sw}
                                onPress={() => setColor(sw)}
                                style={[styles.swatch, { backgroundColor: sw }, color === sw && styles.swatchOn]}
                                activeOpacity={0.8}
                            />
                        ))}
                    </View>
                    <View style={styles.actions}>
                        <TouchableOpacity style={styles.cancel} onPress={onCancel} disabled={saving}>
                            <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.save, !trimmed && styles.saveDisabled]} onPress={submit} disabled={!trimmed || saving}>
                            {saving
                                ? <MaterialProgress size="small" color={colors.onPrimary} />
                                : <Text style={styles.saveText}>{t('namePrompt.continue')}</Text>}
                        </TouchableOpacity>
                    </View>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: c.overlayBackdrop, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
    card: { width: '100%', maxWidth: 420, backgroundColor: c.cardBackground, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.md },
    previewRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
    previewText: { flex: 1 },
    title: { ...typography.subheading, fontWeight: '800', color: c.textPrimary },
    subtitle: { ...typography.bodySmall, color: c.textSecondary, marginTop: 2 },
    input: {
        borderWidth: 1, borderColor: c.border, borderRadius: radius.sm,
        paddingHorizontal: spacing.md, paddingVertical: spacing.md, fontSize: 16, color: c.textPrimary,
    },
    swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    swatch: { width: 32, height: 32, borderRadius: 16 },
    swatchOn: { borderWidth: 2, borderColor: c.textPrimary },
    actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs, justifyContent: 'flex-end' },
    cancel: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.pill },
    cancelText: { ...typography.bodyStrong, fontWeight: '700', color: c.textSecondary },
    save: { paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: radius.pill, backgroundColor: c.primary, minWidth: 110, alignItems: 'center' },
    saveDisabled: { opacity: 0.5 },
    saveText: { ...typography.bodyStrong, fontWeight: '700', color: c.onPrimary },
});
