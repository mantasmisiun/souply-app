import {
    View, Text, ScrollView, TouchableOpacity, StyleSheet,
    Modal, Platform, Alert,
} from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import Animated from 'react-native-reanimated';
import { useCollapsingHeader, CollapsingHeader } from '../../components/CollapsingHeader';
import { ScreenHeading } from '../../components/ScreenHeading';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme, type AppTheme } from '../../constants/theme';
import { getUserId } from '../../config/user';
import { signInWithGoogle, signInWithApple, isAppleSignInAvailable } from '../../utils/oauthFlow';
import { exchangeOauthToken } from '../../utils/authApi';
import { useAuthState, DEV_SESSION_TOKEN } from '../../state/authState';
import { CreateUsernameModal } from '../../components/CreateUsernameModal';
import { OAuthButton } from '../../components/OAuthButton';

const INTRO_SEEN_KEY = 'creator_intro_seen_v1';

/** Mirrors the web's gated dev-auth bypass: visible in Metro dev + the EAS
 *  DEV variant, never in production. Same gate the Profilis dev tools use. */
const IS_DEV_BUILD = __DEV__ || Constants.expoConfig?.name === 'Souply (DEV)';

/** The five intro cards. 1–4 are the creator audiences/benefits (mirrors the
 *  website landing); the 5th is the "creators only" disclaimer, styled apart. */
const CARDS: { key: string; icon: keyof typeof Ionicons.glyphMap; disclaimer?: boolean }[] = [
    { key: '1', icon: 'calendar-outline' },
    { key: '2', icon: 'medkit-outline' },
    { key: '3', icon: 'book-outline' },
    { key: '4', icon: 'phone-portrait-outline' },
    { key: '5', icon: 'information-circle-outline', disclaimer: true },
];

/**
 * Creator sign-in entry, pushed from the Profilis "Kūrėjo paskyra" CTA.
 * Google on every platform; Apple additionally on iOS (App Store requires
 * Sign in with Apple when another social login is offered). Reuses the same
 * OAuth flow as the publish wall (oauthFlow + exchangeOauthToken + authState).
 * On first open it shows a benefits modal so the visitor understands the
 * account is for creators, not regular shoppers.
 */
export default function CreatorAuthScreen() {
    const colors = useTheme();
    const header = useCollapsingHeader();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const { t } = useTranslation();
    const setSession = useAuthState((s) => s.setSession);

    // Which provider is mid-sign-in — so the spinner renders on the button the
    // user actually tapped (not always Google). `busy` = either in flight.
    const [pending, setPending] = useState<'google' | 'apple' | null>(null);
    const busy = pending !== null;
    const [showIntro, setShowIntro] = useState(false);
    const [needUsername, setNeedUsername] = useState(false);

    useEffect(() => {
        AsyncStorage.getItem(INTRO_SEEN_KEY).then((seen) => {
            if (!seen) setShowIntro(true);
        });
    }, []);

    const dismissIntro = useCallback(() => {
        setShowIntro(false);
        AsyncStorage.setItem(INTRO_SEEN_KEY, '1').catch(() => {});
    }, []);

    const onSignedIn = useCallback(async (provider: 'google' | 'apple', idToken: string) => {
        try {
            // `pending` is already set by the press handler that called us.
            const anonymousUserId = await getUserId();
            const res = await exchangeOauthToken({ provider, idToken, anonymousUserId });
            // setSession adopts res.user.id as the device userId, so from here on
            // EVERY userId-keyed call (profile, templates, stats, mutations)
            // targets the signed-in account — correctness no longer needs a hard
            // reload. We deliberately do NOT call Updates.reloadAsync() on sign-in:
            // it restarts the app to the default tab (or no-ops and strands this
            // screen), which is exactly the "didn't go back to Profilis" bug.
            // Lists cached under the old anonymous id refresh on focus, and
            // authState.hydrate() self-heals any id mismatch on the next cold start.
            await setSession(res.token, res.user);
            // First sign-in (no @handle yet) → pick a username before leaving;
            // returning users go straight back to Profilis.
            if (!res.user.username) {
                setNeedUsername(true);
                setPending(null);
            } else if (Platform.OS === 'ios') {
                // The native Apple/Google sheet may still be mid-dismissal when
                // the token exchange resolves — a router.back() fired then gets
                // SWALLOWED by UIKit (the "stayed on the login screen, but back
                // showed me signed in" report). Defer the pop past the dismissal
                // and KEEP the spinner so the wait doesn't read as a failure.
                setTimeout(() => router.back(), 550);
            } else {
                router.back();
            }
        } catch {
            Alert.alert(t('creatorAuth.title'), t('basketTab.errorGeneric'));
            setPending(null);
        }
    }, [setSession, router, t]);

    const onGooglePress = useCallback(async () => {
        if (busy) return;
        setPending('google');
        try {
            const r = await signInWithGoogle();
            if (r) await onSignedIn('google', r.idToken); // null = user cancelled
            else setPending(null);
        } catch {
            setPending(null);
            Alert.alert(t('creatorAuth.title'), t('basketTab.errorGeneric'));
        }
    }, [busy, onSignedIn, t]);

    const onApplePress = useCallback(async () => {
        if (busy) return;
        setPending('apple');
        try {
            const { idToken } = await signInWithApple();
            await onSignedIn('apple', idToken);
        } catch {
            setPending(null); // user cancelled — no toast
        }
    }, [busy, onSignedIn]);

    // DEV-ONLY bypass — skips OAuth and sets a simulated creator session so
    // the signed-in UI / sign-out can be exercised without a real Google
    // round-trip. Client-only (the token is fake; verified-only endpoints
    // like publishing will still 401). Gated by IS_DEV_BUILD → never ships
    // to production. Mirrors the web's "Dev sign-in (skip auth)" button.
    const onDevSignIn = useCallback(async () => {
        const id = await getUserId();
        await setSession(DEV_SESSION_TOKEN, {
            id,
            username: 'mantasm',
            displayName: 'Mantas Misiūnas',
            bio: null,
            avatarUrl: null,
            email: null,
            authProvider: 'google',
        });
        router.back();
    }, [setSession, router]);

    return (
        <View style={styles.container}>
            <CollapsingHeader
                controller={header}
                back
                smallTitle={t('creatorAuth.title')}
            />
            <Animated.ScrollView {...header.scroll} style={{ flex: 1 }} contentContainerStyle={[styles.scroll, { paddingTop: 0 }]}>
                <ScreenHeading title={t('creatorAuth.title')} onLayout={header.onTitleLayout} />
                <View style={styles.hero}>
                    <View style={styles.heroBadge}>
                        <Text style={styles.heroEmoji}>✨</Text>
                    </View>
                    <Text style={styles.heroTitle}>{t('creatorAuth.introTitle')}</Text>
                    <Text style={styles.heroSub}>{t('creatorAuth.subtitle')}</Text>
                </View>

                <View style={styles.buttons}>
                    <OAuthButton
                        provider="google"
                        label={t('creatorAuth.google')}
                        onPress={onGooglePress}
                        disabled={busy}
                        loading={pending === 'google'}
                    />

                    {isAppleSignInAvailable && (
                        <OAuthButton
                            provider="apple"
                            label={t('creatorAuth.apple')}
                            onPress={onApplePress}
                            disabled={busy}
                            loading={pending === 'apple'}
                        />
                    )}

                    {IS_DEV_BUILD && (
                        <TouchableOpacity
                            style={styles.devBtn}
                            onPress={onDevSignIn}
                            disabled={busy}
                            activeOpacity={0.7}
                        >
                            <Ionicons name="construct-outline" size={15} color={colors.primary} />
                            <Text style={styles.devBtnText}>Dev sign-in (skip OAuth → 000…)</Text>
                        </TouchableOpacity>
                    )}
                </View>

                <TouchableOpacity style={styles.whoLink} onPress={() => setShowIntro(true)}>
                    <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
                    <Text style={styles.whoLinkText}>{t('creatorAuth.introSubtitle')}</Text>
                </TouchableOpacity>
            </Animated.ScrollView>

            {/* First-open benefits modal */}
            <Modal visible={showIntro} transparent animationType="slide" onRequestClose={dismissIntro}>
                <View style={styles.modalBackdrop}>
                    <View style={styles.modalSheet}>
                        <Text style={styles.modalTitle}>{t('creatorAuth.introTitle')}</Text>
                        <Text style={styles.modalSub}>{t('creatorAuth.introSubtitle')}</Text>
                        <ScrollView style={styles.cardsScroll} showsVerticalScrollIndicator={false}>
                            {CARDS.map(({ key, icon, disclaimer }) => (
                                <View key={key} style={[styles.card, disclaimer && styles.cardDisclaimer]}>
                                    <View style={[styles.cardIcon, disclaimer && styles.cardIconDisclaimer]}>
                                        <Ionicons
                                            name={icon}
                                            size={20}
                                            color={disclaimer ? colors.textSecondary : colors.primary}
                                        />
                                    </View>
                                    <View style={styles.cardTextWrap}>
                                        <Text style={styles.cardTitle}>{t(`creatorAuth.cards.${key}.title`)}</Text>
                                        <Text style={styles.cardBody}>{t(`creatorAuth.cards.${key}.body`)}</Text>
                                    </View>
                                </View>
                            ))}
                        </ScrollView>
                        <TouchableOpacity style={styles.gotItBtn} onPress={dismissIntro} activeOpacity={0.85}>
                            <Text style={styles.gotItText}>{t('creatorAuth.gotIt')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>

            {/* Required first-sign-in username picker. */}
            <CreateUsernameModal
                visible={needUsername}
                // Close the handle modal FIRST, then return to Profilis. Firing
                // router.back() while the native <Modal> is still presented gets
                // swallowed on iOS (the "stuck on creator-auth after picking a
                // handle" bug), so on iOS we navigate from the modal's onDismiss
                // — which fires only after it's fully gone. Android's Modal has no
                // onDismiss and doesn't block the pop, so go back immediately.
                onDone={() => {
                    setNeedUsername(false);
                    if (Platform.OS !== 'ios') router.back();
                }}
                onDismiss={() => { if (Platform.OS === 'ios') router.back(); }}
            />
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    scroll: { padding: 20, gap: 24 },
    hero: { alignItems: 'center', paddingTop: 24, gap: 8 },
    heroBadge: {
        width: 64, height: 64, borderRadius: 20, backgroundColor: c.primary,
        alignItems: 'center', justifyContent: 'center', marginBottom: 4,
    },
    heroEmoji: { fontSize: 32 },
    heroTitle: { fontSize: 22, fontWeight: '800', color: c.textPrimary },
    heroSub: { fontSize: 14, color: c.textSecondary, textAlign: 'center' },
    buttons: { gap: 12 },
    oauthBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
        paddingVertical: 15, borderRadius: 14,
    },
    googleBtn: { backgroundColor: c.primary },
    appleBtn: { backgroundColor: '#000' },
    oauthBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
    devBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        paddingVertical: 12, borderRadius: 14, marginTop: 4,
        borderWidth: 2, borderStyle: 'dashed', borderColor: c.primary,
    },
    devBtnText: { color: c.primary, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
    whoLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8 },
    whoLinkText: { fontSize: 13, color: c.textSecondary, fontWeight: '600' },

    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    modalSheet: {
        backgroundColor: c.pageBackground, borderTopLeftRadius: 24, borderTopRightRadius: 24,
        padding: 20, maxHeight: '85%',
    },
    modalTitle: { fontSize: 20, fontWeight: '800', color: c.textPrimary },
    modalSub: { fontSize: 13, color: c.textSecondary, marginTop: 2, marginBottom: 16, textTransform: 'uppercase', letterSpacing: 1, fontWeight: '700' },
    cardsScroll: { flexGrow: 0 },
    card: {
        flexDirection: 'row', gap: 14, padding: 14, borderRadius: 16,
        backgroundColor: c.cardBackground, marginBottom: 10,
    },
    cardDisclaimer: { backgroundColor: c.surfaceMuted ?? c.cardBackground, borderWidth: 1, borderColor: c.border },
    cardIcon: {
        width: 40, height: 40, borderRadius: 12,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted, alignItems: 'center', justifyContent: 'center',
    },
    cardIconDisclaimer: { backgroundColor: c.cardBackground },
    cardTextWrap: { flex: 1 },
    cardTitle: { fontSize: 15, fontWeight: '700', color: c.textPrimary, marginBottom: 2 },
    cardBody: { fontSize: 13, color: c.textSecondary, lineHeight: 18 },
    gotItBtn: {
        marginTop: 8, backgroundColor: c.primary, borderRadius: 14, paddingVertical: 15, alignItems: 'center',
    },
    gotItText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
