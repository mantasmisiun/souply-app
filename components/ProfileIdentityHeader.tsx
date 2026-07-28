import { useMemo, useState } from 'react';
import {
    View, Text, Image, TextInput, TouchableOpacity, Modal, StyleSheet, Alert,
    Platform, KeyboardAvoidingView,
} from 'react-native';
import { MaterialProgress } from '@/components/MaterialProgress';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { useTheme, spacing, radius, typography, type AppTheme } from '../constants/theme';
import { useAuthState } from '../state/authState';
import { type ProfileData } from '../state/profileStore';
import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';
import { patchProfileFields } from '../utils/authApi';
import { AVATAR_PALETTE } from './UserAvatar';

/** Shown when a regular user hasn't named themselves yet. */
export const DEFAULT_DISPLAY_NAME = 'Souplyman';

/**
 * THE profile identity row — avatar + editable name — for every account type.
 *
 * One component, two fills: a creator gets their uploaded photo (tap to change),
 * full name and @handle; a regular user gets the pink initial circle and
 * "Souplyman" until they name themselves. Both look the same, because they ARE
 * the same thing — previously the two accounts had visibly different headers
 * (CreatorProfileHeader vs a bordered ProfileIdentityCard) for no reason a user
 * could see.
 */
export function ProfileIdentityHeader({ profile, onChanged, creator = false }: {
    profile: ProfileData;
    onChanged: () => void;
    /** Creator fill: photo upload, first/last name, @handle. */
    creator?: boolean;
}) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    // The signed-in session already carries identity — use it as a fallback so
    // the header is right even when the /profile fetch is stale.
    const authUser = useAuthState(s => s.user);

    const [uploading, setUploading] = useState(false);
    const [localUri, setLocalUri] = useState<string | null>(null);
    const [editOpen, setEditOpen] = useState(false);
    const [draftFirst, setDraftFirst] = useState('');
    const [draftLast, setDraftLast] = useState('');
    const [draftName, setDraftName] = useState('');
    const [draftColor, setDraftColor] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    const username = profile.username ?? authUser?.username ?? null;
    const handle = creator && username ? `@${username}` : null;
    const storedName =
        [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim() ||
        profile.displayName ||
        authUser?.displayName ||
        '';
    const name = storedName || (creator ? (username ? `@${username}` : t('basketTab.creatorProfile.title')) : DEFAULT_DISPLAY_NAME);

    // Only an absolute http(s) URL is a usable <Image> source: the session value
    // can be a bare storage KEY, which renders as a broken grey circle.
    const sessionAvatar = /^https?:\/\//i.test(authUser?.avatarUrl ?? '') ? authUser!.avatarUrl : null;
    const avatarSrc = creator ? (localUri ?? profile.avatarUrl ?? sessionAvatar ?? null) : null;
    const initials = (() => {
        const fl = `${(profile.firstName ?? '').trim()[0] ?? ''}${(profile.lastName ?? '').trim()[0] ?? ''}`.toUpperCase();
        if (fl) return fl;
        const dn = (profile.displayName ?? authUser?.displayName ?? '').trim();
        if (dn) return dn.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
        if (!creator) return DEFAULT_DISPLAY_NAME[0];
        return (username ?? '?').trim()[0]?.toUpperCase() ?? '?';
    })();

    const pickAndUpload = async () => {
        if (uploading) return;
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (perm.status !== 'granted') return;
        const picked = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'] as any,
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.9,
        });
        if (picked.canceled || !picked.assets?.length) return;
        setUploading(true);
        try {
            const out = await ImageManipulator.manipulateAsync(
                picked.assets[0].uri,
                [{ resize: { width: 512 } }],
                { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true },
            );
            setLocalUri(out.uri); // optimistic preview while the refetch lands
            const token = useAuthState.getState().token;
            const deviceId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/users/me/avatar`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // X-User-Id lets the device's own id own the avatar even on a
                    // dev/unverified session; a real Bearer JWT takes precedence.
                    'X-User-Id': deviceId,
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({ imageBase64: out.base64 }),
            });
            if (!res.ok) {
                setLocalUri(null);
                Alert.alert(t('basketTab.errorGeneric'), t('basketTab.creatorProfile.avatarFailed'));
                return;
            }
            onChanged();
        } catch {
            setLocalUri(null);
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.creatorProfile.avatarFailed'));
        } finally {
            setUploading(false);
        }
    };

    const openEdit = () => {
        if (creator) {
            const fn = profile.firstName ?? '';
            const ln = profile.lastName ?? '';
            if (!fn && !ln) {
                // No first/last yet — seed from the displayed name so the user
                // isn't faced with empty inputs when a name is clearly set.
                const parts = (profile.displayName ?? authUser?.displayName ?? '').trim().split(/\s+/).filter(Boolean);
                setDraftFirst(parts[0] ?? '');
                setDraftLast(parts.slice(1).join(' '));
            } else {
                setDraftFirst(fn);
                setDraftLast(ln);
            }
        } else {
            setDraftName(storedName);
        }
        setDraftColor(profile.avatarColor ?? null);
        setEditOpen(true);
    };

    const save = async () => {
        if (saving) return;
        setSaving(true);
        const ok = await patchProfileFields(
            creator
                ? { firstName: draftFirst.trim(), lastName: draftLast.trim(), ...(draftColor ? { avatarColor: draftColor } : {}) }
                : { displayName: draftName.trim(), ...(draftColor ? { avatarColor: draftColor } : {}) },
        );
        setSaving(false);
        if (ok) { setEditOpen(false); onChanged(); }
        else Alert.alert(t('basketTab.errorGeneric'), t('basketTab.creatorProfile.saveFailed'));
    };

    const avatarColor = profile.avatarColor ?? colors.primary;

    return (
        <View style={styles.wrap}>
            <View style={styles.row}>
                <TouchableOpacity
                    style={styles.avatarBtn}
                    onPress={creator ? pickAndUpload : openEdit}
                    activeOpacity={0.8}
                    disabled={uploading}
                >
                    {avatarSrc ? (
                        <Image source={{ uri: avatarSrc }} style={styles.avatarImg} />
                    ) : (
                        <View style={[styles.avatarInitials, { backgroundColor: avatarColor }]}>
                            <Text style={styles.avatarInitialsText}>{initials}</Text>
                        </View>
                    )}
                    {creator && (
                        <View style={styles.avatarEdit}>
                            {uploading
                                ? <MaterialProgress size="small" color="#FFFFFF" />
                                : <Ionicons name="camera" size={13} color="#FFFFFF" />}
                        </View>
                    )}
                </TouchableOpacity>
                <TouchableOpacity style={styles.nameCol} onPress={openEdit} activeOpacity={0.7}>
                    <View style={styles.nameRow}>
                        <Text style={styles.name} numberOfLines={1}>{name}</Text>
                        <Ionicons name="pencil" size={13} color={colors.textMuted} />
                    </View>
                    {handle && <Text style={styles.handle} numberOfLines={1}>{handle}</Text>}
                </TouchableOpacity>
            </View>

            <Modal visible={editOpen} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setEditOpen(false)}>
                <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
                    <View style={styles.modalCard}>
                        <Text style={styles.modalTitle}>{t('basketTab.creatorProfile.editTitle')}</Text>
                        {creator ? (
                            <>
                                <Text style={styles.inputLabel}>{t('basketTab.creatorProfile.firstNameLabel')}</Text>
                                <TextInput
                                    style={styles.input} value={draftFirst} onChangeText={setDraftFirst}
                                    placeholderTextColor={colors.textMuted} maxLength={100} autoCapitalize="words"
                                />
                                <Text style={styles.inputLabel}>{t('basketTab.creatorProfile.lastNameLabel')}</Text>
                                <TextInput
                                    style={styles.input} value={draftLast} onChangeText={setDraftLast}
                                    placeholderTextColor={colors.textMuted} maxLength={100} autoCapitalize="words"
                                />
                            </>
                        ) : (
                            <TextInput
                                style={styles.input}
                                value={draftName}
                                onChangeText={setDraftName}
                                placeholder={DEFAULT_DISPLAY_NAME}
                                placeholderTextColor={colors.textMuted}
                                maxLength={60}
                                autoFocus
                                autoCapitalize="words"
                                returnKeyType="done"
                                onSubmitEditing={save}
                            />
                        )}
                        <Text style={styles.inputLabel}>{t('basketTab.creatorProfile.colorLabel')}</Text>
                        <View style={styles.swatchRow}>
                            {AVATAR_PALETTE.map(sw => (
                                <TouchableOpacity
                                    key={sw}
                                    onPress={() => setDraftColor(sw)}
                                    style={[styles.swatch, { backgroundColor: sw }, draftColor === sw && styles.swatchOn]}
                                    activeOpacity={0.8}
                                >
                                    {draftColor === sw && <Ionicons name="checkmark" size={16} color="#FFFFFF" />}
                                </TouchableOpacity>
                            ))}
                        </View>
                        <View style={styles.modalActions}>
                            <TouchableOpacity style={styles.modalCancel} onPress={() => setEditOpen(false)} disabled={saving}>
                                <Text style={styles.modalCancelText}>{t('basketTab.creatorProfile.cancel')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.modalSave} onPress={save} disabled={saving}>
                                {saving
                                    ? <MaterialProgress size="small" color={colors.onPrimary} />
                                    : <Text style={styles.modalSaveText}>{t('basketTab.creatorProfile.save')}</Text>}
                            </TouchableOpacity>
                        </View>
                    </View>
                </KeyboardAvoidingView>
            </Modal>
        </View>
    );
}

const AVATAR = 64;

const makeStyles = (c: AppTheme) => StyleSheet.create({
    wrap: { marginBottom: spacing.lg },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
    avatarBtn: { width: AVATAR, height: AVATAR },
    avatarImg: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, backgroundColor: c.surfaceMuted },
    avatarInitials: {
        width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2,
        backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
    },
    avatarInitialsText: { ...typography.title, fontWeight: '800', color: c.onPrimary },
    avatarEdit: {
        position: 'absolute', right: -2, bottom: -2,
        width: 22, height: 22, borderRadius: radius.pill, backgroundColor: c.primary,
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: c.pageBackground,
    },
    nameCol: { flex: 1 },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    name: { ...typography.subheading, fontWeight: '800', color: c.textPrimary, flexShrink: 1 },
    handle: { ...typography.bodySmall, color: c.textSecondary, marginTop: 2 },

    modalBackdrop: { flex: 1, backgroundColor: c.overlayBackdrop, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
    modalCard: { width: '100%', maxWidth: 420, backgroundColor: c.cardBackground, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.sm },
    modalTitle: { ...typography.subheading, fontWeight: '800', color: c.textPrimary, marginBottom: spacing.xs },
    inputLabel: { ...typography.labelSmall, color: c.textMuted, marginTop: spacing.xs },
    input: {
        borderWidth: 1, borderColor: c.border, borderRadius: radius.sm,
        paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 15, color: c.textPrimary,
    },
    swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
    swatch: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
    swatchOn: { borderWidth: 2, borderColor: c.textPrimary },
    modalActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, justifyContent: 'flex-end' },
    modalCancel: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.pill },
    modalCancelText: { ...typography.bodyStrong, fontWeight: '700', color: c.textSecondary },
    modalSave: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.pill, backgroundColor: c.primary, minWidth: 96, alignItems: 'center' },
    modalSaveText: { ...typography.bodyStrong, fontWeight: '700', color: c.onPrimary },
});
