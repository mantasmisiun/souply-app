import { View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useTheme, type AppTheme } from '../../constants/theme';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { getLevelData } from '../../constants/levels';
import { DonutChart, type DonutSlice } from '../../components/DonutChart';
import { BarChart, type BarSlice } from '../../components/BarChart';

const SCREEN_WIDTH = Dimensions.get('window').width;
// CAROUSEL_WIDTH must account for both the outer ScrollView padding (16 each side)
// and the statsCard padding (20 each side), otherwise overflow: hidden clips the right edge.
const CAROUSEL_WIDTH = SCREEN_WIDTH - 32 - 40;
const CHART_PAGE_HEIGHT = 340; // fixed height keeps all carousel pages the same size

interface ProfileData {
    points: number;
    level: number;
    pointsIntoLevel: number;
    pointsNeededForNext: number;
    progressFraction: number;
    nextLevelAt: number;
    pendingSwipes: boolean;
    showBurstWarning: boolean;
}

interface StoreSlice { chainName: string; total: number; color: string; }
interface CategorySlice { categoryName: string; total: number; color: string; }
interface MonthSlice { month: string; label: string; total: number; }

interface StatsData {
    storeBreakdown: StoreSlice[];
    categoryBreakdown: CategorySlice[];
    monthlySpending: MonthSlice[];
    totalSavings: number;
}

function Legend({
    items,
    selectedIndex,
}: {
    items: Array<{ label: string; color: string; value: number }>;
    selectedIndex?: number | null;
}) {
    const anySelected = selectedIndex !== null && selectedIndex !== undefined;
    return (
        <View style={legendStyles.container}>
            {items.map((item, i) => {
                const dimmed = anySelected && i !== selectedIndex;
                return (
                    <View key={i} style={[legendStyles.row, dimmed && legendStyles.rowDimmed]}>
                        <View style={[legendStyles.dot, { backgroundColor: item.color }]} />
                        <Text style={legendStyles.label} numberOfLines={1}>{item.label}</Text>
                        <Text style={legendStyles.value}>{item.value.toFixed(2)}€</Text>
                    </View>
                );
            })}
        </View>
    );
}
const legendStyles = StyleSheet.create({
    container: { alignSelf: 'stretch', marginTop: 16, gap: 6 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    rowDimmed: { opacity: 0.3 },
    dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
    label: { flex: 1, fontSize: 13, color: '#374151' },
    value: { fontSize: 13, fontWeight: '600', color: '#111827', flexShrink: 0 },
});

export default function ProfilisScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const [profile, setProfile] = useState<ProfileData | null>(null);
    const [stats, setStats] = useState<StatsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [statsLoading, setStatsLoading] = useState(true);
    const [activePage, setActivePage] = useState(0);
    const [storeSelected, setStoreSelected] = useState<number | null>(null);
    const [categorySelected, setCategorySelected] = useState<number | null>(null);
    const scrollRef = useRef<ScrollView>(null);

    useFocusEffect(useCallback(() => {
        let cancelled = false;
        (async () => {
            try {
                const userId = await getUserId();
                const [profileRes, statsRes] = await Promise.all([
                    fetch(`${API_BASE_URL}/api/users/${userId}/profile`),
                    fetch(`${API_BASE_URL}/api/users/${userId}/stats`),
                ]);
                const profileData = await profileRes.json();
                const statsData = await statsRes.json();
                if (!cancelled) {
                    setProfile(profileData);
                    setStats(statsData);
                }
            } catch {
                // keep previous data on network error
            } finally {
                if (!cancelled) {
                    setLoading(false);
                    setStatsLoading(false);
                }
            }
        })();
        return () => { cancelled = true; };
    }, []));

    const devItems: Array<{ label: string; icon: keyof typeof Ionicons.glyphMap; route: string }> = [
        { label: 'Kvitų paketinis testas', icon: 'flask-outline', route: '/dev/receipt-batch' },
        { label: 'Admin', icon: 'shield-outline', route: '/dev/admin' },
    ];

    const progressPercent = profile ? Math.round(profile.progressFraction * 100) : 0;
    const level = profile?.level ?? 1;

    const storeSlices: DonutSlice[] = (stats?.storeBreakdown ?? []).map(s => ({
        label: s.chainName, value: s.total, color: s.color,
    }));
    const categorySlices: DonutSlice[] = (stats?.categoryBreakdown ?? []).map(c => ({
        label: c.categoryName, value: c.total, color: c.color,
    }));
    const barData: BarSlice[] = (stats?.monthlySpending ?? []).map(m => ({
        label: m.label, total: m.total,
    }));

    const monthlyMax = Math.max(...barData.map(b => b.total), 0);

    const pages = [
        {
            title: 'Išlaidos pagal parduotuvę',
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
                        items={storeSlices.map(s => ({ label: s.label, color: s.color, value: s.value }))}
                        selectedIndex={storeSelected}
                    />
                </View>
            ),
        },
        {
            title: 'Išlaidos pagal kategoriją',
            content: (
                <View style={styles.chartPage}>
                    <DonutChart
                        data={categorySlices}
                        size={180}
                        thickness={32}
                        emptyColor={colors.borderSubtle}
                        selectedIndex={categorySelected}
                        onSelect={setCategorySelected}
                        cardBackground={colors.cardBackground}
                    />
                    <Legend
                        items={categorySlices.map(c => ({ label: c.label, color: c.color, value: c.value }))}
                        selectedIndex={categorySelected}
                    />
                </View>
            ),
        },
        {
            title: 'Mėnesinės išlaidos',
            content: (
                <View style={styles.chartPage}>
                    {monthlyMax > 0 ? (
                        <>
                            <BarChart data={barData} color={colors.primary} height={140} />
                            <Text style={styles.barMaxLabel}>Maks. {monthlyMax.toFixed(2)}€</Text>
                        </>
                    ) : (
                        <Text style={styles.emptyChartText}>Duomenų dar nėra</Text>
                    )}
                </View>
            ),
        },
    ];

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
            {/* Level card */}
            <View style={styles.levelCard}>
                {loading ? (
                    <ActivityIndicator color={colors.primary} />
                ) : (
                    <>
                        <View style={styles.iconCircle}>
                            <Text style={styles.levelEmoji}>{getLevelData(level).emoji}</Text>
                        </View>
                        <Text style={styles.levelLabel}>Lygis {level}</Text>
                        <Text style={styles.levelName}>{getLevelData(level).name}</Text>
                        <Text style={styles.points}>{profile?.points ?? 0} taškai</Text>

                        <View style={styles.progressTrack}>
                            <View style={[styles.progressFill, { width: `${progressPercent}%` }]} />
                        </View>
                        <Text style={styles.progressLabel}>
                            {profile?.pointsIntoLevel ?? 0} / {profile?.pointsNeededForNext ?? 10} iki kito lygio
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
                            {(stats?.totalSavings ?? 0) > 0 ? 'Iš viso sutaupėte' : 'Iš viso galėjote sutaupyti'}
                        </Text>
                        <Text style={[styles.savingsAmount, { color: (stats?.totalSavings ?? 0) > 0 ? colors.success : colors.textPrimary }]}>
                            {Math.abs(stats?.totalSavings ?? 0).toFixed(2)}€
                        </Text>
                    </View>
                </View>
            )}

            {/* Stats carousel */}
            <View style={styles.statsCard}>
                <Text style={styles.sectionTitle}>Statistika</Text>
                {statsLoading ? (
                    <ActivityIndicator color={colors.primary} style={{ marginVertical: 40 }} />
                ) : (
                    <>
                        <Text style={styles.carouselTitle}>{pages[activePage].title}</Text>
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
                            Duomenys pagrįsti įkeltais kvitais
                        </Text>
                    </>
                )}
            </View>

            {/* Dev tools — only in dev builds */}
            {__DEV__ && (
                <View style={{ marginTop: 24 }}>
                    <Text style={styles.sectionTitle}>Kūrėjo įrankiai</Text>
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
    carouselTitle: {
        fontSize: 15, fontWeight: '600', color: c.textPrimary,
        marginBottom: 16,
    },
    chartPage: {
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        flex: 1,
    },
    barMaxLabel: { fontSize: 11, color: c.textMuted, marginTop: 4 },
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
});
