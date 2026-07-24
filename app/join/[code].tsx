/**
 * Invite claim screen at souply://join/{code} (and souply.lt/join/{code}
 * App/Universal Links) — Souply 2.0 trip + household invites.
 *
 * Deliberately minimal for Phase 1d: preview → one confirm tap → claim →
 * done. The claim ledger is idempotent server-side, so re-opening a QR is
 * always safe. Richer destinations (trip detail, household hub) arrive
 * with Phase 4 — until then success routes back to the tab root.
 */
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { useEffect, useMemo, useState } from 'react';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { useTheme, type AppTheme } from '../../constants/theme';
import { ScreenBackButton } from '../../components/ScreenBackButton';
import { NamePromptModal } from '../../components/NamePromptModal';
import { ConfirmModal } from '../../components/ConfirmModal';
import { useProfileStore } from '../../state/profileStore';
import { patchProfileFields } from '../../utils/authApi';
import {
    fetchJoinPreview, claimJoin, leaveOwnHousehold, HouseholdExistsError,
    type JoinPreview,
} from '../../utils/joinApi';

export default function JoinInviteScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const router = useRouter();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { code } = useLocalSearchParams<{ code: string }>();

    const [preview, setPreview] = useState<JoinPreview | null>(null);
    const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'joined'>('loading');
    const [busy, setBusy] = useState(false);
    const [namePrompt, setNamePrompt] = useState(false);
    // "Already in a family shopping" guard — a household invite while already in
    // one prompts Leave (destructive) vs Stay (neutral) before the retry.
    const [leaveConfirm, setLeaveConfirm] = useState(false);
    const profile = useProfileStore(s => s.profile);
    const fetchProfile = useProfileStore(s => s.fetchProfile);
    // A shared trip/home needs everyone identifiable — resolve whether the
    // caller already has ANY name (display / first / handle).
    useEffect(() => { void fetchProfile(); }, [fetchProfile]);
    const hasName = !!(profile?.displayName || profile?.firstName || profile?.username);

    useEffect(() => {
        if (!code) { setState('invalid'); return; }
        let cancelled = false;
        setState('loading');
        fetchJoinPreview(String(code))
            .then(res => { if (!cancelled) { setPreview(res); setState(res.alreadyMember ? 'joined' : 'ready'); } })
            .catch(() => { if (!cancelled) setState('invalid'); });
        return () => { cancelled = true; };
    }, [code]);

    // Name gate: joining a shared trip/home requires a name. If the caller has
    // none, prompt (required) before the actual claim.
    const doClaim = async () => {
        if (!code || busy) return;
        if (!hasName) { setNamePrompt(true); return; }
        void performClaim();
    };

    const submitName = async (name: string, color: string) => {
        await patchProfileFields({ displayName: name, avatarColor: color });
        await fetchProfile();
        setNamePrompt(false);
        void performClaim();
    };

    const performClaim = async () => {
        if (!code || busy) return;
        try {
            setBusy(true);
            await claimJoin(String(code));
            setState('joined');
        } catch (e) {
            if (e instanceof HouseholdExistsError) {
                // ONE household per user — Leave/Stay modal before the retry.
                setLeaveConfirm(true);
            } else {
                Alert.alert(t('joinInvite.errorTitle'), t('joinInvite.errorBody'));
            }
        } finally {
            setBusy(false);
        }
    };

    const leaveThenClaim = async () => {
        if (!code) return;
        setLeaveConfirm(false);
        try {
            setBusy(true);
            await leaveOwnHousehold();
            await claimJoin(String(code));
            setState('joined');
        } catch {
            Alert.alert(t('joinInvite.errorTitle'), t('joinInvite.errorBody'));
        } finally {
            setBusy(false);
        }
    };

    const screenOptions = {
        title: '',
        headerStyle: { backgroundColor: colors.cardBackground },
        headerShadowVisible: false,
        headerLeft: () => <ScreenBackButton />,
    };

    if (state === 'loading') {
        return (
            <>
                <Stack.Screen options={screenOptions} />
                <View style={styles.wrap}>
                    <MaterialProgress size="large" color={colors.primary} />
                </View>
            </>
        );
    }

    if (state === 'invalid' || !preview) {
        return (
            <>
                <Stack.Screen options={screenOptions} />
                <View style={styles.wrap}>
                    <Ionicons name="link-outline" size={56} color={colors.textMuted} />
                    <Text style={styles.title}>{t('joinInvite.invalidTitle')}</Text>
                    <Text style={styles.body}>{t('joinInvite.invalidBody')}</Text>
                </View>
            </>
        );
    }

    const scopeKey = preview.scope === 'household' ? 'household' : 'trip';
    const heading = preview.name
        ? t(`joinInvite.${scopeKey}TitleNamed`, { name: preview.name })
        : t(`joinInvite.${scopeKey}Title`);

    if (state === 'joined') {
        return (
            <>
                <Stack.Screen options={screenOptions} />
                <View style={styles.wrap}>
                    <Ionicons name="checkmark-circle" size={56} color={colors.success} />
                    <Text style={styles.title}>{t(`joinInvite.${scopeKey}Joined`)}</Text>
                    <Text style={styles.body}>{t(`joinInvite.${scopeKey}JoinedBody`)}</Text>
                    <TouchableOpacity style={styles.cta} onPress={() => router.replace('/')}>
                        <Text style={styles.ctaText}>{t('common.gotIt')}</Text>
                    </TouchableOpacity>
                </View>
            </>
        );
    }

    return (
        <>
            <Stack.Screen options={screenOptions} />
            <View style={styles.wrap}>
                <Ionicons
                    name={preview.scope === 'household' ? 'home-outline' : 'cart-outline'}
                    size={56}
                    color={colors.primary}
                />
                <Text style={styles.title}>{heading}</Text>
                <Text style={styles.body}>{t('joinInvite.members', { count: preview.memberCount })}</Text>
                <TouchableOpacity
                    style={[styles.cta, busy && styles.ctaDisabled]}
                    onPress={doClaim}
                    disabled={busy}
                >
                    {busy
                        ? <MaterialProgress color={colors.onPrimary} />
                        : <Text style={styles.ctaText}>{t('joinInvite.join')}</Text>}
                </TouchableOpacity>
            </View>
            <NamePromptModal
                visible={namePrompt}
                onSubmit={submitName}
                onCancel={() => setNamePrompt(false)}
            />
            <ConfirmModal
                visible={leaveConfirm}
                title={t('joinInvite.leaveFirstTitle')}
                body={t('joinInvite.leaveFirstBody')}
                confirmLabel={t('joinInvite.leaveFirstConfirm')}
                cancelLabel={t('joinInvite.leaveFirstStay')}
                destructive
                busy={busy}
                onConfirm={() => { void leaveThenClaim(); }}
                onClose={() => { if (!busy) setLeaveConfirm(false); }}
            />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    wrap: {
        flex: 1, alignItems: 'center', justifyContent: 'center',
        padding: 32, gap: 12, backgroundColor: c.pageBackground,
    },
    title: { fontSize: 18, fontWeight: '700', color: c.textPrimary, textAlign: 'center' },
    body: { fontSize: 14, color: c.textSecondary, textAlign: 'center', lineHeight: 20 },
    cta: {
        marginTop: 16, paddingVertical: 14, paddingHorizontal: 32,
        borderRadius: 12, backgroundColor: c.primary,
        alignItems: 'center', alignSelf: 'stretch',
    },
    ctaDisabled: { backgroundColor: c.border },
    ctaText: { fontSize: 15, fontWeight: '700', color: c.onPrimary },
});
