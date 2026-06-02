import React, { useMemo, useState } from 'react';
import { View, Text, Image, TouchableOpacity, TextInput, Modal, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { useTheme, type AppTheme } from '../constants/theme';
import { useAuthState } from '../state/authState';
import { type ProfileData } from '../state/profileStore';
import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';
import { patchProfileFields } from '../utils/authApi';
import { formatEuro } from '../utils/formatCurrency';

type Props = {
    profile: ProfileData;
    onAvatarChanged: () => void;
};

export default function CreatorProfileHeader({ profile, onAvatarChanged }: Props) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [uploading, setUploading] = useState(false);
    const [localUri, setLocalUri] = useState<string | null>(null);
    const [editOpen, setEditOpen] = useState(false);
    const [draftFirst, setDraftFirst] = useState('');
    const [draftLast, setDraftLast] = useState('');
    const [savingName, setSavingName] = useState(false);
    // The logged-in session already carries identity — use it as a fallback so
    // the header is correct even if the /profile fetch is stale or hasn't been
    // redeployed with the new fields yet.
    const authUser = useAuthState(s => s.user);

    const username = profile.username ?? authUser?.username ?? null;
    // Name = first + last (editable, two fields); fall back to displayName then @handle.
    const fullName =
        [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim() ||
        profile.displayName ||
        authUser?.displayName ||
        (username ? `@${username}` : t('basketTab.creatorProfile.title'));
    const handle = username ? `@${username}` : null;
    const avatarSrc = localUri ?? profile.avatarUrl ?? null;
    const initials = (() => {
        const fl = `${(profile.firstName ?? '').trim()[0] ?? ''}${(profile.lastName ?? '').trim()[0] ?? ''}`.toUpperCase();
        if (fl) return fl;
        const dn = (profile.displayName ?? authUser?.displayName ?? '').trim();
        if (dn) return dn.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
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
            onAvatarChanged();
        } catch {
            setLocalUri(null);
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.creatorProfile.avatarFailed'));
        } finally {
            setUploading(false);
        }
    };

    const openEdit = () => {
        const fn = profile.firstName ?? '';
        const ln = profile.lastName ?? '';
        if (!fn && !ln) {
            // No first/last yet — seed the fields from the displayed name so the
            // user isn't faced with empty inputs when a name is clearly set.
            const parts = (profile.displayName ?? authUser?.displayName ?? '').trim().split(/\s+/).filter(Boolean);
            setDraftFirst(parts[0] ?? '');
            setDraftLast(parts.slice(1).join(' '));
        } else {
            setDraftFirst(fn);
            setDraftLast(ln);
        }
        setEditOpen(true);
    };
    const saveName = async () => {
        if (savingName) return;
        setSavingName(true);
        const ok = await patchProfileFields({ firstName: draftFirst.trim(), lastName: draftLast.trim() });
        setSavingName(false);
        if (ok) { setEditOpen(false); onAvatarChanged(); }
        else Alert.alert(t('basketTab.errorGeneric'), t('basketTab.creatorProfile.saveFailed'));
    };

    const cards: Array<{ label: string; value: string }> = [
        { label: t('profilis.statTemplates'), value: String(profile.templateCount ?? 0) },
        { label: t('profilis.statVisits'), value: String(profile.totalVisits ?? 0) },
        { label: t('profilis.statUses'), value: String(profile.totalUses ?? 0) },
        { label: t('profilis.statFollowerSavings'), value: formatEuro(profile.totalFollowerSavingsEur ?? 0) },
    ];

    return (
        <View style={styles.wrap}>
            <View style={styles.row}>
                <TouchableOpacity style={styles.avatarBtn} onPress={pickAndUpload} activeOpacity={0.8} disabled={uploading}>
                    {avatarSrc ? (
                        <Image source={{ uri: avatarSrc }} style={styles.avatarImg} />
                    ) : (
                        <View style={styles.avatarInitials}>
                            <Text style={styles.avatarInitialsText}>{initials}</Text>
                        </View>
                    )}
                    <View style={styles.avatarEdit}>
                        {uploading
                            ? <ActivityIndicator size="small" color="#FFFFFF" />
                            : <Ionicons name="camera" size={13} color="#FFFFFF" />}
                    </View>
                </TouchableOpacity>
                <TouchableOpacity style={styles.nameCol} onPress={openEdit} activeOpacity={0.7}>
                    <View style={styles.nameRow}>
                        <Text style={styles.name} numberOfLines={1}>{fullName}</Text>
                        <Ionicons name="pencil" size={13} color={colors.textMuted} />
                    </View>
                    {handle && <Text style={styles.handle} numberOfLines={1}>{handle}</Text>}
                </TouchableOpacity>
            </View>

            <View style={styles.cards}>
                {cards.map((c, i) => (
                    <View key={i} style={styles.card}>
                        <Text style={styles.cardValue} numberOfLines={1}>{c.value}</Text>
                        <Text style={styles.cardLabel} numberOfLines={1}>{c.label}</Text>
                    </View>
                ))}
            </View>

            <Modal visible={editOpen} transparent animationType="fade" onRequestClose={() => setEditOpen(false)}>
                <View style={styles.modalBackdrop}>
                    <View style={styles.modalCard}>
                        <Text style={styles.modalTitle}>{t('basketTab.creatorProfile.editTitle')}</Text>
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
                        <View style={styles.modalActions}>
                            <TouchableOpacity style={styles.modalCancel} onPress={() => setEditOpen(false)}>
                                <Text style={styles.modalCancelText}>{t('basketTab.creatorProfile.cancel')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.modalSave} onPress={saveName} disabled={savingName}>
                                {savingName
                                    ? <ActivityIndicator size="small" color={colors.onPrimary} />
                                    : <Text style={styles.modalSaveText}>{t('basketTab.creatorProfile.save')}</Text>}
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

const AVATAR = 64;

const makeStyles = (c: AppTheme) => StyleSheet.create({
    wrap: { gap: 14, marginBottom: 18 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
    avatarBtn: { width: AVATAR, height: AVATAR },
    avatarImg: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, backgroundColor: c.surfaceMuted },
    avatarInitials: {
        width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2,
        backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
    },
    avatarInitialsText: { fontSize: 24, fontWeight: '800', color: c.onPrimary },
    avatarEdit: {
        position: 'absolute', right: -2, bottom: -2,
        width: 22, height: 22, borderRadius: 11, backgroundColor: c.primary,
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: c.pageBackground,
    },
    nameCol: { flex: 1 },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    name: { fontSize: 18, fontWeight: '800', color: c.textPrimary, flexShrink: 1 },
    handle: { fontSize: 14, color: c.textSecondary, marginTop: 2 },
    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
    modalCard: { width: '100%', maxWidth: 420, backgroundColor: c.cardBackground, borderRadius: 18, padding: 20, gap: 8 },
    modalTitle: { fontSize: 17, fontWeight: '800', color: c.textPrimary, marginBottom: 4 },
    inputLabel: { fontSize: 12, fontWeight: '600', color: c.textMuted, marginTop: 4 },
    input: {
        borderWidth: 1, borderColor: c.border, borderRadius: 10,
        paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: c.textPrimary,
    },
    modalActions: { flexDirection: 'row', gap: 10, marginTop: 12, justifyContent: 'flex-end' },
    modalCancel: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 10 },
    modalCancelText: { fontSize: 15, fontWeight: '700', color: c.textSecondary },
    modalSave: { paddingHorizontal: 18, paddingVertical: 11, borderRadius: 10, backgroundColor: c.primary, minWidth: 96, alignItems: 'center' },
    modalSaveText: { fontSize: 15, fontWeight: '700', color: c.onPrimary },
    cards: { flexDirection: 'row', gap: 8 },
    card: {
        flex: 1, backgroundColor: c.cardBackground, borderRadius: 12,
        paddingVertical: 12, paddingHorizontal: 6, alignItems: 'center', gap: 3,
        borderWidth: 1, borderColor: c.border,
    },
    cardValue: { fontSize: 17, fontWeight: '800', color: c.primary },
    cardLabel: { fontSize: 10, fontWeight: '600', color: c.textSecondary, textAlign: 'center' },
});
