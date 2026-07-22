import { useMemo, useState } from 'react';
import {
    View, Text, TextInput, TouchableOpacity, Modal, StyleSheet, Platform, KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { useTheme, spacing, radius, typography, type AppTheme } from '../constants/theme';
import { AVATAR_PALETTE, UserAvatar } from './UserAvatar';
import { patchProfileFields } from '../utils/authApi';
import { type ProfileData } from '../state/profileStore';

/**
 * Identity card at the top of the profile: coloured avatar + name, tap to edit
 * name and colour. Shown for users WITHOUT the signed-in creator header (i.e.
 * anonymous users) so anyone can set a name proactively — once set, joining a
 * shared trip/home no longer prompts for one.
 */
export function ProfileIdentityCard({ profile, onChanged }: {
    profile: ProfileData;
    onChanged: () => void;
}) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const name = profile.displayName || profile.firstName || null;

    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const [color, setColor] = useState<string>(AVATAR_PALETTE[0]);
    const [saving, setSaving] = useState(false);

    const openEdit = () => {
        setDraft(name ?? '');
        setColor(profile.avatarColor ?? AVATAR_PALETTE[0]);
        setOpen(true);
    };
    const save = async () => {
        const v = draft.trim();
        if (!v || saving) return;
        setSaving(true);
        const ok = await patchProfileFields({ displayName: v, avatarColor: color });
        setSaving(false);
        if (ok) { setOpen(false); onChanged(); }
    };

    return (
        <>
            <TouchableOpacity style={styles.card} onPress={openEdit} activeOpacity={0.75}>
                <UserAvatar name={name ?? 'S'} color={profile.avatarColor ?? colors.primary} size={48} />
                <View style={styles.textCol}>
                    <Text style={styles.name} numberOfLines={1}>{name ?? t('profileIdentity.setNamePlaceholder')}</Text>
                    <Text style={styles.hint} numberOfLines={1}>
                        {name ? t('profileIdentity.tapToEdit') : t('profileIdentity.setNameHint')}
                    </Text>
                </View>
                <Ionicons name="pencil" size={16} color={colors.textMuted} />
            </TouchableOpacity>

            <Modal visible={open} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setOpen(false)}>
                <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
                    <View style={styles.modalCard}>
                        <View style={styles.previewRow}>
                            <UserAvatar name={draft.trim() || 'S'} color={color} size={44} />
                            <Text style={styles.modalTitle}>{t('profileIdentity.editTitle')}</Text>
                        </View>
                        <TextInput
                            style={styles.input}
                            value={draft}
                            onChangeText={setDraft}
                            placeholder={t('profileIdentity.namePlaceholder')}
                            placeholderTextColor={colors.textMuted}
                            maxLength={60}
                            autoFocus
                            autoCapitalize="words"
                            returnKeyType="done"
                            onSubmitEditing={save}
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
                            <TouchableOpacity style={styles.cancel} onPress={() => setOpen(false)} disabled={saving}>
                                <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={[styles.save, !draft.trim() && styles.saveDisabled]} onPress={save} disabled={!draft.trim() || saving}>
                                {saving
                                    ? <MaterialProgress size="small" color={colors.onPrimary} />
                                    : <Text style={styles.saveText}>{t('profileIdentity.save')}</Text>}
                            </TouchableOpacity>
                        </View>
                    </View>
                </KeyboardAvoidingView>
            </Modal>
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    card: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.lg,
        backgroundColor: c.cardBackground, borderRadius: radius.lg,
        padding: spacing.lg, marginBottom: spacing.lg,
        borderWidth: 1, borderColor: c.border,
    },
    textCol: { flex: 1 },
    name: { ...typography.subheading, fontWeight: '800', color: c.textPrimary },
    hint: { ...typography.bodySmall, color: c.textSecondary, marginTop: 2 },

    backdrop: { flex: 1, backgroundColor: c.overlayBackdrop, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
    modalCard: { width: '100%', maxWidth: 420, backgroundColor: c.cardBackground, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.md },
    previewRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
    modalTitle: { ...typography.subheading, fontWeight: '800', color: c.textPrimary, flex: 1 },
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
