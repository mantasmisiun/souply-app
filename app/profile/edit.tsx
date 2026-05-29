/**
 * Profile editor — Pass B remainder.
 *
 * Source spec: Documentation/roadmap/sablonai.md Part 6.5.
 *
 * Lets the verified user set their displayName, bio, and avatar.
 * Username editing is read-only at v1 (matches the spec; v1.5 adds
 * 30-day-rate-limited edits via the same publish-wall picker).
 */
import {
    View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
    Image, ActivityIndicator, Alert, Platform,
} from 'react-native';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { useTheme, type AppTheme } from '../../constants/theme';
import { ScreenBackButton } from '../../components/ScreenBackButton';
import { useAuthState } from '../../state/authState';
import { patchProfileFields, uploadAvatar } from '../../utils/authApi';

const BIO_MAX = 160;
const DISPLAY_NAME_MAX = 60;

export default function ProfileEditScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const router = useRouter();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const user = useAuthState(s => s.user);
    const updateUser = useAuthState(s => s.updateUser);

    const [displayName, setDisplayName] = useState(user?.displayName ?? '');
    const [bio, setBio] = useState(user?.bio ?? '');
    const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl ?? null);
    const [uploading, setUploading] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!user) {
            // Not authed — kick back; this screen shouldn't be reachable
            // without a session, but defend against deep-linking anyway.
            router.back();
        }
    }, [user, router]);

    const onPickAvatar = async () => {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) return;
        const res = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.85,
            base64: false,
        });
        if (res.canceled || res.assets.length === 0) return;
        const asset = res.assets[0];
        try {
            setUploading(true);
            // expo-file-system v19 dropped the EncodingType enum in favour of
            // string literals — base64 is the supported value.
            const base64 = await FileSystem.readAsStringAsync(asset.uri, {
                encoding: 'base64' as any,
            });
            const mime = asset.mimeType ?? 'image/jpeg';
            const url = await uploadAvatar(base64, mime);
            if (!url) throw new Error('upload-failed');
            setAvatarUrl(url);
            await updateUser({ avatarUrl: url });
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('creatorProfile.errorSave'));
        } finally {
            setUploading(false);
        }
    };

    const onSave = async () => {
        if (saving) return;
        try {
            setSaving(true);
            const ok = await patchProfileFields({
                displayName: displayName.slice(0, DISPLAY_NAME_MAX),
                bio: bio.slice(0, BIO_MAX),
            });
            if (!ok) throw new Error('save-failed');
            await updateUser({
                displayName: displayName.trim() || null,
                bio: bio.trim() || null,
            });
            Alert.alert(t('creatorProfile.savedToast'));
            router.back();
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('creatorProfile.errorSave'));
        } finally {
            setSaving(false);
        }
    };

    if (!user) return null;

    return (
        <>
            <Stack.Screen options={{
                title: t('creatorProfile.title'),
                headerStyle: { backgroundColor: colors.cardBackground },
                headerShadowVisible: false,
                headerLeft: () => <ScreenBackButton />,
                headerRight: () => (
                    <TouchableOpacity onPress={onSave} disabled={saving}>
                        {saving
                            ? <ActivityIndicator size="small" color={colors.primary} />
                            : <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 15, paddingHorizontal: 8 }}>
                                {t('creatorProfile.saveBtn')}
                              </Text>}
                    </TouchableOpacity>
                ),
            }} />
            <ScrollView
                style={styles.container}
                contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 40 }}
                keyboardShouldPersistTaps="handled"
            >
                {/* Avatar */}
                <View style={styles.section}>
                    <Text style={styles.label}>{t('creatorProfile.avatarLabel')}</Text>
                    <View style={styles.avatarRow}>
                        <View style={styles.avatarWrap}>
                            {avatarUrl
                                ? <Image source={{ uri: avatarUrl }} style={styles.avatar} />
                                : <Ionicons name="person" size={42} color={colors.textMuted} />}
                        </View>
                        <TouchableOpacity
                            style={styles.avatarChangeBtn}
                            onPress={onPickAvatar}
                            disabled={uploading}
                        >
                            {uploading
                                ? <ActivityIndicator color={colors.primary} />
                                : <Text style={styles.avatarChangeText}>{t('creatorProfile.avatarChange')}</Text>}
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Username (read-only) */}
                <View style={styles.section}>
                    <Text style={styles.label}>@</Text>
                    <View style={styles.handlePill}>
                        <Text style={styles.handleText}>{user.username ?? t('creatorProfile.noUsername')}</Text>
                    </View>
                </View>

                {/* Display name */}
                <View style={styles.section}>
                    <Text style={styles.label}>{t('creatorProfile.displayNameLabel')}</Text>
                    <TextInput
                        style={styles.input}
                        value={displayName}
                        onChangeText={setDisplayName}
                        placeholder={t('creatorProfile.displayNamePlaceholder')}
                        placeholderTextColor={colors.textMuted}
                        maxLength={DISPLAY_NAME_MAX}
                        returnKeyType="next"
                    />
                </View>

                {/* Bio */}
                <View style={styles.section}>
                    <Text style={styles.label}>{t('creatorProfile.bioLabel')}</Text>
                    <TextInput
                        style={[styles.input, styles.bioInput]}
                        value={bio}
                        onChangeText={setBio}
                        placeholder={t('creatorProfile.bioPlaceholder')}
                        placeholderTextColor={colors.textMuted}
                        maxLength={BIO_MAX}
                        multiline
                        textAlignVertical="top"
                    />
                    <Text style={styles.bioCounter}>{bio.length}/{BIO_MAX}</Text>
                </View>
            </ScrollView>
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    section: { gap: 6 },
    label: { fontSize: 12, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: '700' },

    avatarRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
    avatarWrap: {
        width: 96, height: 96, borderRadius: 48,
        backgroundColor: c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
        borderWidth: 2, borderColor: c.primary,
    },
    avatar: { width: '100%', height: '100%' },
    avatarChangeBtn: {
        paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8,
        borderWidth: 1, borderColor: c.border,
    },
    avatarChangeText: { fontSize: 13, fontWeight: '600', color: c.primary },

    handlePill: {
        backgroundColor: c.surfaceMuted, borderRadius: 10,
        paddingHorizontal: 12, paddingVertical: 12,
    },
    handleText: { fontSize: 15, color: c.textPrimary, fontWeight: '600' },

    input: {
        borderWidth: 1, borderColor: c.border, borderRadius: 10,
        paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 12 : 8,
        fontSize: 15, color: c.textPrimary,
        backgroundColor: c.cardBackground,
    },
    bioInput: { minHeight: 96 },
    bioCounter: { fontSize: 11, color: c.textMuted, alignSelf: 'flex-end' },
});
