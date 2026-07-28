import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Dimensions, Alert, Modal, Pressable, Switch, DevSettings } from 'react-native';
import Animated, {
    Easing,
    FadeIn,
    FadeOut,
    LinearTransition,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { GlassIconButton } from '../../../components/GlassIconButton';
import { useRouter , useFocusEffect, useNavigation } from 'expo-router';
import { ScreenHeading } from '../../../components/ScreenHeading';
import { useCollapsingHeader, CollapsingHeader } from '../../../components/CollapsingHeader';
import { useBackToExit } from '../../../hooks/useBackToExit';
import { useSafeBottomTabBarHeight } from '../../../hooks/useSafeBottomTabBarHeight';
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchMonthlyPlanningScore, type PlanningScoreMonth } from '../../../utils/tripsApi';
import { API_BASE_URL } from '../../../config/api';
import { useTheme, spacing, radius, elevation, iconSize, typography, type AppTheme } from '../../../constants/theme';
import { getLevelData, getLevelName } from '../../../constants/levels';
import { DonutChart, type DonutSlice } from '../../../components/DonutChart';
import { DonutLegend as Legend } from '../../../components/DonutLegend';
import { BarChart, type BarSlice } from '../../../components/BarChart';
import { useLevelStore } from '../../../state/levelStore';
import { useProfileStore, fetchProfileIfStale } from '../../../state/profileStore';
import { useAuthState } from '../../../state/authState';
import { ProfileIdentityHeader } from '../../../components/ProfileIdentityHeader';
import { CreatorStatsCards } from '../../../components/CreatorStatsCards';
import { SkeletonBox } from '../../../components/SkeletonBox';
import { formatEuro } from '../../../utils/formatCurrency';
import { formatMonthKey, formatMonthRange, monthAbbr, parseMonthKey } from '../../../utils/monthNames';
import MonthYearPicker from '../../../components/MonthYearPicker';
import { chainBrandColor, chainIdByName } from '../../../utils/chainBrandName';
import { ChainLogoChip } from '../../../components/ChainLogoChip';
import * as Haptics from 'expo-haptics';
import Constants from 'expo-constants';
import { getUserId, getUserIdMode, setUserIdMode, canSwitchUserId, FIXED_DEV_USER_ID, type UserIdMode } from '../../../config/user';

// True when this app was built with `APP_VARIANT=dev` (EAS `ios-dev`/
// `development` profile). `__DEV__` alone isn't enough: the EAS internal-
// distribution build ships a minified JS bundle without Metro, so
// `__DEV__` is false even though the build is meant for development
// testing. The app name from app.config.js is bundled at build time, so
// it's a reliable runtime tag.
const IS_DEV_BUILD = __DEV__ || Constants.expoConfig?.name === 'Souply (DEV)';

const SCREEN_WIDTH = Dimensions.get('window').width;
// CAROUSEL_WIDTH must account for both the outer ScrollView padding (16 each side)
// and the statsCard padding (20 each side), otherwise overflow: hidden clips the right edge.
const CAROUSEL_WIDTH = SCREEN_WIDTH - 32 - 40;
// Tall enough to fit the category donut + top-10 legend + Kitos row +
// toggle button without clipping. Stores and Monthly pages get the
// same height so the carousel stays a stable size — extra room on
// those pages is fine.
const CHART_PAGE_HEIGHT = 520;

/**
 * Standout CTA at the bottom of Profilis inviting non-creators to make a
 * Kūrėjo paskyra. Hidden once the user is a verified creator (token present)
 * — they get the CreatorProfileRow instead. Deliberately not a plain row:
 * filled brand card + emoji + description so it reads as the primary action.
 */
function CreatorAccountCTA({ styles, router, t }: any) {
    const { useAuthState } = require('../../../state/authState');
    const user = useAuthState((s: any) => s.user);
    if (user) return null;
    return (
        <TouchableOpacity
            style={styles.creatorCta}
            onPress={() => router.push('/profile/creator-auth')}
            activeOpacity={0.85}
        >
            <View style={styles.creatorCtaBadge}>
                <Text style={styles.creatorCtaEmoji}>✨</Text>
            </View>
            <View style={{ flex: 1 }}>
                <Text style={styles.creatorCtaTitle}>{t('profilis.creatorCta.title')}</Text>
                <Text style={styles.creatorCtaDesc}>{t('profilis.creatorCta.desc')}</Text>
            </View>
            <Ionicons name="arrow-forward" size={iconSize.md} color="#fff" />
        </TouchableOpacity>
    );
}

export default function ProfilisScreen() {
    const colors = useTheme();
    const { t, i18n } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const navigation = useNavigation();
    // Collapsing header: "Profilis" title hides on scroll (no pinned filter).
    const header = useCollapsingHeader();
    const tabBarHeight = useSafeBottomTabBarHeight();
    const { backToExitToast } = useBackToExit();

    const triggerIfNewLevel = useLevelStore(s => s.triggerIfNewLevel);

    const profile = useProfileStore(s => s.profile);
    const stats = useProfileStore(s => s.stats);
    const invalidateProfile = useProfileStore(s => s.invalidate);
    const fetchProfile = useProfileStore(s => s.fetchProfile);
    const authUser = useAuthState(s => s.user);
    const loading = useProfileStore(s => s.profile === null && s.fetching);
    const statsLoading = useProfileStore(s => s.stats === null && s.fetching);
    const [activePage, setActivePage] = useState(0);
    const [storeSelected, setStoreSelected] = useState<number | null>(null);
    const [storeMonthOffset, setStoreMonthOffset] = useState(0); // 0 = current month
    const [categorySelected, setCategorySelected] = useState<number | null>(null);
    // Category donut shows top N spending categories; "Žr. daugiau" toggles
    // between 5 and 10. Anything beyond the visible top-N is summed into a
    // single "Kitos" legend row (not drawn on the ring, so one dominant
    // bucket can't swallow 75% of the donut).
    const [categoryTopN, setCategoryTopN] = useState<5 | 10>(5);
    const [categoryMonthOffset, setCategoryMonthOffset] = useState(0); // 0 = current month
    const [monthEndOffset, setMonthEndOffset] = useState(0); // months back from newest that the window END sits
    // Which carousel card's month-picker sheet is open (null = closed).
    const [pickerTarget, setPickerTarget] = useState<null | 'store' | 'category' | 'monthly'>(null);
    const scrollRef = useRef<ComponentRef<typeof Animated.ScrollView>>(null);

    // Per-page measured heights. The carousel wrapper animates to the
    // active page's natural height so the card shrinks when content is
    // short (top 5) and grows when it's tall (top 10).
    const [pageHeights, setPageHeights] = useState<Record<number, number>>({});
    const carouselHeight = useSharedValue(CHART_PAGE_HEIGHT);
    const carouselAnimatedStyle = useAnimatedStyle(() => ({ height: carouselHeight.value }));
    const carouselHasMeasuredRef = useRef(false);

    useEffect(() => {
        if (profile?.level) triggerIfNewLevel(profile.level);
    }, [profile?.level]);

    // Just signed in (authUser went null → set) → snap Profilis back to the top
    // so the now-visible signed-in / creator state is unmistakable after the
    // sign-in screen pops back here.
    const wasAuthedRef = useRef(!!authUser);
    useEffect(() => {
        const isAuthed = !!authUser;
        if (isAuthed && !wasAuthedRef.current) {
            scrollRef.current?.scrollTo({ y: 0, animated: true });
        }
        wasAuthedRef.current = isAuthed;
    }, [authUser]);

    useEffect(() => {
        const target = pageHeights[activePage];
        if (!target || target <= 0) return;
        // First measurement after mount: snap to it instantly so the empty
        // / short-content state doesn't briefly show the fallback 520pt
        // height. Subsequent changes (toggle topN, swipe pages) animate.
        if (!carouselHasMeasuredRef.current) {
            carouselHeight.value = target;
            carouselHasMeasuredRef.current = true;
            return;
        }
        carouselHeight.value = withTiming(target, {
            duration: 280,
            easing: Easing.inOut(Easing.cubic),
        });
    }, [activePage, pageHeights, carouselHeight]);

    // Apply the settings-gear headerRight on focus, and re-apply on the next
    // frame. The native stack header attaches a beat AFTER first mount, so a
    // one-shot mount/layout-effect set the gear before the header existed — it
    // only showed up after a tab switch re-focused the screen. Setting it on
    // focus catches the first focus, and the rAF re-apply lands once the native
    // header is mounted, so the gear is present on first load.
    useFocusEffect(useCallback(() => {
        fetchProfileIfStale();
        const applyGear = () => navigation.setOptions({
            headerRight: () => (
                <GlassIconButton icon="settings-outline" onPress={() => router.push('/settings' as any)} />
            ),
        });
        applyGear();
        const raf = requestAnimationFrame(applyGear);
        return () => cancelAnimationFrame(raf);
    }, [navigation, router]));

    const devItems: { label: string; icon: keyof typeof Ionicons.glyphMap; route: string }[] = [
        { label: t('profilis.devReceiptBatch'), icon: 'flask-outline', route: '/dev/receipt-batch' },
    ];

    const progressPercent = profile ? Math.round(profile.progressFraction * 100) : 0;
    const level = profile?.level ?? 1;
    // "How do I earn points?" explainer for the level card's ? button.
    const [pointsInfoOpen, setPointsInfoOpen] = useState(false);
    // Which skill card's "how does this work?" modal is open.
    const [skillInfo, setSkillInfo] = useState<null | 'saving' | 'planning'>(null);
    // Inbox bell badge — polled on focus (the inbox is the source of truth).
    const [unread, setUnread] = useState(0);
    useFocusEffect(useCallback(() => {
        fetch(`${API_BASE_URL}/api/notifications/unread-count`)
            .then(r => r.json()).then(d => setUnread(Number(d?.unread) || 0)).catch(() => {});
    }, []));
    // Monthly planning score (2.0): current month + Δ vs previous.
    const [planScore, setPlanScore] = useState<PlanningScoreMonth[] | null>(null);
    useFocusEffect(useCallback(() => {
        fetchMonthlyPlanningScore().then(setPlanScore).catch(() => {});
    }, []));

    // Dev/staging test-identity switch: fixed dev UUID ↔ persisted random UUID.
    // The resolved id is memoized + baked into every store, so applying the
    // switch restarts the app (confirmed via the prompt).
    const [idMode, setIdMode] = useState<UserIdMode | null>(null);
    const [activeUserId, setActiveUserId] = useState<string>('');
    useEffect(() => {
        if (!canSwitchUserId) return;
        getUserIdMode().then(setIdMode);
        getUserId().then(setActiveUserId);
    }, []);
    const onToggleUserId = (useFixed: boolean) => {
        Alert.alert(
            t('profilis.testUserRestartTitle'),
            t('profilis.testUserRestartBody', {
                id: useFixed ? FIXED_DEV_USER_ID : t('profilis.testUserRandom'),
            }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('profilis.testUserRestart'),
                    onPress: async () => {
                        await setUserIdMode(useFixed ? 'fixed' : 'random');
                        try {
                            const Updates = await import('expo-updates');
                            await Updates.reloadAsync();
                        } catch {
                            try { DevSettings.reload(); } catch { router.replace('/' as any); }
                        }
                    },
                },
            ],
        );
    };

    // Shared month axis for the per-month donuts (Stores + Categories): the
    // monthlySpending series (earliest→current, zero-filled) so the user can
    // page even to months with no data (empty donut). offset 0 = current (last
    // entry); increasing offset goes older.
    const monthsAxis = (stats?.monthlySpending ?? []).map(m => m.month);
    const monthsMaxOffset = Math.max(0, monthsAxis.length - 1);
    const monthKeyAt = (offset: number): string | null => monthsAxis.length > 0
        ? monthsAxis[monthsAxis.length - 1 - Math.min(offset, monthsMaxOffset)]
        : null;
    const pctOf = (v: number, total: number) =>
        total > 0 ? `${Math.round((v / total) * 100)}%` : '0%';

    // Stores donut — scoped to the selected month; legend shows each store's
    // share of the month total as a percentage.
    const effStoreOffset = Math.min(storeMonthOffset, monthsMaxOffset);
    const storeMonthKey = monthKeyAt(storeMonthOffset);
    const storeMonthSlices: DonutSlice[] = (storeMonthKey ? (stats?.storeBreakdownByMonth?.[storeMonthKey] ?? []) : [])
        .map(s => ({
            label: s.chainName, value: s.total, color: s.color, logoUri: s.miniLogoUrl,
            brandColor: chainBrandColor(s.chainName),
        }));
    const storeMonthTotal = storeMonthSlices.reduce((sum, s) => sum + s.value, 0);
    const storeCanOlder = effStoreOffset < monthsMaxOffset; // older months exist before the current view
    const storeCanNewer = effStoreOffset > 0;               // paged back → can return toward now
    const storeMonthLabel = storeMonthKey ? formatMonthKey(storeMonthKey, i18n.language) : '';
    const formatStorePct = (v: number) => pctOf(v, storeMonthTotal);

    // Categories donut — scoped to the selected month (same axis as Stores).
    // The server sends the FULL per-month list; the client does its own top-N
    // ring + "Kitos" aggregate and shows each category's share as a percentage.
    const effCategoryOffset = Math.min(categoryMonthOffset, monthsMaxOffset);
    const categoryMonthKey = monthKeyAt(categoryMonthOffset);
    const allCategorySlices: DonutSlice[] = (categoryMonthKey ? (stats?.categoryBreakdownByMonth?.[categoryMonthKey] ?? []) : [])
        .map(c => ({ label: c.categoryName, value: c.total, color: c.color }))
        .sort((a, b) => b.value - a.value);
    const categoryMonthTotal = allCategorySlices.reduce((s, c) => s + c.value, 0);
    const categoryCanOlder = effCategoryOffset < monthsMaxOffset;
    const categoryCanNewer = effCategoryOffset > 0;
    const categoryMonthLabel = categoryMonthKey ? formatMonthKey(categoryMonthKey, i18n.language) : '';
    const formatCategoryPct = (v: number) => pctOf(v, categoryMonthTotal);
    const displayCategorySlices = allCategorySlices.slice(0, categoryTopN);
    const hiddenCategorySlices = allCategorySlices.slice(categoryTopN);
    const kitosTotal = hiddenCategorySlices.reduce((s, c) => s + c.value, 0);
    const canToggleCategoryTopN = allCategorySlices.length > 5;
    // Bar labels are derived client-side from the month key (localized: LT
    // "lie", EN "Jul") — the server's label field is Lithuanian-only.
    const barData: BarSlice[] = (stats?.monthlySpending ?? []).map(m => {
        const p = parseMonthKey(m.month);
        return { label: p ? monthAbbr(p[1], i18n.language) : m.label, total: m.total, month: m.month };
    });

    // Monthly chart shows a 6-month window. monthEndOffset = how many months
    // back from the newest the window END sits (0 = ends at the current month).
    // Chevrons page by 6; the picker sets an arbitrary anchor so the chosen
    // month becomes the window's last bar. Series is oldest→newest, zero-filled
    // — navigation is pure client-side windowing, no refetch.
    const MONTH_WINDOW = 6;
    const maxEndOffset = Math.max(0, barData.length - 1);
    const effEndOffset = Math.min(monthEndOffset, maxEndOffset);
    const monthEnd = Math.max(1, barData.length - effEndOffset);
    const monthStart = Math.max(0, monthEnd - MONTH_WINDOW);
    const windowedBars = barData.slice(monthStart, monthEnd);
    const monthlyMax = Math.max(...windowedBars.map(b => b.total), 0);
    const canOlderMonths = monthStart > 0;          // older months exist before the window
    const canNewerMonths = effEndOffset > 0;         // paged back → can return toward now
    const monthRangeLabel = windowedBars.length > 0
        ? formatMonthRange(windowedBars[0].month ?? '', windowedBars[windowedBars.length - 1].month ?? '', i18n.language)
        : '';

    // Month-picker bounds: earliest data month → current month (no future).
    const minMonthKey = monthsAxis[0] ?? null;
    const maxMonthKey = monthsAxis[monthsAxis.length - 1] ?? null;
    const pickerValue = pickerTarget === 'store' ? storeMonthKey
        : pickerTarget === 'category' ? categoryMonthKey
        : pickerTarget === 'monthly' ? (windowedBars[windowedBars.length - 1]?.month ?? maxMonthKey)
        : maxMonthKey;
    const openPicker = (target: 'store' | 'category' | 'monthly') => {
        if (minMonthKey && maxMonthKey) setPickerTarget(target);
    };
    const handleMonthPick = (key: string) => {
        const idx = monthsAxis.indexOf(key);
        if (idx < 0) return;
        const offsetFromEnd = (monthsAxis.length - 1) - idx; // 0 = current month
        if (pickerTarget === 'store') { setStoreMonthOffset(offsetFromEnd); setStoreSelected(null); }
        else if (pickerTarget === 'category') { setCategoryMonthOffset(offsetFromEnd); setCategorySelected(null); }
        else if (pickerTarget === 'monthly') { setMonthEndOffset(offsetFromEnd); }
    };

    // Order: Categories → Monthly → Stores (mirrors the trip stats carousel).
    const storesPage = {
        title: t('profilis.carouselStores'),
        content: (
            <View style={styles.chartPage}>
                <View style={styles.monthNavRow}>
                    <TouchableOpacity
                        onPress={() => { setStoreMonthOffset(o => o + 1); setStoreSelected(null); }}
                        disabled={!storeCanOlder}
                        hitSlop={10}
                        style={styles.monthNavBtn}
                    >
                        <Ionicons name="chevron-back" size={20}
                            color={storeCanOlder ? colors.textPrimary : colors.borderSubtle} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => openPicker('store')} style={styles.monthLabelBtn} hitSlop={8} activeOpacity={0.6}>
                        <Text style={styles.monthRangeLabel}>{storeMonthLabel}</Text>
                        <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
                    </TouchableOpacity>
                    <TouchableOpacity
                        onPress={() => { setStoreMonthOffset(o => Math.max(0, o - 1)); setStoreSelected(null); }}
                        disabled={!storeCanNewer}
                        hitSlop={10}
                        style={styles.monthNavBtn}
                    >
                        <Ionicons name="chevron-forward" size={20}
                            color={storeCanNewer ? colors.textPrimary : colors.borderSubtle} />
                    </TouchableOpacity>
                </View>
                {storeMonthSlices.length > 0 ? (
                    <>
                        <DonutChart
                            data={storeMonthSlices}
                            size={180}
                            thickness={32}
                            emptyColor={colors.borderSubtle}
                            selectedIndex={storeSelected}
                            onSelect={setStoreSelected}
                            cardBackground={colors.cardBackground}
                        />
                        <Legend
                            items={storeMonthSlices.map(s => ({ label: s.label, color: s.color, value: s.value, logoUri: s.logoUri }))}
                            selectedIndex={storeSelected}
                            formatValue={formatStorePct}
                        />
                    </>
                ) : (
                    <Text style={styles.emptyChartText}>{t('profilis.noData')}</Text>
                )}
            </View>
        ),
    };
    const pages = [
        {
            title: t('profilis.carouselCategories'),
            content: (
                <View style={styles.categoryChartPage}>
                    <View style={styles.monthNavRow}>
                        <TouchableOpacity
                            onPress={() => { setCategoryMonthOffset(o => o + 1); setCategorySelected(null); }}
                            disabled={!categoryCanOlder}
                            hitSlop={10}
                            style={styles.monthNavBtn}
                        >
                            <Ionicons name="chevron-back" size={20}
                                color={categoryCanOlder ? colors.textPrimary : colors.borderSubtle} />
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => openPicker('category')} style={styles.monthLabelBtn} hitSlop={8} activeOpacity={0.6}>
                            <Text style={styles.monthRangeLabel}>{categoryMonthLabel}</Text>
                            <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
                        </TouchableOpacity>
                        <TouchableOpacity
                            onPress={() => { setCategoryMonthOffset(o => Math.max(0, o - 1)); setCategorySelected(null); }}
                            disabled={!categoryCanNewer}
                            hitSlop={10}
                            style={styles.monthNavBtn}
                        >
                            <Ionicons name="chevron-forward" size={20}
                                color={categoryCanNewer ? colors.textPrimary : colors.borderSubtle} />
                        </TouchableOpacity>
                    </View>
                    {allCategorySlices.length > 0 ? (
                        <>
                            <DonutChart
                                data={displayCategorySlices}
                                size={180}
                                thickness={32}
                                emptyColor={colors.borderSubtle}
                                selectedIndex={categorySelected}
                                onSelect={setCategorySelected}
                                cardBackground={colors.cardBackground}
                                defaultCenterLabel={t('profilis.topN', { n: categoryTopN })}
                            />
                            <Legend
                                items={displayCategorySlices.map(c => ({ label: c.label, color: c.color, value: c.value }))}
                                selectedIndex={categorySelected}
                                formatValue={formatCategoryPct}
                            />
                            {kitosTotal > 0 && (
                                <Animated.View
                                    style={styles.kitosRow}
                                    entering={FadeIn.duration(280)}
                                    exiting={FadeOut.duration(160)}
                                    layout={LinearTransition.duration(280)}
                                >
                                    <View style={[styles.kitosDot, { backgroundColor: colors.textMuted }]} />
                                    <Text style={[styles.kitosLabel, { color: colors.textSecondary }]} numberOfLines={1}>
                                        {t('profilis.kitosLabel')}
                                    </Text>
                                    <Text style={[styles.kitosAmount, { color: colors.textPrimary }]}>
                                        {formatCategoryPct(kitosTotal)}
                                    </Text>
                                </Animated.View>
                            )}
                            {canToggleCategoryTopN && (
                                <TouchableOpacity
                                    style={styles.kitosToggleBtn}
                                    onPress={() => {
                                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                        setCategoryTopN(prev => (prev === 5 ? 10 : 5));
                                        setCategorySelected(null);
                                    }}
                                    activeOpacity={0.7}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                >
                                    <Text style={[styles.kitosToggleText, { color: colors.primary }]}>
                                        {categoryTopN === 5 ? t('profilis.kitosShowMore') : t('profilis.kitosShowLess')}
                                    </Text>
                                </TouchableOpacity>
                            )}
                        </>
                    ) : (
                        <Text style={styles.emptyChartText}>{t('profilis.noData')}</Text>
                    )}
                </View>
            ),
        },
        {
            title: t('profilis.carouselMonthly'),
            content: (
                <View style={styles.barChartPage}>
                    <View style={styles.monthNavRow}>
                        <TouchableOpacity
                            onPress={() => setMonthEndOffset(o => Math.min(maxEndOffset, o + MONTH_WINDOW))}
                            disabled={!canOlderMonths}
                            hitSlop={10}
                            style={styles.monthNavBtn}
                        >
                            <Ionicons name="chevron-back" size={20}
                                color={canOlderMonths ? colors.textPrimary : colors.borderSubtle} />
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => openPicker('monthly')} style={styles.monthLabelBtn} hitSlop={8} activeOpacity={0.6}>
                            <Text style={styles.monthRangeLabel}>{monthRangeLabel}</Text>
                            <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
                        </TouchableOpacity>
                        <TouchableOpacity
                            onPress={() => setMonthEndOffset(o => Math.max(0, o - MONTH_WINDOW))}
                            disabled={!canNewerMonths}
                            hitSlop={10}
                            style={styles.monthNavBtn}
                        >
                            <Ionicons name="chevron-forward" size={20}
                                color={canNewerMonths ? colors.textPrimary : colors.borderSubtle} />
                        </TouchableOpacity>
                    </View>
                    {monthlyMax > 0 ? (
                        <BarChart data={windowedBars} color={colors.primary} height={220} />
                    ) : (
                        <Text style={styles.emptyChartText}>{t('profilis.noData')}</Text>
                    )}
                </View>
            ),
        },
        storesPage,
    ];

    const settingsGear = (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View>
                <GlassIconButton icon="notifications-outline" onPress={() => { setUnread(0); router.push('/notifications' as any); }} />
                {unread > 0 && (
                    <View style={{
                        position: 'absolute', top: -2, right: -2, minWidth: 16, height: 16,
                        borderRadius: 8, backgroundColor: colors.primary,
                        alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3,
                    }}>
                        <Text style={{ color: colors.onPrimary, fontSize: 9, fontWeight: '700' }}>{unread > 9 ? '9+' : unread}</Text>
                    </View>
                )}
            </View>
            <GlassIconButton icon="settings-outline" onPress={() => router.push('/settings' as any)} />
        </View>
    );

    return (
        <View style={{ flex: 1, backgroundColor: colors.pageBackground }}>
        <CollapsingHeader
            controller={header}
            right={settingsGear}
            smallTitle={t('tabs.profilis')}
        />
        {backToExitToast}
        <Animated.ScrollView
            ref={scrollRef}
            {...header.scroll}
            style={styles.container}
            contentContainerStyle={[styles.content, { paddingTop: 0, paddingBottom: tabBarHeight + 24 }]}
        >
            <ScreenHeading title={t('tabs.profilis')} bleedX={spacing.lg} onLayout={header.onTitleLayout} />
            {/* ONE identity row for every account: avatar + editable name. A
                creator gets their photo and @handle; everyone else gets the pink
                initial circle and "Souplyman" until they name themselves. */}
            {profile && (
                <ProfileIdentityHeader
                    profile={profile}
                    creator={!!authUser}
                    onChanged={() => { invalidateProfile(); fetchProfile(); }}
                />
            )}
            {/* Aggregate template stats — creator accounts only. */}
            {authUser && profile && <CreatorStatsCards profile={profile} />}

            {/* SKILLS ROW — Saving skills (left) + Planning skills (right), side by
                side. Each renders only when it has a figure; a lone card still
                fills the row, so the pair never leaves a hole. */}
            {(() => {
                const saved = stats?.savingsThisMonth ?? 0;
                const lastMonth = stats?.savingsLastMonth ?? 0;
                const showSaving = !statsLoading && saved !== 0;
                const cur = planScore && planScore.length > 0 ? planScore[planScore.length - 1] : null;
                const prev = planScore && planScore.length > 1 ? planScore[planScore.length - 2] : null;
                const showPlanning = cur?.score != null;
                if (!showSaving && !showPlanning) return null;

                const positive = saved > 0;
                const savingDelta = saved - lastMonth;
                const savingDeltaUp = savingDelta >= 0;
                const planDelta = cur?.score != null && prev?.score != null ? cur.score - prev.score : null;
                const planGood = (cur?.score ?? 0) >= 70;

                return (
                    <View style={styles.skillsRow}>
                        {showSaving && (
                            <View style={styles.skillCard}>
                                <View style={styles.skillHead}>
                                    <Ionicons
                                        name={positive ? 'trending-up-outline' : 'trending-down-outline'}
                                        size={18}
                                        color={positive ? colors.success : colors.textSecondary}
                                    />
                                    <Text style={styles.skillLabel} numberOfLines={2}>{t('profilis.savingSkills')}</Text>
                                    <TouchableOpacity
                                        onPress={() => setSkillInfo('saving')}
                                        hitSlop={10}
                                        accessibilityLabel={t('profilis.savingInfoTitle')}
                                    >
                                        <Ionicons name="help-circle-outline" size={18} color={colors.textMuted} />
                                    </TouchableOpacity>
                                </View>
                                <Text style={[styles.skillValue, { color: positive ? colors.success : colors.textPrimary }]} numberOfLines={1}>
                                    {formatEuro(Math.abs(saved))}
                                </Text>
                                {lastMonth !== 0 && (
                                    <View style={styles.skillDeltaRow}>
                                        <View style={styles.savingsChangeChip}>
                                            <Ionicons
                                                name={savingDeltaUp ? 'arrow-up' : 'arrow-down'}
                                                size={12}
                                                color={savingDeltaUp ? colors.success : colors.textSecondary}
                                            />
                                            <Text style={[styles.savingsChangePct, { color: savingDeltaUp ? colors.success : colors.textSecondary }]}>
                                                {formatEuro(Math.abs(savingDelta))}
                                            </Text>
                                        </View>
                                    </View>
                                )}
                            </View>
                        )}
                        {showPlanning && (
                            <View style={styles.skillCard}>
                                <View style={styles.skillHead}>
                                    <Ionicons
                                        name={planGood ? 'ribbon-outline' : 'compass-outline'}
                                        size={18}
                                        color={planGood ? colors.success : colors.textSecondary}
                                    />
                                    <Text style={styles.skillLabel} numberOfLines={2}>{t('profilis.planningSkills')}</Text>
                                    <TouchableOpacity
                                        onPress={() => setSkillInfo('planning')}
                                        hitSlop={10}
                                        accessibilityLabel={t('profilis.planningInfoTitle')}
                                    >
                                        <Ionicons name="help-circle-outline" size={18} color={colors.textMuted} />
                                    </TouchableOpacity>
                                </View>
                                <Text style={[styles.skillValue, { color: planGood ? colors.success : colors.textPrimary }]} numberOfLines={1}>
                                    {cur!.score}/100
                                </Text>
                                {planDelta != null && planDelta !== 0 && (
                                    <View style={styles.skillDeltaRow}>
                                        <View style={styles.savingsChangeChip}>
                                            <Ionicons
                                                name={planDelta > 0 ? 'arrow-up' : 'arrow-down'}
                                                size={12}
                                                color={planDelta > 0 ? colors.success : colors.textSecondary}
                                            />
                                            <Text style={[styles.savingsChangePct, { color: planDelta > 0 ? colors.success : colors.textSecondary }]}>
                                                {Math.abs(planDelta)}
                                            </Text>
                                        </View>
                                    </View>
                                )}
                            </View>
                        )}
                    </View>
                );
            })()}

            {/* Level card */}
            <View style={styles.levelCard}>
                {loading ? (
                    <View style={{ width: '100%', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm }}>
                        <SkeletonBox width={56} height={56} borderRadius={28} />
                        <SkeletonBox width='40%' height={14} borderRadius={7} />
                        <SkeletonBox width='55%' height={12} borderRadius={6} />
                        <SkeletonBox width='100%' height={8} borderRadius={radius.pill} style={{ marginTop: spacing.xs }} />
                        <SkeletonBox width='50%' height={11} borderRadius={6} />
                    </View>
                ) : (
                    <>
                        <TouchableOpacity
                            style={styles.levelHelpBtn}
                            onPress={() => setPointsInfoOpen(true)}
                            hitSlop={10}
                            accessibilityLabel={t('profilis.pointsInfoTitle')}
                        >
                            <Ionicons name="help-circle-outline" size={22} color={colors.textMuted} />
                        </TouchableOpacity>
                        <View style={styles.iconCircle}>
                            <Text style={styles.levelEmoji}>{getLevelData(level).emoji}</Text>
                        </View>
                        <Text style={styles.levelName}>{getLevelName(level, t)}</Text>
                        {/* Uppercase in JS, not textTransform: Android measures the
                            PRE-transform string when letterSpacing is set, then draws
                            wider — "LYGIS 5" overflowed and wrapped onto two lines. */}
                        <Text style={styles.levelLabel} numberOfLines={1}>{t('profilis.levelLabel', { level }).toUpperCase()}</Text>
                        <Text style={styles.points}>{t('profilis.points', { count: profile?.points ?? 0 })}</Text>

                        <View style={styles.progressTrack}>
                            <View style={[styles.progressFill, { width: `${progressPercent}%` }]} />
                        </View>
                        <Text style={styles.progressLabel}>
                            {t('profilis.progressLabel', { current: profile?.pointsIntoLevel ?? 0, target: profile?.pointsNeededForNext ?? 10 })}
                        </Text>
                    </>
                )}
            </View>

            {/* Points explainer — how points are earned, in plain terms. */}
            <Modal visible={pointsInfoOpen} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setPointsInfoOpen(false)}>
                <Pressable style={styles.infoOverlay} onPress={() => setPointsInfoOpen(false)}>
                    <Pressable style={styles.infoCard} onPress={() => {}}>
                        <Text style={styles.infoTitle}>{t('profilis.pointsInfoTitle')}</Text>
                        {(['🧾', '🃏', '➕'] as const).map((icon, i) => (
                            <View key={i} style={styles.infoBulletRow}>
                                <View style={styles.infoBulletLead}><Text style={styles.infoBulletIcon}>{icon}</Text></View>
                                <Text style={styles.infoBulletText}>{t(`profilis.pointsInfoBullet${i + 1}`)}</Text>
                            </View>
                        ))}
                        <TouchableOpacity style={styles.infoButton} onPress={() => setPointsInfoOpen(false)} activeOpacity={0.85}>
                            <Text style={styles.infoButtonText}>{t('common.gotIt')}</Text>
                        </TouchableOpacity>
                    </Pressable>
                </Pressable>
            </Modal>

            {/* How each skill figure is computed — one line per input, so the
                number is never a black box. Replaces the caption that used to
                bleed out of the (now half-width) card. */}
            <Modal visible={skillInfo !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setSkillInfo(null)}>
                <Pressable style={styles.infoOverlay} onPress={() => setSkillInfo(null)}>
                    <Pressable style={styles.infoCard} onPress={() => {}}>
                        <Text style={styles.infoTitle}>
                            {skillInfo === 'planning' ? t('profilis.planningInfoTitle') : t('profilis.savingInfoTitle')}
                        </Text>
                        {(skillInfo === 'planning'
                            ? ['✅', '🛒', '📍', '📅']
                            : ['🧾', '💶', '📅']
                        ).map((icon, i) => (
                            <View key={i} style={styles.infoBulletRow}>
                                <View style={styles.infoBulletLead}><Text style={styles.infoBulletIcon}>{icon}</Text></View>
                                <Text style={styles.infoBulletText}>
                                    {t(`profilis.${skillInfo === 'planning' ? 'planning' : 'saving'}InfoBullet${i + 1}`)}
                                </Text>
                            </View>
                        ))}
                        <TouchableOpacity style={styles.infoButton} onPress={() => setSkillInfo(null)} activeOpacity={0.85}>
                            <Text style={styles.infoButtonText}>{t('common.gotIt')}</Text>
                        </TouchableOpacity>
                    </Pressable>
                </Pressable>
            </Modal>

            {/* Stats carousel */}
            <View style={styles.statsCard}>
                <Text style={styles.sectionTitle}>{t('profilis.statsTitle')}</Text>
                {statsLoading ? (
                    <View style={{ gap: spacing.lg, paddingVertical: spacing.xl, alignItems: 'center' }}>
                        <SkeletonBox width={160} height={160} borderRadius={80} style={{ alignSelf: 'center' }} />
                        <View style={{ width: '100%', gap: spacing.sm }}>
                            <SkeletonBox width='60%' height={12} borderRadius={6} style={{ alignSelf: 'center' }} />
                            <SkeletonBox width='45%' height={12} borderRadius={6} style={{ alignSelf: 'center' }} />
                            <SkeletonBox width='50%' height={12} borderRadius={6} style={{ alignSelf: 'center' }} />
                        </View>
                    </View>
                ) : (
                    <>
                        <View style={styles.carouselTitleRow}>
                            <Text style={styles.carouselTitle}>{pages[activePage].title}</Text>
                        </View>
                        <Animated.ScrollView
                            ref={scrollRef as any}
                            horizontal
                            pagingEnabled
                            showsHorizontalScrollIndicator={false}
                            style={[{ width: CAROUSEL_WIDTH }, carouselAnimatedStyle]}
                            // CRITICAL: alignItems:flex-start prevents the default
                            // `stretch` behaviour, which would otherwise force each
                            // page View to grow to the ScrollView's height. With
                            // stretch on, onLayout reports the ScrollView height
                            // back as each page's height — a feedback loop that
                            // pins the carousel at its initial size and prevents
                            // any per-page sizing from ever working.
                            contentContainerStyle={{ alignItems: 'flex-start' }}
                            onMomentumScrollEnd={e => {
                                const page = Math.round(e.nativeEvent.contentOffset.x / CAROUSEL_WIDTH);
                                setActivePage(page);
                            }}
                        >
                            {pages.map((page, i) => (
                                <View
                                    key={i}
                                    style={{ width: CAROUSEL_WIDTH }}
                                    onLayout={e => {
                                        const h = e.nativeEvent.layout.height;
                                        if (!h) return;
                                        setPageHeights(prev => (prev[i] === h ? prev : { ...prev, [i]: h }));
                                    }}
                                >
                                    {page.content}
                                </View>
                            ))}
                        </Animated.ScrollView>

                        {/* Dot indicators */}
                        <View style={styles.dots}>
                            {pages.map((_, i) => (
                                <View
                                    key={i}
                                    style={[styles.dot, i === activePage && styles.dotActive]}
                                />
                            ))}
                        </View>

                        <Text style={styles.finePrint}>
                            {t('profilis.dataFootnote')}
                        </Text>
                    </>
                )}
            </View>

            {/* Quick links */}
            <View style={{ marginTop: spacing.sm }}>
                {/* Lists and receipts are managed entirely from Apsipirkimai —
                    they had shortcuts here while the 2.0 trip flow was landing. */}
                <TouchableOpacity
                    style={styles.row}
                    onPress={() => router.push('/profile/vote-history')}
                >
                    <Ionicons name="layers-outline" size={iconSize.lg} color={colors.textSecondary} />
                    <Text style={styles.rowText}>{t('profilis.voteHistory')}</Text>
                    <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textMuted} />
                </TouchableOpacity>

                {/* Admin panel entry — only when the server marks this
                    user as admin (isAdmin column). Tapping persists the
                    mode and replaces the root stack with the admin tabs. */}
                {profile?.isAdmin && (
                    <TouchableOpacity
                        style={styles.row}
                        onPress={async () => {
                            const { useAdminModeStore } = await import('../../../state/adminModeStore');
                            await useAdminModeStore.getState().setMode('admin');
                            // No reload: the group layouts carry declarative
                            // mode guards (Redirect), so a plain replace is
                            // clean and BACK cannot leak across groups.
                            router.replace('/(admin)/catalog' as any);
                        }}
                    >
                        <Ionicons name="shield-checkmark-outline" size={iconSize.lg} color={colors.primary} />
                        <Text style={[styles.rowText, { color: colors.primary, fontWeight: '600' }]}>
                            {t('admin.enterButton')}
                        </Text>
                        <Ionicons name="chevron-forward" size={iconSize.md} color={colors.primary} />
                    </TouchableOpacity>
                )}
            </View>

            {/* Dev tools — visible in Metro dev mode AND in the EAS DEV variant.
                EAS-built internal-distribution bundles minify with __DEV__=false.
                The test-identity switch additionally shows on STAGING builds
                (canSwitchUserId) — never in prod. */}
            {(IS_DEV_BUILD || canSwitchUserId) && (
                <View style={{ marginTop: spacing.xl }}>
                    <Text style={styles.sectionTitle}>{t('profilis.devTools')}</Text>
                    {canSwitchUserId && idMode != null && (
                        <View style={styles.row}>
                            <Ionicons name="person-circle-outline" size={iconSize.lg} color={colors.textSecondary} />
                            <View style={{ flex: 1 }}>
                                <Text style={styles.rowText}>{t('profilis.testUser')}</Text>
                                {!!activeUserId && (
                                    <Text style={styles.testUserSub} numberOfLines={1}>
                                        {t('profilis.testUserCurrent', { id: activeUserId })}
                                    </Text>
                                )}
                            </View>
                            <Switch
                                value={idMode === 'fixed'}
                                onValueChange={onToggleUserId}
                                trackColor={{ true: colors.primary, false: colors.borderSubtle }}
                                thumbColor={colors.cardBackground}
                            />
                        </View>
                    )}
                    {IS_DEV_BUILD && devItems.map((item) => (
                        <TouchableOpacity
                            key={item.route}
                            style={styles.row}
                            onPress={() => router.push(item.route as any)}
                        >
                            <Ionicons name={item.icon} size={iconSize.lg} color={colors.textSecondary} />
                            <Text style={styles.rowText}>{item.label}</Text>
                            <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textMuted} />
                        </TouchableOpacity>
                    ))}
                </View>
            )}

            {/* Creator-account CTA — bottom of the profile, non-creators only. */}
            <CreatorAccountCTA styles={styles} router={router} t={t} />
        </Animated.ScrollView>

        {/* Shared month/year picker for all three carousel cards. */}
        {minMonthKey && maxMonthKey && (
            <MonthYearPicker
                visible={pickerTarget !== null}
                value={pickerValue ?? maxMonthKey}
                minKey={minMonthKey}
                maxKey={maxMonthKey}
                onSelect={handleMonthPick}
                onClose={() => setPickerTarget(null)}
            />
        )}
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    content: { padding: spacing.lg, paddingBottom: spacing.xxxl },

    levelCard: {
        backgroundColor: c.cardBackground,
        borderRadius: radius.lg,
        padding: spacing.xl,
        alignItems: 'center',
        marginBottom: spacing.md,
        ...elevation.level1,
    },
    iconCircle: {
        width: 80, height: 80, borderRadius: radius.pill,
        backgroundColor: c.primaryMuted,
        alignItems: 'center', justifyContent: 'center',
        marginBottom: spacing.md,
    },
    levelEmoji: { fontSize: 40, lineHeight: 48 },
    levelHelpBtn: { position: 'absolute', top: spacing.md, right: spacing.md, zIndex: 1 },
    testUserSub: { ...typography.caption, color: c.textMuted, marginTop: 1 },
    infoOverlay: {
        flex: 1,
        backgroundColor: c.overlayBackdrop,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    infoCard: {
        backgroundColor: c.cardBackground,
        borderRadius: radius.xl,
        padding: 24,
        width: '100%',
        maxWidth: 360,
        ...elevation.level3,
    },
    infoTitle: { fontSize: 17, fontWeight: '700', color: c.textPrimary, textAlign: 'center', marginBottom: 16 },
    infoBulletRow: { flexDirection: 'row', gap: 10, marginBottom: 12, alignItems: 'flex-start' },
    infoBulletLead: { minWidth: 36, alignItems: 'center', paddingTop: 1 },
    infoBulletIcon: { fontSize: 17, lineHeight: 21 },
    infoBulletText: { flex: 1, fontSize: 14, lineHeight: 21, color: c.textPrimary },
    infoButton: {
        marginTop: 8,
        backgroundColor: c.primary,
        borderRadius: radius.pill,
        paddingVertical: 12,
        alignItems: 'center',
    },
    infoButtonText: { color: c.onPrimary, fontSize: 15, fontWeight: '600' },
    levelLabel: { ...typography.label, color: c.textMuted, letterSpacing: 1 },
    levelName: { ...typography.priceLarge, fontWeight: '700', color: c.textPrimary, marginTop: 2, marginBottom: spacing.xs },
    points: { ...typography.bodySmall, color: c.textSecondary, marginBottom: spacing.lg },
    progressTrack: {
        width: '100%', height: 8,
        backgroundColor: c.borderSubtle, borderRadius: radius.pill,
        overflow: 'hidden', marginBottom: 6,
    },
    progressFill: { height: '100%', backgroundColor: c.primary, borderRadius: radius.pill },
    progressLabel: { ...typography.labelSmall, fontWeight: '400', color: c.textMuted },

    // Two half-width skill cards sitting side by side. Vertical inside (label →
    // figure → delta) because half the width can't hold the old row layout.
    skillsRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
    skillCard: {
        flex: 1,
        backgroundColor: c.cardBackground,
        borderRadius: radius.lg,
        paddingVertical: spacing.lg,
        paddingHorizontal: spacing.lg,
        gap: 4,
        borderWidth: 1,
        borderColor: c.borderSubtle,
    },
    skillHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    // The label flexes so the ? button pins to the card's right edge.
    skillLabel: { ...typography.label, fontWeight: '500', color: c.textSecondary, flex: 1 },
    skillValue: { ...typography.heading, fontWeight: '700' },
    skillDeltaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    savingsChangeChip: {
        flexDirection: 'row', alignItems: 'center', gap: 2,
        backgroundColor: c.primaryMuted,
        paddingVertical: 3, paddingHorizontal: spacing.sm,
        borderRadius: radius.pill,
    },
    savingsChangePct: { ...typography.labelSmall, fontWeight: '700' },

    statsCard: {
        backgroundColor: c.cardBackground,
        borderRadius: radius.lg,
        padding: spacing.xl,
        marginBottom: spacing.sm,
        overflow: 'hidden',
    },
    sectionTitle: {
        ...typography.label, fontWeight: '700', color: c.textMuted,
        marginBottom: spacing.xs, textTransform: 'uppercase', letterSpacing: 0.5,
    },
    carouselTitleRow: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.lg,
    },
    carouselTitle: {
        ...typography.bodyStrong, color: c.textPrimary, flex: 1,
    },
    // Carousel pages size to their content. The carousel wrapper itself
    // animates its height to match the active page (see carouselAnimatedStyle),
    // so the surrounding card shrinks/grows naturally instead of holding
    // a fixed CHART_PAGE_HEIGHT block.
    chartPage: {
        alignItems: 'center',
        justifyContent: 'flex-start',
        width: '100%',
        paddingBottom: spacing.sm,
    },
    barChartPage: {
        alignSelf: 'stretch',
        paddingBottom: spacing.sm,
    },
    categoryChartPage: {
        alignItems: 'center',
        justifyContent: 'flex-start',
        paddingTop: spacing.xs,
        paddingBottom: spacing.sm,
        width: '100%',
    },
    emptyChartText: { ...typography.bodySmall, color: c.textMuted, fontStyle: 'italic', marginVertical: spacing.xxl, textAlign: 'center' },
    monthNavRow: {
        alignSelf: 'stretch',
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: spacing.xs, marginBottom: spacing.xs,
    },
    monthNavBtn: { padding: 6, borderRadius: radius.sm },
    monthLabelBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    monthRangeLabel: { ...typography.label, fontWeight: '700', color: c.textSecondary },

    dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: spacing.lg, marginBottom: spacing.sm },
    dot: { width: 6, height: 6, borderRadius: radius.pill, backgroundColor: c.borderSubtle },
    dotActive: { backgroundColor: c.primary, width: 16 },

    finePrint: { ...typography.caption, color: c.textMuted, textAlign: 'center', marginTop: spacing.xs },

    row: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        backgroundColor: c.cardBackground,
        paddingVertical: spacing.lg, paddingHorizontal: spacing.lg,
        borderRadius: radius.md, marginBottom: spacing.sm,
    },
    rowText: { flex: 1, ...typography.bodyStrong, fontWeight: '500', color: c.textPrimary },
    creatorCta: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.lg,
        backgroundColor: c.primary,
        paddingVertical: spacing.lg, paddingHorizontal: spacing.lg,
        borderRadius: radius.lg, marginTop: spacing.xl,
        // Coloured brand glow — bespoke, not a neutral elevation tier.
        shadowColor: c.primary, shadowOpacity: 0.35, shadowRadius: 12,
        shadowOffset: { width: 0, height: 6 }, elevation: 4,
    },
    creatorCtaBadge: {
        width: 44, height: 44, borderRadius: radius.md,
        backgroundColor: 'rgba(255,255,255,0.18)',
        alignItems: 'center', justifyContent: 'center',
    },
    creatorCtaEmoji: { fontSize: 22 },
    creatorCtaTitle: { ...typography.bodyStrong, fontWeight: '800', color: '#fff' },
    creatorCtaDesc: { ...typography.labelSmall, fontWeight: '400', color: 'rgba(255,255,255,0.85)', marginTop: 2 },

    // "Kitos" aggregate row — visually identical to a Legend row (dot +
    // label + amount). Shown below the legend, separated by a hairline
    // divider, only when there is spend not represented in the ring.
    kitosRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginTop: spacing.sm,
        paddingTop: 6,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: c.borderSubtle,
    },
    kitosDot: { width: 10, height: 10, borderRadius: radius.pill, flexShrink: 0 },
    kitosLabel: { flex: 1, ...typography.label, fontWeight: '400' },
    kitosAmount: { ...typography.label, flexShrink: 0 },

    // Toggle button at the bottom of the category page that flips top-N
    // between 5 and 10.
    kitosToggleBtn: {
        marginTop: spacing.sm,
        alignSelf: 'center',
        paddingVertical: 6,
        paddingHorizontal: spacing.md,
    },
    kitosToggleText: { ...typography.label },
});
