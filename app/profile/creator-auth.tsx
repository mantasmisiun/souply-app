import {
    View, Text, ScrollView, TouchableOpacity, StyleSheet,
    Modal, Platform, ActivityIndicator, Alert,
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
import * as Updates from 'expo-updates';
import { signInWithGoogle, signInWithApple, isAppleSignInAvailable } from '../../utils/oauthFlow';
import { exchangeOauthToken } from '../../utils/authApi';
import { useAuthState, DEV_SESSION_TOKEN } from '../../state/authState';
import { CreateUsernameModal } from '../../components/CreateUsernameModal';

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

    const [busy, setBusy] = useState(false);
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
            setBusy(true);
            const anonymousUserId = await getUserId();
            const res = await exchangeOauthToken({ provider, idToken, anonymousUserId });
            await setSession(res.token, res.user); // adopts res.user.id as the device userId
            // Signed into an EXISTING account whose id differs from this device's
            // anonymous id → reload so every userId-keyed store (profile,
            // templates, stats) re-hydrates under the account. Same pattern as
            // account recovery; otherwise edits hit the account while the
            // screens still show the stale anonymous identity.
            if (res.user.id && res.user.id !== anonymousUserId) {
                await Updates.reloadAsync();
                return;
            }
            // First sign-in (no username yet) → require a @handle before
            // leaving. Returning users go straight back.
            if (!res.user.username) {
                setNeedUsername(true);
            } else {
                router.back();
            }
        } catch {
            Alert.alert(t('creatorAuth.title'), t('basketTab.errorGeneric'));
        } finally {
            setBusy(false);
        }
    }, [setSession, router, t]);

    const onGooglePress = useCallback(async () => {
        if (busy) return;
        try {
            const r = await signInWithGoogle();
            if (r) await onSignedIn('google', r.idToken); // null = user cancelled
        } catch {
            Alert.alert(t('creatorAuth.title'), t('basketTab.errorGeneric'));
        }
    }, [busy, onSignedIn, t]);

    const onApplePress = useCallback(async () => {
        if (busy) return;
        try {
            const { idToken } = await signInWithApple();
            await onSignedIn('apple', idToken);
        } catch { /* user cancelled — no toast */ }
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
                background={colors.cardBackground}
                back
                collapsing={<ScreenHeading title={t('creatorAuth.title')} />}
            />
            <Animated.ScrollView {...header.scroll} contentContainerStyle={[styles.scroll, { paddingTop: header.paddingTop + 20 }]}>
                <View style={styles.hero}>
                    <View style={styles.heroBadge}>
                        <Text style={styles.heroEmoji}>✨</Text>
                    </View>
                    <Text style={styles.heroTitle}>{t('creatorAuth.introTitle')}</Text>
                    <Text style={styles.heroSub}>{t('creatorAuth.subtitle')}</Text>
                </View>

                <View style={styles.buttons}>
                    <TouchableOpacity
                        style={[styles.oauthBtn, styles.googleBtn]}
                        onPress={onGooglePress}
                        disabled={busy}
                        activeOpacity={0.85}
                    >
                        {busy
                            ? <ActivityIndicator color="#fff" />
                            : <>
                                <Ionicons name="logo-google" size={18} color="#fff" />
                                <Text style={styles.oauthBtnText}>{t('creatorAuth.google')}</Text>
                              </>}
                    </TouchableOpacity>

                    {isAppleSignInAvailable && (
                        <TouchableOpacity
                            style={[styles.oauthBtn, styles.appleBtn]}
                            onPress={onApplePress}
                            disabled={busy}
                            activeOpacity={0.85}
                        >
                            <Ionicons name="logo-apple" size={18} color="#fff" />
                            <Text style={styles.oauthBtnText}>{t('creatorAuth.apple')}</Text>
                        </TouchableOpacity>
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
            <CreateUsernameModal visible={needUsername} onDone={() => router.back()} />
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
