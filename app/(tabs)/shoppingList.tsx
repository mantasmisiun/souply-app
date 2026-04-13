import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Image, Alert } from 'react-native';
import { useCallback, useState } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { Swipeable, GestureHandlerRootView } from 'react-native-gesture-handler';

interface ShoppingList {
    id: number;
    storeId: number;
    storeName: string;
    address: string;
    chainName: string;
    logoUrl: string | null;
    status: string;
    createdAt: string;
    itemCount: number;
    checkedCount: number;
}

export default function ShoppingListScreen() {
    const [lists, setLists] = useState<ShoppingList[]>([]);
    const [loading, setLoading] = useState(true);
    const router = useRouter();

    const fetchLists = async () => {
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/shopping-lists/user/${userId}`);
            const data = await res.json();
            setLists(Array.isArray(data) ? data : []);
        } catch (error) {
            console.error('Failed to fetch lists:', error);
        } finally {
            setLoading(false);
        }
    };

    useFocusEffect(useCallback(() => {
        fetchLists();
    }, []));

    const deleteList = async (id: number) => {
        try {
            await fetch(`${API_BASE_URL}/api/shopping-lists/${id}`, { method: 'DELETE' });
            setLists(prev => prev.filter(l => l.id !== id));
        } catch (error) {
            Alert.alert('Klaida', 'Nepavyko ištrinti sąrašo');
        }
    };

    const completeList = async (id: number) => {
        try {
            await fetch(`${API_BASE_URL}/api/shopping-lists/${id}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'completed' }),
            });
            setLists(prev => prev.map(l => l.id === id ? { ...l, status: 'completed' } : l));
        } catch (error) {
            Alert.alert('Klaida', 'Nepavyko užbaigti sąrašo');
        }
    };

    const activeLists = lists.filter(l => l.status === 'active');
    const completedLists = lists.filter(l => l.status === 'completed');

    const renderRightActions = (id: number) => (
        <TouchableOpacity
            style={styles.deleteAction}
            onPress={() => Alert.alert(
                'Ištrinti',
                'Ar tikrai norite ištrinti šį sąrašą?',
                [
                    { text: 'Atšaukti', style: 'cancel' },
                    { text: 'Ištrinti', style: 'destructive', onPress: () => deleteList(id) }
                ]
            )}
        >
            <Ionicons name="trash-outline" size={24} color="white" />
            <Text style={styles.actionText}>Ištrinti</Text>
        </TouchableOpacity>
    );

    const renderLeftActions = (id: number, status: string) => {
        if (status === 'completed') return null;
        return (
            <TouchableOpacity
                style={styles.completeAction}
                onPress={() => completeList(id)}
            >
                <Ionicons name="checkmark-done-outline" size={24} color="white" />
                <Text style={styles.actionText}>Užbaigti</Text>
            </TouchableOpacity>
        );
    };

    const renderItem = ({ item }: { item: ShoppingList }) => {
        const progress = item.itemCount > 0 ? item.checkedCount / item.itemCount : 0;
        return (
            <Swipeable
                renderRightActions={() => renderRightActions(item.id)}
                renderLeftActions={() => renderLeftActions(item.id, item.status)}
                overshootRight={false}
                overshootLeft={false}
            >
                <TouchableOpacity
                    style={styles.card}
                    onPress={() => router.push(`/shopping-list/${item.id}` as any)}
                >
                    <View style={styles.cardLeft}>
                        {item.logoUrl ? (
                            <Image source={{ uri: item.logoUrl }} style={styles.logo} resizeMode="contain" />
                        ) : (
                            <View style={styles.logoPlaceholder}>
                                <Text style={styles.logoPlaceholderText}>{item.chainName[0]}</Text>
                            </View>
                        )}
                    </View>
                    <View style={styles.cardContent}>
                        <Text style={styles.storeName}>{item.address}</Text>
                        <Text style={styles.date}>
                            {new Date(item.createdAt).toLocaleDateString('lt-LT')}
                        </Text>
                        {item.status === 'active' && item.itemCount > 0 && (
                            <View style={styles.progressRow}>
                                <View style={styles.progressBar}>
                                    <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
                                </View>
                                <Text style={styles.progressText}>{item.checkedCount}/{item.itemCount}</Text>
                            </View>
                        )}
                    </View>
                    <View style={styles.badgeContainer}>
                        <View style={[styles.badge, item.status === 'completed' && styles.badgeCompleted]}>
                            <Text style={[styles.badgeText, item.status === 'completed' && styles.badgeTextCompleted]}>
                                {item.itemCount}
                            </Text>
                        </View>
                    </View>
                </TouchableOpacity>
            </Swipeable>
        );
    };

    if (loading) return <View style={styles.centered}><ActivityIndicator size="large" color="#2e7d32" /></View>;

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <View style={styles.container}>
                <FlatList
                    data={[]}
                    keyExtractor={() => ''}
                    renderItem={null}
                    ListHeaderComponent={
                        <>
                            {activeLists.length > 0 && (
                                <>
                                    <Text style={styles.sectionTitle}>Aktyvūs</Text>
                                    {activeLists.map(item => (
                                        <View key={item.id}>{renderItem({ item })}</View>
                                    ))}
                                </>
                            )}
                            {completedLists.length > 0 && (
                                <>
                                    <Text style={styles.sectionTitle}>Užbaigti</Text>
                                    {completedLists.map(item => (
                                        <View key={item.id}>{renderItem({ item })}</View>
                                    ))}
                                </>
                            )}
                            {lists.length === 0 && (
                                <View style={styles.centered}>
                                    <Text style={styles.emptyText}>Pirkinių sąrašų nėra</Text>
                                    <Text style={styles.emptySubText}>Sukurkite sąrašą iš krepšelio palyginimo rezultatų</Text>
                                </View>
                            )}
                        </>
                    }
                    contentContainerStyle={styles.list}
                />
            </View>
        </GestureHandlerRootView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    list: { padding: 16 },
    sectionTitle: { fontSize: 13, fontWeight: '700', color: '#9e9e9e', marginBottom: 8, marginTop: 8, textTransform: 'uppercase' },
    card: {
        backgroundColor: 'white', borderRadius: 12, padding: 14, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center',
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1, shadowRadius: 2,
    },
    cardLeft: { marginRight: 12 },
    logo: { width: 44, height: 44, borderRadius: 8 },
    logoPlaceholder: {
        width: 44, height: 44, borderRadius: 8,
        backgroundColor: '#e0e0e0', alignItems: 'center', justifyContent: 'center',
    },
    logoPlaceholderText: { fontSize: 18, fontWeight: '700', color: '#757575' },
    cardContent: { flex: 1 },
    storeName: { fontSize: 14, fontWeight: '600', color: '#212121' },
    date: { fontSize: 12, color: '#9e9e9e', marginTop: 2 },
    progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
    progressBar: { flex: 1, height: 4, backgroundColor: '#e0e0e0', borderRadius: 2, overflow: 'hidden' },
    progressFill: { height: '100%', backgroundColor: '#2e7d32', borderRadius: 2 },
    progressText: { fontSize: 11, color: '#757575' },
    badgeContainer: { marginLeft: 8 },
    badge: {
        backgroundColor: '#e8f5e9', width: 28, height: 28, borderRadius: 14,
        alignItems: 'center', justifyContent: 'center',
    },
    badgeCompleted: { backgroundColor: '#e0e0e0' },
    badgeText: { fontSize: 12, fontWeight: '700', color: '#2e7d32' },
    badgeTextCompleted: { color: '#9e9e9e' },
    emptyText: { fontSize: 16, color: '#757575', fontWeight: '600', textAlign: 'center' },
    emptySubText: { fontSize: 13, color: '#9e9e9e', marginTop: 4, textAlign: 'center' },
    deleteAction: {
        backgroundColor: '#c62828', justifyContent: 'center', alignItems: 'center',
        width: 80, borderRadius: 12, marginBottom: 10,
        flexDirection: 'column', gap: 4,
    },
    completeAction: {
        backgroundColor: '#2e7d32', justifyContent: 'center', alignItems: 'center',
        width: 80, borderRadius: 12, marginBottom: 10,
        flexDirection: 'column', gap: 4,
    },
    actionText: { color: 'white', fontSize: 11, fontWeight: '600' },
});