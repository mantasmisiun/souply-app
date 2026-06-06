import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Dimensions, Image, Alert } from 'react-native';
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
import { useRouter , useFocusEffect } from 'expo-router';
import { ScreenHeading } from '../../../components/ScreenHeading';
import { useCollapsingHeader, CollapsingHeader } from '../../../components/CollapsingHeader';
import { useSafeBottomTabBarHeight } from '../../../hooks/useSafeBottomTabBarHeight';
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../../constants/theme';
import { getLevelData, getLevelName } from '../../../constants/levels';
import { DonutChart, type DonutSlice } from '../../../components/DonutChart';
import { BarChart, type BarSlice } from '../../../components/BarChart';
import { useLevelStore } from '../../../state/levelStore';
import { useProfileStore, fetchProfileIfStale } from '../../../state/profileStore';
import { useAuthState } from '../../../state/authState';
import CreatorProfileHeader from '../../../components/CreatorProfileHeader';
import { SkeletonBox } from '../../../components/SkeletonBox';
import { formatEuro } from '../../../utils/formatCurrency';
import { chainBrandColor } from '../../../utils/chainBrandName';
import * as Haptics from 'expo-haptics';
import Constants from 'expo-constants';

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

function Legend({
    items,
    selectedIndex,
}: {
    items: { label: string; color: string; value: number; logoUri?: string | null }[];
    selectedIndex?: number | null;
}) {
    const colors = useTheme();
    const anySelected = selectedIndex !== null && selectedIndex !== undefined;
    return (
        <Animated.View style={legendStyles.container} layout={LinearTransition.duration(280)}>
            {items.map((item, i) => {
                const dimmed = anySelected && i !== selectedIndex;
                return (
                    <Animated.View
                        key={item.label}
                        entering={FadeIn.duration(280)}
                        exiting={FadeOut.duration(160)}
                        layout={LinearTransition.duration(280)}
                    >
                        <View style={[legendStyles.row, dimmed && legendStyles.rowDimmed]}>
                            {item.logoUri ? (
                                <View style={[legendStyles.logoTile, { backgroundColor: chainBrandColor(item.label) }]}>
                                    <Image
                                        source={{ uri: item.logoUri }}
                                        style={legendStyles.logo}
                                        resizeMode="contain"
                                    />
                                </View>
                            ) : (
                                <View style={[legendStyles.dot, { backgroundColor: item.color }]} />
                            )}
                            <Text style={[legendStyles.label, { color: colors.textSecondary }]} numberOfLines={1}>{item.label}</Text>
                            <Text style={[legendStyles.value, { color: colors.textPrimary }]}>{formatEuro(item.value)}</Text>
                        </View>
                    </Animated.View>
                );
            })}
        </Animated.View>
    );
}
const legendStyles = StyleSheet.create({
    container: { alignSelf: 'stretch', marginTop: 8, gap: 3 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    rowDimmed: { opacity: 0.3 },
    dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
    logoTile: {
        width: 20, height: 20, borderRadius: 4, flexShrink: 0,
        alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    },
    logo: { width: 14, height: 14 },
    label: { flex: 1, fontSize: 13 },
    value: { fontSize: 13, fontWeight: '600', flexShrink: 0 },
});

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
            <Ionicons name="arrow-forward" size={20} color="#fff" />
        </TouchableOpacity>
    );
}

export default function ProfilisScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    // Collapsing header: "Profilis" title hides on scroll (no pinned filter).
    const header = useCollapsingHeader();
    const tabBarHeight = useSafeBottomTabBarHeight();
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
    const [categorySelected, setCategorySelected] = useState<number | null>(null);
    // Category donut shows top N spending categories; "Žr. daugiau" toggles
    // between 5 and 10. Anything beyond the visible top-N is summed into a
    // single "Kitos" legend row (not drawn on the ring, so one dominant
    // bucket can't swallow 75% of the donut).
    const [categoryTopN, setCategoryTopN] = useState<5 | 10>(5);
    const [monthOffset, setMonthOffset] = useState(0); // 0 = most recent 6-month window
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

    useFocusEffect(useCallback(() => {
        fetchProfileIfStale();
    }, []));

    const devItems: { label: string; icon: keyof typeof Ionicons.glyphMap; route: string }[] = [
        { label: t('profilis.devReceiptBatch'), icon: 'flask-outline', route: '/dev/receipt-batch' },
        { label: 'Admin', icon: 'shield-outline', route: '/dev/admin' },
    ];

    const progressPercent = profile ? Math.round(profile.progressFraction * 100) : 0;
    const level = profile?.level ?? 1;

    const storeSlices: DonutSlice[] = (stats?.storeBreakdown ?? []).map(s => ({
        label: s.chainName, value: s.total, color: s.color, logoUri: s.miniLogoUrl,
        brandColor: chainBrandColor(s.chainName),
    }));
    // Server returns categoryBreakdown already truncated with a synthetic
    // "Kitos" aggregate as the last item; the full per-category split lives
    // in kitaBreakdown. Reconstruct the full list, sort by spend, then take
    // top N for the ring. Anything not in the ring is summed for the legend.
    const rawCategoryBreakdown = stats?.categoryBreakdown ?? [];
    const rawKitaBreakdown = stats?.kitaBreakdown ?? [];
    const realCategories = rawKitaBreakdown.length > 0
        ? rawCategoryBreakdown.slice(0, -1)
        : rawCategoryBreakdown;
    const allCategorySlices: DonutSlice[] = [...realCategories, ...rawKitaBreakdown]
        .map(c => ({ label: c.categoryName, value: c.total, color: c.color }))
        .sort((a, b) => b.value - a.value);
    const displayCategorySlices = allCategorySlices.slice(0, categoryTopN);
    const hiddenCategorySlices = allCategorySlices.slice(categoryTopN);
    const kitosTotal = hiddenCategorySlices.reduce((s, c) => s + c.value, 0);
    const canToggleCategoryTopN = allCategorySlices.length > 5;
    const barData: BarSlice[] = (stats?.monthlySpending ?? []).map(m => ({
        label: m.label, total: m.total, month: m.month,
    }));

    // Monthly chart shows a 6-month window; monthOffset pages back 6 at a time
    // (0 = most recent). The API returns the full series (oldest→newest,
    // zero-filled) so navigation is pure client-side windowing — no refetch.
    const MONTH_WINDOW = 6;
    const maxMonthOffset = Math.max(0, Math.ceil(barData.length / MONTH_WINDOW) - 1);
    const effMonthOffset = Math.min(monthOffset, maxMonthOffset);
    const monthEnd = Math.max(0, barData.length - MONTH_WINDOW * effMonthOffset);
    const monthStart = Math.max(0, monthEnd - MONTH_WINDOW);
    const windowedBars = barData.slice(monthStart, monthEnd);
    const monthlyMax = Math.max(...windowedBars.map(b => b.total), 0);
    const canOlderMonths = monthStart > 0;          // older months exist before the window
    const canNewerMonths = effMonthOffset > 0;       // paged back → can return toward now
    const monthRangeLabel = (() => {
        if (windowedBars.length === 0) return '';
        const first = windowedBars[0];
        const last = windowedBars[windowedBars.length - 1];
        const y1 = first.month?.slice(0, 4);
        const y2 = last.month?.slice(0, 4);
        return y1 === y2
            ? `${first.label}–${last.label} ${y2}`
            : `${first.label} ${y1} – ${last.label} ${y2}`;
    })();

    const pages = [
        {
            title: t('profilis.carouselStores'),
            content: (
                <View style={styles.chartPage}>
                    <DonutChart
                        data={storeSlices}
                        size={180}
                        thickness={32}
                        emptyColor={colors.borderSubtle}
                        selectedIndex={storeSelected}
                        onSelect={setStoreSelected}
                        cardBackground={colors.cardBackground}
                    />
                    <Legend
                        items={storeSlices.map(s => ({ label: s.label, color: s.color, value: s.value, logoUri: s.logoUri }))}
                        selectedIndex={storeSelected}
                    />
                </View>
            ),
        },
        {
            title: t('profilis.carouselCategories'),
            content: (
                <View style={styles.categoryChartPage}>
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
                                {formatEuro(kitosTotal)}
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
                </View>
            ),
        },
        {
            title: t('profilis.carouselMonthly'),
            content: (
                <View style={styles.barChartPage}>
                    <View style={styles.monthNavRow}>
                        <TouchableOpacity
                            onPress={() => setMonthOffset(o => o + 1)}
                            disabled={!canOlderMonths}
                            hitSlop={10}
                            style={styles.monthNavBtn}
                        >
                            <Ionicons name="chevron-back" size={20}
                                color={canOlderMonths ? colors.textPrimary : colors.borderSubtle} />
                        </TouchableOpacity>
                        <Text style={styles.monthRangeLabel}>{monthRangeLabel}</Text>
                        <TouchableOpacity
                            onPress={() => setMonthOffset(o => Math.max(0, o - 1))}
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
    ];

    const settingsGear = (
        <GlassIconButton icon="settings-outline" onPress={() => router.push('/settings' as any)} />
    );

    return (
        <View style={{ flex: 1, backgroundColor: colors.pageBackground }}>
        <CollapsingHeader
            controller={header}
            background={colors.cardBackground}
            right={settingsGear}
            collapsing={<ScreenHeading title={t('tabs.profilis')} />}
        />
        <Animated.ScrollView
            ref={scrollRef}
            {...header.scroll}
            style={styles.container}
            contentContainerStyle={[styles.content, { paddingTop: header.paddingTop + 16, paddingBottom: tabBarHeight + 24 }]}
        >
            {/* Creator header — avatar (tap to upload) + name + @handle +
                aggregate template stats. Only once signed in as a creator. */}
            {authUser && profile && (
                <CreatorProfileHeader
                    profile={profile}
                    onAvatarChanged={() => { invalidateProfile(); fetchProfile(); }}
                />
            )}

            {/* Level card */}
            <View style={styles.levelCard}>
                {loading ? (
                    <View style={{ width: '100%', alignItems: 'center', gap: 12, paddingVertical: 8 }}>
                        <SkeletonBox width={56} height={56} borderRadius={28} />
                        <SkeletonBox width='40%' height={14} borderRadius={7} />
                        <SkeletonBox width='55%' height={12} borderRadius={6} />
                        <SkeletonBox width='100%' height={8} borderRadius={4} style={{ marginTop: 4 }} />
                        <SkeletonBox width='50%' height={11} borderRadius={6} />
                    </View>
                ) : (
                    <>
                        <View style={styles.iconCircle}>
                            <Text style={styles.levelEmoji}>{getLevelData(level).emoji}</Text>
                        </View>
                        <Text style={styles.levelLabel}>{t('profilis.levelLabel', { level })}</Text>
                        <Text style={styles.levelName}>{getLevelName(level, t)}</Text>
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

            {/* Savings card — only shown when there is a non-zero figure */}
            {!statsLoading && (stats?.totalSavings ?? 0) !== 0 && (
                <View style={styles.savingsCard}>
                    <Ionicons
                        name={(stats?.totalSavings ?? 0) > 0 ? 'trending-up-outline' : 'trending-down-outline'}
                        size={22}
                        color={(stats?.totalSavings ?? 0) > 0 ? colors.success : colors.textSecondary}
                        style={{ marginRight: 12 }}
                    />
                    <View style={{ flex: 1 }}>
                        <Text style={styles.savingsLabel}>
                            {(stats?.totalSavings ?? 0) > 0 ? t('profilis.savedTotal') : t('profilis.couldHaveSavedTotal')}
                        </Text>
                        <Text style={[styles.savingsAmount, { color: (stats?.totalSavings ?? 0) > 0 ? colors.success : colors.textPrimary }]}>
                            {formatEuro(Math.abs(stats?.totalSavings ?? 0))}
                        </Text>
                    </View>
                </View>
            )}

            {/* Stats carousel */}
            <View style={styles.statsCard}>
                <Text style={styles.sectionTitle}>{t('profilis.statsTitle')}</Text>
                {statsLoading ? (
                    <View style={{ gap: 16, paddingVertical: 24, alignItems: 'center' }}>
                        <SkeletonBox width={160} height={160} borderRadius={80} style={{ alignSelf: 'center' }} />
                        <View style={{ width: '100%', gap: 8 }}>
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
            <View style={{ marginTop: 8 }}>
                <TouchableOpacity
                    style={styles.row}
                    onPress={() => router.push('/profile/vote-history')}
                >
                    <Ionicons name="layers-outline" size={22} color={colors.textSecondary} />
                    <Text style={styles.rowText}>{t('profilis.voteHistory')}</Text>
                    <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
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
                            // Full reload — cross-group navigation
                            // doesn't always cleanly tear down the
                            // (tabs) navigator. Boot effect reads
                            // 'admin' from AsyncStorage and routes to
                            // the admin panel. Same pattern as the
                            // inverse switch in (admin)/menu.tsx.
                            try {
                                const Updates = await import('expo-updates');
                                await Updates.reloadAsync();
                            } catch {
                                router.replace('/' as any);
                            }
                        }}
                    >
                        <Ionicons name="shield-checkmark-outline" size={22} color={colors.primary} />
                        <Text style={[styles.rowText, { color: colors.primary, fontWeight: '600' }]}>
                            {t('admin.enterButton')}
                        </Text>
                        <Ionicons name="chevron-forward" size={18} color={colors.primary} />
                    </TouchableOpacity>
                )}
            </View>

            {/* Dev tools — visible in Metro dev mode AND in the EAS DEV variant.
                EAS-built internal-distribution bundles minify with __DEV__=false. */}
            {IS_DEV_BUILD && (
                <View style={{ marginTop: 24 }}>
                    <Text style={styles.sectionTitle}>{t('profilis.devTools')}</Text>
                    {devItems.map((item) => (
                        <TouchableOpacity
                            key={item.route}
                            style={styles.row}
                            onPress={() => router.push(item.route as any)}
                        >
                            <Ionicons name={item.icon} size={22} color={colors.textSecondary} />
                            <Text style={styles.rowText}>{item.label}</Text>
                            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                        </TouchableOpacity>
                    ))}
                </View>
            )}

            {/* Creator-account CTA — bottom of the profile, non-creators only. */}
            <CreatorAccountCTA styles={styles} router={router} t={t} />
        </Animated.ScrollView>

        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    content: { padding: 16, paddingBottom: 40 },

    levelCard: {
        backgroundColor: c.cardBackground,
        borderRadius: 16,
        padding: 24,
        alignItems: 'center',
        marginBottom: 12,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 4,
        elevation: 2,
    },
    iconCircle: {
        width: 80,
        height: 80,
        borderRadius: 40,
        backgroundColor: c.primaryMuted,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 12,
    },
    levelEmoji: { fontSize: 40, lineHeight: 48 },
    levelLabel: { fontSize: 13, color: c.textMuted, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1 },
    levelName: { fontSize: 22, fontWeight: '700', color: c.textPrimary, marginTop: 2, marginBottom: 4 },
    points: { fontSize: 14, color: c.textSecondary, marginBottom: 16 },
    progressTrack: {
        width: '100%', height: 8,
        backgroundColor: c.borderSubtle, borderRadius: 4,
        overflow: 'hidden', marginBottom: 6,
    },
    progressFill: { height: '100%', backgroundColor: c.primary, borderRadius: 4 },
    progressLabel: { fontSize: 12, color: c.textMuted },

    savingsCard: {
        backgroundColor: c.cardBackground,
        borderRadius: 16,
        paddingVertical: 16,
        paddingHorizontal: 20,
        marginBottom: 12,
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: c.borderSubtle,
    },
    savingsLabel: { fontSize: 13, color: c.textSecondary, fontWeight: '500', marginBottom: 2 },
    savingsAmount: { fontSize: 20, fontWeight: '700' },

    statsCard: {
        backgroundColor: c.cardBackground,
        borderRadius: 16,
        padding: 20,
        marginBottom: 8,
        overflow: 'hidden',
    },
    sectionTitle: {
        fontSize: 13, fontWeight: '700', color: c.textMuted,
        marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5,
    },
    carouselTitleRow: {
        flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 16,
    },
    carouselTitle: {
        fontSize: 15, fontWeight: '600', color: c.textPrimary, flex: 1,
    },
    // Carousel pages size to their content. The carousel wrapper itself
    // animates its height to match the active page (see carouselAnimatedStyle),
    // so the surrounding card shrinks/grows naturally instead of holding
    // a fixed CHART_PAGE_HEIGHT block.
    chartPage: {
        alignItems: 'center',
        justifyContent: 'flex-start',
        width: '100%',
        paddingBottom: 8,
    },
    barChartPage: {
        alignSelf: 'stretch',
        paddingBottom: 8,
    },
    categoryChartPage: {
        alignItems: 'center',
        justifyContent: 'flex-start',
        paddingTop: 4,
        paddingBottom: 8,
        width: '100%',
    },
    emptyChartText: { fontSize: 14, color: c.textMuted, fontStyle: 'italic', marginVertical: 32, textAlign: 'center' },
    monthNavRow: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: 4, marginBottom: 4,
    },
    monthNavBtn: { padding: 6, borderRadius: 8 },
    monthRangeLabel: { fontSize: 13, fontWeight: '700', color: c.textSecondary },

    dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 16, marginBottom: 8 },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.borderSubtle },
    dotActive: { backgroundColor: c.primary, width: 16 },

    finePrint: { fontSize: 11, color: c.textMuted, textAlign: 'center', marginTop: 4 },

    row: {
        flexDirection: 'row', alignItems: 'center', gap: 12,
        backgroundColor: c.cardBackground,
        paddingVertical: 14, paddingHorizontal: 16,
        borderRadius: 10, marginBottom: 8,
    },
    rowText: { flex: 1, fontSize: 15, color: c.textPrimary, fontWeight: '500' },
    creatorCta: {
        flexDirection: 'row', alignItems: 'center', gap: 14,
        backgroundColor: c.primary,
        paddingVertical: 16, paddingHorizontal: 16,
        borderRadius: 18, marginTop: 24,
        shadowColor: c.primary, shadowOpacity: 0.35, shadowRadius: 12,
        shadowOffset: { width: 0, height: 6 }, elevation: 4,
    },
    creatorCtaBadge: {
        width: 44, height: 44, borderRadius: 14,
        backgroundColor: 'rgba(255,255,255,0.18)',
        alignItems: 'center', justifyContent: 'center',
    },
    creatorCtaEmoji: { fontSize: 22 },
    creatorCtaTitle: { fontSize: 16, fontWeight: '800', color: '#fff' },
    creatorCtaDesc: { fontSize: 12.5, color: 'rgba(255,255,255,0.85)', marginTop: 2 },

    // "Kitos" aggregate row — visually identical to a Legend row (dot +
    // label + amount). Shown below the legend, separated by a hairline
    // divider, only when there is spend not represented in the ring.
    kitosRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginTop: 8,
        paddingTop: 6,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: c.borderSubtle,
    },
    kitosDot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
    kitosLabel: { flex: 1, fontSize: 13 },
    kitosAmount: { fontSize: 13, fontWeight: '600', flexShrink: 0 },

    // Toggle button at the bottom of the category page that flips top-N
    // between 5 and 10.
    kitosToggleBtn: {
        marginTop: 10,
        alignSelf: 'center',
        paddingVertical: 6,
        paddingHorizontal: 12,
    },
    kitosToggleText: { fontSize: 13, fontWeight: '600' },
});
