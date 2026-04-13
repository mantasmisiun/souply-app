import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { useEffect, useState, useCallback } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { useBasketState } from '../../state/basketState';

interface Basket {
    id: number;
    userId: string;
    status: string;
    name: string | null;
    createdAt: string;
    updatedAt: string;
    itemCount: number;
}

export default function BasketScreen() {
    const [baskets, setBaskets] = useState<Basket[]>([]);
    const [loading, setLoading] = useState(true);
    const router = useRouter();
    const { setDraftBasketId } = useBasketState();

    const fetchBaskets = async () => {
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
            setLoading(false);
        }
    };

    useFocusEffect(useCallback(() => {
        fetchBaskets();
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
            await fetchBaskets();
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

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'draft': return '#f57c00';
            case 'compared': return '#1565c0';
            case 'active': return '#6a1b9a';
            case 'completed': return '#2e7d32';
            default: return '#757575';
        }
    };

    const getStatusText = (status: string) => {
        switch (status) {
            case 'draft': return 'Juodraštis';
            case 'compared': return 'Palyginta';
            case 'active': return 'Vykdomas';
            case 'completed': return 'Baigtas';
            default: return status;
        }
    };

    if (loading) return <View style={styles.centered}><ActivityIndicator size="large" color="#2e7d32" /></View>;

    return (
        <View style={styles.container}>
            <FlatList
                data={baskets}
                keyExtractor={item => item.id.toString()}
                contentContainerStyle={styles.list}
                ListEmptyComponent={
                    <View style={styles.centered}>
                        <Text style={styles.emptyText}>Krepšelis tuščias</Text>
                        <Text style={styles.emptySubText}>Eikite į Naršyti ir pridėkite produktų</Text>
                    </View>
                }
                renderItem={({ item }) => (
                    <TouchableOpacity
                        style={styles.card}
                        onPress={() => router.push(`/basket/${item.id}`)}
                    >
                        <View style={styles.cardLeft}>
                            <View style={styles.iconContainer}>
                                <Ionicons name="cart-outline" size={28} color="#2e7d32" />
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

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    list: { padding: 16, paddingBottom: 80 },
    card: {
        backgroundColor: 'white', borderRadius: 12, padding: 16, marginBottom: 12,
        flexDirection: 'row', alignItems: 'center',
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1, shadowRadius: 2,
    },
    cardLeft: { marginRight: 12 },
    cardContent: { flex: 1 },
    cardTitle: { fontSize: 15, fontWeight: '600', color: '#212121' },
    cardDate: { fontSize: 13, color: '#757575', marginTop: 2 },
    statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
    statusText: { fontSize: 11, color: 'white', fontWeight: '600' },
    emptyText: { fontSize: 16, color: '#757575', fontWeight: '600' },
    emptySubText: { fontSize: 13, color: '#9e9e9e', marginTop: 4 },
    fab: {
        position: 'absolute', bottom: 24, right: 24,
        backgroundColor: '#2e7d32', width: 56, height: 56,
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
        backgroundColor: '#2e7d32',
        borderRadius: 10,
        minWidth: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 4,
    },
    badgeText: { color: 'white', fontSize: 10, fontWeight: '700' },
});