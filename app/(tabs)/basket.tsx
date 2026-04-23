import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { useMemo, useRef, useState, useCallback } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { useBasketState } from '../../state/basketState';
import { useTheme, type AppTheme } from '../../constants/theme';

interface Basket {
    id: number;
    userId: string;
    status: string;
    name: string | null;
    createdAt: string;
    updatedAt: string;
    itemCount: number;
}

const INITIAL_PAGE_SIZE = 10;
const PAGE_INCREMENT = 10;

export default function BasketScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [baskets, setBaskets] = useState<Basket[]>([]);
    // `loading` = full-screen spinner on FIRST mount only.
    // `refreshing` = small header pill shown on subsequent focus refetches
    // so the list doesn't blank out every time the tab regains focus.
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [visibleCount, setVisibleCount] = useState(INITIAL_PAGE_SIZE);
    const hasFetchedRef = useRef(false);
    const router = useRouter();
    const { setDraftBasketId } = useBasketState();

    const fetchBaskets = async (silent: boolean) => {
        if (silent) setRefreshing(true);
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/baskets/user/${userId}`);
            const data = await res.json();
            const basketList = Array.isArray(data) ? data : [];
            setBaskets(basketList);
            const draft = basketList.find((b: Basket) => b.status === 'draft');
            setDraftBasketId(draft ? draft.id : null);
        } catch (error) {
            console.error('Failed to fetch baskets:', error);
        } finally {
            if (silent) setRefreshing(false);
            setLoading(false);
        }
    };

    useFocusEffect(useCallback(() => {
        const silent = hasFetchedRef.current;
        hasFetchedRef.current = true;
        fetchBaskets(silent);
    }, []));

    const createBasket = async () => {
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/baskets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });
            const data = await res.json();
            await fetchBaskets(true);
            router.push(`/basket/${data.id}`);
        } catch (error) {
            Alert.alert('Klaida', 'Nepavyko sukurti krepšelio');
        }
    };

    const handleCreateBasket = async () => {
        const draft = baskets.find(b => b.status === 'draft');
        if (draft) {
            Alert.alert('Dėmesio', 'Jau turite aktyvų krepšelį. Užbaikite jį prieš kurdami naują.');
            return;
        }
        await createBasket();
    };

    // Basket lifecycle is exactly three states: draft (editable), compared
    // (calculated, read-only until reverted), completed (shopping list
    // wrapped up). 'active' was a leftover from an earlier plan and is
    // never emitted by the backend — removed.
    const getStatusColor = (status: string) => {
        switch (status) {
            case 'draft': return colors.warning;
            case 'compared': return colors.info;
            case 'inProgress': return colors.primary;
            case 'completed': return colors.success;
            default: return colors.textSecondary;
        }
    };

    const getStatusText = (status: string) => {
        switch (status) {
            case 'draft': return 'Juodraštis';
            case 'compared': return 'Palyginta';
            case 'inProgress': return 'Vykdomas';
            case 'completed': return 'Įvykdytas';
            default: return status;
        }
    };

    if (loading) return <View style={styles.centered}><ActivityIndicator size="large" color={colors.primary} /></View>;

    const visibleBaskets = baskets.slice(0, visibleCount);
    const hasMore = baskets.length > visibleCount;

    return (
        <View style={styles.container}>
            {refreshing && (
                <View style={styles.refreshingBanner}>
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text style={styles.refreshingText}>Įkeliama…</Text>
                </View>
            )}
            <FlatList
                data={visibleBaskets}
                keyExtractor={item => item.id.toString()}
                contentContainerStyle={styles.list}
                ListEmptyComponent={
                    <View style={styles.centered}>
                        <Text style={styles.emptyText}>Krepšelis tuščias</Text>
                        <Text style={styles.emptySubText}>Eikite į Naršyti ir pridėkite produktų</Text>
                    </View>
                }
                ListFooterComponent={
                    hasMore ? (
                        <TouchableOpacity
                            style={styles.loadMoreButton}
                            onPress={() => setVisibleCount(c => c + PAGE_INCREMENT)}
                        >
                            <Text style={styles.loadMoreText}>
                                Rodyti daugiau ({baskets.length - visibleCount})
                            </Text>
                        </TouchableOpacity>
                    ) : null
                }
                renderItem={({ item }) => (
                    <TouchableOpacity
                        style={styles.card}
                        onPress={() => router.push(`/basket/${item.id}`)}
                    >
                        <View style={styles.cardLeft}>
                            <View style={styles.iconContainer}>
                                <Ionicons name="cart-outline" size={28} color={colors.primary} />
                                {item.itemCount > 0 && (
                                    <View style={styles.badge}>
                                        <Text style={styles.badgeText}>{item.itemCount}</Text>
                                    </View>
                                )}
                            </View>
                        </View>
                        <View style={styles.cardContent}>
                            {item.name ? (
                                <>
                                    <Text style={styles.cardTitle}>{item.name}</Text>
                                    <Text style={styles.cardDate}>
                                        {new Date(item.updatedAt).toLocaleDateString('lt-LT')}
                                    </Text>
                                </>
                            ) : (
                                <Text style={styles.cardTitle}>
                                    {new Date(item.updatedAt).toLocaleDateString('lt-LT')}
                                </Text>
                            )}
                        </View>
                        <View style={[styles.statusBadge, { backgroundColor: getStatusColor(item.status) }]}>
                            <Text style={styles.statusText}>{getStatusText(item.status)}</Text>
                        </View>
                    </TouchableOpacity>
                )}
            />
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    list: { padding: 16, paddingBottom: 80 },
    card: {
        backgroundColor: c.cardBackground, borderRadius: 12, padding: 16, marginBottom: 12,
        flexDirection: 'row', alignItems: 'center',
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08, shadowRadius: 2,
        borderLeftWidth: 3, borderLeftColor: c.softAccent,
    },
    cardLeft: { marginRight: 12 },
    cardContent: { flex: 1 },
    cardTitle: { fontSize: 15, fontWeight: '600', color: c.textPrimary },
    cardDate: { fontSize: 13, color: c.textSecondary, marginTop: 2 },
    statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
    statusText: { fontSize: 11, color: c.textInverse, fontWeight: '600' },
    emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600' },
    emptySubText: { fontSize: 13, color: c.textMuted, marginTop: 4 },
    fab: {
        position: 'absolute', bottom: 24, right: 24,
        backgroundColor: c.primary, width: 56, height: 56,
        borderRadius: 28, alignItems: 'center', justifyContent: 'center', elevation: 4,
    },
    iconContainer: {
        position: 'relative',
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
    },
    badge: {
        position: 'absolute',
        top: -4,
        right: -6,
        backgroundColor: c.primary,
        borderRadius: 10,
        minWidth: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 4,
    },
    badgeText: { color: c.onPrimary, fontSize: 10, fontWeight: '700' },
    refreshingBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 4,
        backgroundColor: c.surfaceSubtle,
    },
    refreshingText: {
        fontSize: 11,
        color: c.textSecondary,
        fontWeight: '500',
    },
    loadMoreButton: {
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.border,
        alignItems: 'center',
        backgroundColor: c.cardBackground,
        marginTop: 4,
    },
    loadMoreText: {
        fontSize: 13,
        color: c.primary,
        fontWeight: '600',
    },
});