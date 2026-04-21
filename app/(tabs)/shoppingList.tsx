import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Image, Alert } from 'react-native';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import ReanimatedSwipeable, { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useTheme, type AppTheme } from '../../constants/theme';

type Styles = ReturnType<typeof makeStyles>;

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

function ShoppingListCard({ item, onDelete, onComplete, onPress, styles, colors }: {
    item: ShoppingList;
    onDelete: (id: number) => void;
    onComplete: (id: number) => void;
    onPress: (id: number) => void;
    styles: Styles;
    colors: AppTheme;
}) {
    const swipeableRef = useRef<SwipeableMethods>(null);
    const progress = item.itemCount > 0 ? item.checkedCount / item.itemCount : 0;

    const handleSwipeOpen = (direction: 'left' | 'right') => {
        if (direction === 'right') {
            // swiped right → complete action revealed
            swipeableRef.current?.close();
            Alert.alert(
                'Užbaigti',
                'Ar tikrai norite užbaigti šį sąrašą?',
                [
                    { text: 'Atšaukti', style: 'cancel' as const },
                    { text: 'Užbaigti', style: 'default' as const, onPress: () => onComplete(item.id) },
                ]
            );
        } else if (direction === 'left') {
            // swiped left → delete action revealed
            swipeableRef.current?.close();
            Alert.alert(
                'Ištrinti',
                'Ar tikrai norite ištrinti šį sąrašą?',
                [
                    { text: 'Atšaukti', style: 'cancel' as const },
                    { text: 'Ištrinti', style: 'destructive' as const, onPress: () => onDelete(item.id) },
                ]
            );
        }
    };

    const rightActions = () => (
        <View style={styles.deleteAction}>
            <Ionicons name="trash-outline" size={24} color={colors.textInverse} />
            <Text style={styles.actionText}>Ištrinti</Text>
        </View>
    );

    const leftActions = () => {
        if (item.status === 'completed') return null;
        return (
            <View style={styles.completeAction}>
                <Ionicons name="checkmark-done-outline" size={24} color={colors.textInverse} />
                <Text style={styles.actionText}>Užbaigti</Text>
            </View>
        );
    };

    return (
        <ReanimatedSwipeable
            ref={swipeableRef}
            renderRightActions={rightActions}
            renderLeftActions={leftActions}
            overshootRight={false}
            overshootLeft={false}
            friction={2}
            leftThreshold={40}
            rightThreshold={40}
            onSwipeableOpen={handleSwipeOpen}
        >
            <TouchableOpacity
                style={[
                    styles.card,
                    item.status === 'active' ? styles.cardActive : styles.cardCompleted
                ]}
                onPress={() => onPress(item.id)}
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
        </ReanimatedSwipeable>
    );
}

export default function ShoppingListScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
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
        } catch {
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
        } catch {
            Alert.alert('Klaida', 'Nepavyko užbaigti sąrašo');
        }
    };

    const activeLists = lists.filter(l => l.status === 'active');
    const completedLists = lists.filter(l => l.status === 'completed');

    if (loading) return (
        <View style={styles.centered}>
            <ActivityIndicator size="large" color={colors.primary} />
        </View>
    );

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
                                        <ShoppingListCard
                                            key={item.id}
                                            item={item}
                                            onDelete={deleteList}
                                            onComplete={completeList}
                                            onPress={(id) => router.push(`/shopping-list/${id}` as any)}
                                            styles={styles}
                                            colors={colors}
                                        />
                                    ))}
                                </>
                            )}
                            {completedLists.length > 0 && (
                                <>
                                    <Text style={styles.sectionTitle}>Užbaigti</Text>
                                    {completedLists.map(item => (
                                        <ShoppingListCard
                                            key={item.id}
                                            item={item}
                                            onDelete={deleteList}
                                            onComplete={completeList}
                                            onPress={(id) => router.push(`/shopping-list/${id}` as any)}
                                            styles={styles}
                                            colors={colors}
                                        />
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

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    list: { padding: 16 },
    sectionTitle: {
        fontSize: 13, fontWeight: '700', color: c.textMuted,
        marginBottom: 8, marginTop: 8, textTransform: 'uppercase',
    },
    card: {
        backgroundColor: c.cardBackground, borderRadius: 12, padding: 14, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center',
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08, shadowRadius: 2,
        borderLeftWidth: 4,
    },
    cardLeft: { marginRight: 12 },
    logo: { width: 44, height: 44, borderRadius: 8 },
    logoPlaceholder: {
        width: 44, height: 44, borderRadius: 8,
        backgroundColor: c.border, alignItems: 'center', justifyContent: 'center',
    },
    logoPlaceholderText: { fontSize: 18, fontWeight: '700', color: c.textSecondary },
    cardContent: { flex: 1 },
    storeName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    date: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
    progressBar: { flex: 1, height: 4, backgroundColor: c.border, borderRadius: 2, overflow: 'hidden' },
    progressFill: { height: '100%', backgroundColor: c.primary, borderRadius: 2 },
    progressText: { fontSize: 11, color: c.textSecondary },
    badgeContainer: { marginLeft: 8 },
    badge: {
        backgroundColor: c.primaryMuted, width: 28, height: 28, borderRadius: 14,
        alignItems: 'center', justifyContent: 'center',
    },
    badgeCompleted: { backgroundColor: c.border },
    badgeText: { fontSize: 12, fontWeight: '700', color: c.primary },
    badgeTextCompleted: { color: c.textMuted },
    emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600', textAlign: 'center' },
    emptySubText: { fontSize: 13, color: c.textMuted, marginTop: 4, textAlign: 'center' },
    deleteAction: {
        backgroundColor: c.error, justifyContent: 'center', alignItems: 'center',
        width: 80, borderRadius: 12, marginBottom: 10,
        flexDirection: 'column', gap: 4,
    },
    completeAction: {
        backgroundColor: c.success, justifyContent: 'center', alignItems: 'center',
        width: 80, borderRadius: 12, marginBottom: 10,
        flexDirection: 'column', gap: 4,
    },
    actionText: { color: c.textInverse, fontSize: 11, fontWeight: '600' },
    cardActive: {
        borderLeftColor: c.primary,
    },
    cardCompleted: {
        borderLeftColor: c.textMuted,
    },
});