import { View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, Dimensions, Image, Animated, Easing, Platform } from 'react-native';
import { IOSTabHeader } from '../../components/IOSTabHeader';
import { useRouter, useNavigation } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../constants/theme';
import { getLevelData, getLevelName } from '../../constants/levels';
import { DonutChart, type DonutSlice } from '../../components/DonutChart';
import { BarChart, type BarSlice } from '../../components/BarChart';
import { useLevelStore } from '../../state/levelStore';
import { useProfileStore, fetchProfileIfStale } from '../../state/profileStore';
import { SkeletonBox } from '../../components/SkeletonBox';
import { formatEuro } from '../../utils/formatCurrency';
import * as Haptics from 'expo-haptics';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModal, BottomSheetModalProvider, BottomSheetFlatList, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
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
const CHART_PAGE_HEIGHT = 340; // fixed height keeps all carousel pages the same size

import type { ProfileData, StatsData } from '../../state/profileStore';

function Legend({
    items,
    selectedIndex,
}: {
    items: Array<{ label: string; color: string; value: number; logoUri?: string | null }>;
    selectedIndex?: number | null;
}) {
    const anySelected = selectedIndex !== null && selectedIndex !== undefined;
    return (
        <View style={legendStyles.container}>
            {items.map((item, i) => {
                const dimmed = anySelected && i !== selectedIndex;
                return (
                    <View key={i} style={[legendStyles.row, dimmed && legendStyles.rowDimmed]}>
                        {item.logoUri ? (
                            <Image
                                source={{ uri: item.logoUri }}
                                style={legendStyles.logo}
                                resizeMode="contain"
                            />
                        ) : (
                            <View style={[legendStyles.dot, { backgroundColor: item.color }]} />
                        )}
                        <Text style={legendStyles.label} numberOfLines={1}>{item.label}</Text>
                        <Text style={legendStyles.value}>{formatEuro(item.value)}</Text>
                    </View>
                );
            })}
        </View>
    );
}
const legendStyles = StyleSheet.create({
    container: { alignSelf: 'stretch', marginTop: 8, gap: 3 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    rowDimmed: { opacity: 0.3 },
    dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
    logo: { width: 20, height: 20, borderRadius: 4, flexShrink: 0 },
    label: { flex: 1, fontSize: 13, color: '#374151' },
    value: { fontSize: 13, fontWeight: '600', color: '#111827', flexShrink: 0 },
});

export default function ProfilisScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const navigation = useNavigation();
    const triggerIfNewLevel = useLevelStore(s => s.triggerIfNewLevel);

    // Settings gear lives in the JS Tabs header on Android (via
    // navigation.setOptions) and in IOSTabHeader.rightAction on iOS —
    // NativeTabs renders no header, so the gear would otherwise be
    // unreachable.
    useLayoutEffect(() => {
        if (Platform.OS === 'ios') return;
        navigation.setOptions({
            headerRight: () => (
                <TouchableOpacity
                    onPress={() => router.push('/settings' as any)}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    style={{ paddingHorizontal: 16 }}
                >
                    <Ionicons name="settings-outline" size={22} color={colors.textPrimary} />
                </TouchableOpacity>
            ),
        });
    }, [navigation, router, colors.textPrimary]);
    const profile = useProfileStore(s => s.profile);
    const stats = useProfileStore(s => s.stats);
    const loading = useProfileStore(s => s.profile === null && s.fetching);
    const statsLoading = useProfileStore(s => s.stats === null && s.fetching);
    const [activePage, setActivePage] = useState(0);
    const [storeSelected, setStoreSelected] = useState<number | null>(null);
    const [categorySelected, setCategorySelected] = useState<number | null>(null);
    const [showKita, setShowKita] = useState(false);
    const scrollRef = useRef<ScrollView>(null);
    const donutAnim = useRef(new Animated.Value(1)).current;
    const kitaSheetRef = useRef<BottomSheetModal>(null);
    const renderBackdrop = useCallback(
        (props: any) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />,
        [],
    );

    function transitionToKita() {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        Animated.timing(donutAnim, {
            toValue: 0, duration: 220,
            easing: Easing.in(Easing.ease),
            useNativeDriver: true,
        }).start(() => {
            setShowKita(true);
            setCategorySelected(null);
            // One frame delay lets React flush the new data before fading in,
            // preventing the old chart from briefly reappearing at partial opacity.
            setTimeout(() => {
                Animated.timing(donutAnim, {
                    toValue: 1, duration: 300,
                    easing: Easing.out(Easing.ease),
                    useNativeDriver: true,
                }).start();
            }, 16);
        });
    }

    function transitionFromKita() {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        Animated.timing(donutAnim, {
            toValue: 0, duration: 220,
            easing: Easing.in(Easing.ease),
            useNativeDriver: true,
        }).start(() => {
            setShowKita(false);
            setCategorySelected(null);
            setTimeout(() => {
                Animated.timing(donutAnim, {
                    toValue: 1, duration: 300,
                    easing: Easing.out(Easing.ease),
                    useNativeDriver: true,
                }).start();
            }, 16);
        });
    }

    useEffect(() => {
        if (profile?.level) triggerIfNewLevel(profile.level);
    }, [profile?.level]);

    useFocusEffect(useCallback(() => {
        fetchProfileIfStale();
    }, []));

    const devItems: Array<{ label: string; icon: keyof typeof Ionicons.glyphMap; route: string }> = [
        { label: t('profilis.devReceiptBatch'), icon: 'flask-outline', route: '/dev/receipt-batch' },
        { label: 'Admin', icon: 'shield-outline', route: '/dev/admin' },
    ];

    const progressPercent = profile ? Math.round(profile.progressFraction * 100) : 0;
    const level = profile?.level ?? 1;

    const storeSlices: DonutSlice[] = (stats?.storeBreakdown ?? []).map(s => ({
        label: s.chainName, value: s.total, color: s.color, logoUri: s.miniLogoUrl,
    }));
    const categorySlices: DonutSlice[] = (stats?.categoryBreakdown ?? []).map(c => ({
        label: c.categoryName, value: c.total, color: c.color,
    }));
    const kitaSlices: DonutSlice[] = (stats?.kitaBreakdown ?? []).map(c => ({
        label: c.categoryName, value: c.total, color: c.color,
    }));
    const KITA_DISPLAY_LIMIT = 6;
    const kitaDisplaySlices = kitaSlices.slice(0, KITA_DISPLAY_LIMIT);
    const barData: BarSlice[] = (stats?.monthlySpending ?? []).map(m => ({
        label: m.label, total: m.total, month: m.month,
    }));

    const monthlyMax = Math.max(...barData.map(b => b.total), 0);

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
            title: showKita ? t('profilis.carouselKita') : t('profilis.carouselCategories'),
            content: (
                <Animated.View
                    style={[styles.categoryChartPage, { opacity: donutAnim }]}
                    renderToHardwareTextureAndroid
                    shouldRasterizeIOS
                >
                    <DonutChart
                        data={showKita ? kitaDisplaySlices : categorySlices}
                        size={180}
                        thickness={32}
                        emptyColor={colors.borderSubtle}
                        selectedIndex={categorySelected}
                        onSelect={(idx) => {
                            if (!showKita && idx !== null && kitaSlices.length > 0 && idx === categorySlices.length - 1) {
                                transitionToKita();
                            } else {
                                setCategorySelected(idx);
                            }
                        }}
                        cardBackground={colors.cardBackground}
                    />
                    <Legend
                        items={(showKita ? kitaDisplaySlices : categorySlices).map(c => ({ label: c.label, color: c.color, value: c.value }))}
                        selectedIndex={categorySelected}
                    />
                    {showKita && kitaSlices.length > KITA_DISPLAY_LIMIT && (
                        <TouchableOpacity
                            style={styles.showAllBtn}
                            onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); kitaSheetRef.current?.present(); }}
                        >
                            <Text style={[styles.showAllBtnText, { color: colors.primary }]}>
                                {t('profilis.kitaShowAll', { count: kitaSlices.length })}
                            </Text>
                            <Ionicons name="chevron-forward" size={13} color={colors.primary} />
                        </TouchableOpacity>
                    )}
                </Animated.View>
            ),
        },
        {
            title: t('profilis.carouselMonthly'),
            content: (
                <View style={styles.barChartPage}>
                    {monthlyMax > 0 ? (
                        <BarChart data={barData} color={colors.primary} height={140} />
                    ) : (
                        <Text style={styles.emptyChartText}>{t('profilis.noData')}</Text>
                    )}
                </View>
            ),
        },
    ];

    const kitaTotal = kitaSlices.reduce((s, c) => s + c.value, 0);

    const settingsGear = (
        <TouchableOpacity
            onPress={() => router.push('/settings' as any)}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
            <Ionicons name="settings-outline" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
    );

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
        <BottomSheetModalProvider>
        <View style={{ flex: 1, backgroundColor: colors.pageBackground }}>
        <IOSTabHeader title={t('tabs.profilis')} rightAction={settingsGear} />
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
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
                            {activePage === 1 && showKita && (
                                <TouchableOpacity
                                    onPress={transitionFromKita}
                                    style={styles.backBtn}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                >
                                    <Ionicons name="chevron-back" size={16} color={colors.primary} />
                                </TouchableOpacity>
                            )}
                            <Text style={styles.carouselTitle}>{pages[activePage].title}</Text>
                        </View>
                        <ScrollView
                            ref={scrollRef}
                            horizontal
                            pagingEnabled
                            showsHorizontalScrollIndicator={false}
                            style={{ width: CAROUSEL_WIDTH, height: CHART_PAGE_HEIGHT }}
                            onMomentumScrollEnd={e => {
                                const page = Math.round(e.nativeEvent.contentOffset.x / CAROUSEL_WIDTH);
                                setActivePage(page);
                            }}
                        >
                            {pages.map((page, i) => (
                                <View key={i} style={{ width: CAROUSEL_WIDTH, height: CHART_PAGE_HEIGHT }}>
                                    {page.content}
                                </View>
                            ))}
                        </ScrollView>

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
                            const { useAdminModeStore } = await import('../../state/adminModeStore');
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
        </ScrollView>

        <BottomSheetModal
            ref={kitaSheetRef}
            snapPoints={['55%', '85%']}
            backdropComponent={renderBackdrop}
            backgroundStyle={{ backgroundColor: colors.cardBackground }}
            handleIndicatorStyle={{ backgroundColor: colors.textMuted }}
        >
            <BottomSheetFlatList
                data={kitaSlices}
                keyExtractor={(_, i) => i.toString()}
                contentContainerStyle={styles.sheetList}
                ListHeaderComponent={
                    <View style={styles.sheetHeader}>
                        <Text style={styles.sheetTitle}>{t('profilis.carouselKita')}</Text>
                        <Text style={styles.sheetSubtitle}>{t('profilis.kitaTotal', { total: formatEuro(kitaTotal) })}</Text>
                    </View>
                }
                renderItem={({ item, index }) => (
                    <View style={styles.sheetRow}>
                        <View style={[styles.sheetDot, { backgroundColor: item.color }]} />
                        <Text style={styles.sheetLabel} numberOfLines={1}>{item.label}</Text>
                        <Text style={styles.sheetAmount}>{formatEuro(item.value)}</Text>
                        <Text style={styles.sheetPct}>
                            {kitaTotal > 0 ? `${Math.round((item.value / kitaTotal) * 100)}%` : ''}
                        </Text>
                    </View>
                )}
            />
        </BottomSheetModal>

        </View>
        </BottomSheetModalProvider>
        </GestureHandlerRootView>
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
    chartPage: {
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        flex: 1,
    },
    barChartPage: {
        alignSelf: 'stretch',
        flex: 1,
    },
    categoryChartPage: {
        alignItems: 'center',
        justifyContent: 'flex-start',
        paddingTop: 4,
        width: '100%',
        flex: 1,
    },
    backBtn: { alignItems: 'center', justifyContent: 'center' },
    emptyChartText: { fontSize: 14, color: c.textMuted, fontStyle: 'italic', marginVertical: 32, textAlign: 'center' },

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

    showAllBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 3, marginTop: 10,
    },
    showAllBtnText: { fontSize: 13, fontWeight: '500' },

    sheetList: { paddingHorizontal: 20, paddingBottom: 40 },
    sheetHeader: { paddingTop: 4, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: c.borderSubtle, marginBottom: 8 },
    sheetTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary, marginBottom: 2 },
    sheetSubtitle: { fontSize: 13, color: c.textSecondary },
    sheetRow: {
        flexDirection: 'row', alignItems: 'center', gap: 10,
        paddingVertical: 11,
        borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderSubtle,
    },
    sheetDot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
    sheetLabel: { flex: 1, fontSize: 14, color: c.textPrimary },
    sheetAmount: { fontSize: 14, fontWeight: '600', color: c.textPrimary, flexShrink: 0 },
    sheetPct: { fontSize: 12, color: c.textMuted, width: 32, textAlign: 'right', flexShrink: 0 },
});
