/**
 * PublishWallModal — Pass B.4.
 *
 * Two-stage flow: OAuth provider selection → username picker.
 * Stage 1 short-circuits when the user is already verified; stage 2
 * short-circuits when the user already has a claimed handle.
 *
 * Used by the template editor's visibility selector when the user tries
 * to set 'public'. Also reusable later from any "claim your creator
 * page" entry point.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    View,
    Text,
    Modal,
    TouchableOpacity,
    TextInput,
    StyleSheet,
    Platform,
    Alert,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../constants/theme';
import { useAuthState } from '../state/authState';
import { signInWithGoogle, signInWithApple, isAppleSignInAvailable } from '../utils/oauthFlow';
import { OAuthButton } from './OAuthButton';
import { exchangeOauthToken, setUsername, checkUsernameAvailability, type UsernameRejectReason } from '../utils/authApi';
import { getUserId } from '../config/user';
import * as Updates from 'expo-updates';

interface Props {
    visible: boolean;
    onClose: () => void;
    /** Called once the user is verified AND has a claimed handle. */
    onComplete: () => void;
}

type Stage = 'oauth' | 'username' | 'done';

export function PublishWallModal({ visible, onClose, onComplete }: Props) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const { token, user, setSession } = useAuthState();

    const initialStage: Stage = !token
        ? 'oauth'
        : user?.username
            ? 'done'
            : 'username';
    const [stage, setStage] = useState<Stage>(initialStage);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!visible) return;
        // Re-evaluate the starting stage every time the modal opens —
        // verification or username state may have changed since last open.
        setStage(!useAuthState.getState().token
            ? 'oauth'
            : useAuthState.getState().user?.username
                ? 'done'
                : 'username');
    }, [visible]);

    useEffect(() => {
        if (stage === 'done' && visible) {
            // Allow one frame so the modal can finish its animation
            // before the parent navigates / refetches.
            requestAnimationFrame(() => onComplete());
        }
    }, [stage, visible, onComplete]);

    // ── Google sign-in ────────────────────────────────────────────────────
    const handleGoogleIdToken = useCallback(async (idToken: string) => {
        try {
            setBusy(true);
            const anonymousUserId = await getUserId();
            const res = await exchangeOauthToken({ provider: 'google', idToken, anonymousUserId });
            await setSession(res.token, res.user); // adopts res.user.id as the device userId
            // Signed into an existing account (id differs from this device's
            // anonymous id) → reload so every userId-keyed store re-hydrates
            // under the account (same pattern as account recovery).
            if (res.user.id && res.user.id !== anonymousUserId) {
                await Updates.reloadAsync();
                return;
            }
            setStage(res.user.username ? 'done' : 'username');
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
        } finally {
            setBusy(false);
        }
    }, [setSession, t]);

    const onGooglePress = useCallback(async () => {
        if (busy) return;
        try {
            const r = await signInWithGoogle();
            if (r) await handleGoogleIdToken(r.idToken); // null = user cancelled
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
        }
    }, [busy, handleGoogleIdToken, t]);

    const onApplePress = useCallback(async () => {
        if (busy) return;
        try {
            setBusy(true);
            const { idToken } = await signInWithApple();
            const anonymousUserId = await getUserId();
            const res = await exchangeOauthToken({ provider: 'apple', idToken, anonymousUserId });
            await setSession(res.token, res.user); // adopts res.user.id as the device userId
            if (res.user.id && res.user.id !== anonymousUserId) {
                await Updates.reloadAsync();
                return;
            }
            setStage(res.user.username ? 'done' : 'username');
        } catch {
            // User likely cancelled — no toast.
        } finally {
            setBusy(false);
        }
    }, [busy, setSession]);

    // ── Username picker ───────────────────────────────────────────────────
    const [candidate, setCandidate] = useState('');
    const [checkState, setCheckState] = useState<{
        available?: boolean; reason?: UsernameRejectReason; checking?: boolean;
    }>({});
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (stage !== 'username') return;
        const trimmed = candidate.trim();
        if (trimmed.length < 3) {
            setCheckState({});
            return;
        }
        if (debounceRef.current) clearTimeout(debounceRef.current);
        setCheckState(prev => ({ ...prev, checking: true }));
        debounceRef.current = setTimeout(async () => {
            try {
                const out = await checkUsernameAvailability(trimmed);
                setCheckState({ available: out.available, reason: out.reason, checking: false });
            } catch {
                setCheckState({ available: false, reason: 'bad-format', checking: false });
            }
        }, 300);
        return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }, [candidate, stage]);

    const submitUsername = useCallback(async () => {
        const trimmed = candidate.trim();
        if (trimmed.length === 0 || busy) return;
        try {
            setBusy(true);
            const out = await setUsername(trimmed);
            if (!out.ok) {
                setCheckState({ available: false, reason: out.reason });
                return;
            }
            await useAuthState.getState().updateUser({ username: out.username });
            setStage('done');
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
        } finally {
            setBusy(false);
        }
    }, [candidate, busy, t]);

    const reasonText = (r: UsernameRejectReason | undefined): string => {
        switch (r) {
            case 'taken': return t('basketTab.templates.usernameTaken');
            case 'reserved': return t('basketTab.templates.usernameReserved');
            case 'too-short': return t('basketTab.templates.usernameTooShort');
            case 'too-long': return t('basketTab.templates.usernameTooLong');
            case 'rate-limited': return t('basketTab.templates.usernameRateLimited');
            case 'bad-format': return t('basketTab.templates.usernameInvalid');
            default: return '';
        }
    };

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={busy ? () => {} : onClose}
        >
            <TouchableOpacity
                style={styles.backdrop}
                activeOpacity={1}
                onPress={busy ? undefined : onClose}
            >
                <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.sheet}>
                    {stage === 'oauth' && (
                        <>
                            <View style={styles.iconWrap}>
                                <Ionicons name="lock-closed" size={28} color={colors.primary} />
                            </View>
                            <Text style={styles.title}>{t('basketTab.templates.publishWallTitle')}</Text>
                            <Text style={styles.body}>{t('basketTab.templates.publishWallBody')}</Text>

                            <OAuthButton
                                provider="google"
                                label={t('basketTab.templates.publishContinueGoogle')}
                                onPress={onGooglePress}
                                disabled={busy}
                            />

                            {isAppleSignInAvailable && (
                                <OAuthButton
                                    provider="apple"
                                    label={t('basketTab.templates.publishContinueApple')}
                                    onPress={onApplePress}
                                    disabled={busy}
                                />
                            )}

                            <TouchableOpacity style={styles.cancelBtn} onPress={onClose} disabled={busy}>
                                <Text style={styles.cancelBtnText}>{t('basketTab.templates.publishCancel')}</Text>
                            </TouchableOpacity>
                            {busy && <MaterialProgress color={colors.primary} style={{ marginTop: 8 }} />}
                        </>
                    )}

                    {stage === 'username' && (
                        <>
                            <View style={styles.iconWrap}>
                                <Ionicons name="at" size={28} color={colors.primary} />
                            </View>
                            <Text style={styles.title}>{t('basketTab.templates.usernamePromptTitle')}</Text>
                            <Text style={styles.body}>{t('basketTab.templates.usernamePromptBody')}</Text>

                            <View style={styles.inputRow}>
                                <Text style={styles.inputPrefix}>@</Text>
                                <TextInput
                                    style={styles.input}
                                    value={candidate}
                                    onChangeText={setCandidate}
                                    placeholder={t('basketTab.templates.usernamePlaceholder')}
                                    placeholderTextColor={colors.textMuted}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    maxLength={20}
                                    returnKeyType="done"
                                    onSubmitEditing={submitUsername}
                                />
                                {checkState.checking && <MaterialProgress size="small" color={colors.primary} />}
                                {!checkState.checking && checkState.available === true && (
                                    <Ionicons name="checkmark-circle" size={22} color={colors.success} />
                                )}
                                {!checkState.checking && checkState.available === false && (
                                    <Ionicons name="close-circle" size={22} color={colors.error} />
                                )}
                            </View>

                            {checkState.reason && (
                                <Text style={styles.errorHint}>{reasonText(checkState.reason)}</Text>
                            )}

                            <TouchableOpacity
                                style={[
                                    styles.providerBtn,
                                    styles.primaryBtn,
                                    (!checkState.available || busy) && styles.disabledBtn,
                                ]}
                                onPress={submitUsername}
                                disabled={!checkState.available || busy}
                            >
                                {busy
                                    ? <MaterialProgress color={colors.onPrimary} />
                                    : <Text style={[styles.providerBtnText, { color: colors.onPrimary }]}>
                                        {t('basketTab.templates.usernameConfirm')}
                                      </Text>}
                            </TouchableOpacity>
                        </>
                    )}
                </TouchableOpacity>
            </TouchableOpacity>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 20 },
    sheet: { backgroundColor: c.cardBackground, borderRadius: 16, padding: 20, gap: 10, width: '100%' },
    iconWrap: {
        width: 56, height: 56, borderRadius: 28,
        backgroundColor: c.primaryMuted,
        alignSelf: 'center',
        alignItems: 'center', justifyContent: 'center',
        marginBottom: 4,
    },
    title: { fontSize: 17, fontWeight: '700', color: c.textPrimary, textAlign: 'center' },
    body: { fontSize: 13, color: c.textSecondary, textAlign: 'center', lineHeight: 18 },

    providerBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        paddingVertical: 12, borderRadius: 10, marginTop: 8,
    },
    googleBtn: { backgroundColor: '#4285F4' },
    appleBtn: { backgroundColor: '#000' },
    primaryBtn: { backgroundColor: c.primary },
    disabledBtn: { backgroundColor: c.border },
    providerBtnText: { fontSize: 14, fontWeight: '700', color: '#fff' },
    cancelBtn: { paddingVertical: 10, alignItems: 'center' },
    cancelBtnText: { fontSize: 13, fontWeight: '600', color: c.textSecondary },

    inputRow: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        borderWidth: 1, borderColor: c.border, borderRadius: 10,
        paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 12 : 6,
        backgroundColor: c.cardBackground,
    },
    inputPrefix: { fontSize: 16, color: c.textMuted, fontWeight: '600' },
    input: { flex: 1, fontSize: 16, color: c.textPrimary, padding: 0 },
    errorHint: { fontSize: 12, color: c.error },
});
