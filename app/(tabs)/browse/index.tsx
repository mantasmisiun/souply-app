import { View, FlatList, TouchableOpacity, Text, StyleSheet, ActivityIndicator, LayoutAnimation } from 'react-native';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../../config/api';
import { useTheme, type AppTheme } from '../../../constants/theme';

interface Category {
    id: number;
    name: string;
    parentCategoryId: number | null;
}

const CATEGORY_ICONS: Record<string, string> = {
    'Daržovės ir vaisiai': '🫜',
    'Pieno gaminiai, kiaušiniai ir majonezas': '🥛',
    'Duonos gaminiai ir konditerija': '🍞',
    'Mėsa, žuvis ir kulinarija': '🥩',
    'Bakalėja': '🫙',
    'Šaldytas maistas': '🧊',
    'Gėrimai': '🥤',
    'Kūdikių ir vaikų prekės': '🍼',
    'Kosmetika ir higiena': '🧴',
    'Švaros ir gyvūnų prekės': '🧹',
    'Namai ir laisvalaikis': '🏠',
};

export default function BrowseIndex() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [l1Categories, setL1Categories] = useState<Category[]>([]);
    const [l2Map, setL2Map] = useState<Record<number, Category[]>>({});
    const [expandedL1, setExpandedL1] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const router = useRouter();
    const DISCOUNTS_ITEM = { id: -1, name: 'Nuolaidos', parentCategoryId: null } as const;

    useEffect(() => {
        fetch(`${API_BASE_URL}/api/categories`)
            .then(r => r.json())
            .then(data => {
                setL1Categories(Array.isArray(data) ? data : []);
            })
            .finally(() => setLoading(false));
    }, []);

    const toggleL1 = async (id: number) => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        if (expandedL1 === id) {
            setExpandedL1(null);
            return;
        }
        setExpandedL1(id);
        if (!l2Map[id]) {
            const res = await fetch(`${API_BASE_URL}/api/categories/${id}/subcategories`);
            const data = await res.json();
            setL2Map(prev => ({ ...prev, [id]: Array.isArray(data) ? data : [] }));
        }
    };

    if (loading) return <ActivityIndicator style={styles.centered} size="large" color={colors.primary} />;

    return (
        <>
            <FlatList
                style={styles.container}
                data={l1Categories}
                keyExtractor={item => item.id.toString()}
                contentContainerStyle={styles.list}
                ListHeaderComponent={
                    <TouchableOpacity
                        style={styles.discountsCard}
                        onPress={() => router.push('/browse/discounts' as any)}
                        activeOpacity={0.8}
                    >
                        <Text style={styles.discountsIcon}>🔥</Text>
                        <View style={styles.discountsTextWrap}>
                            <Text style={styles.discountsTitle}>Nuolaidos</Text>
                            <Text style={styles.discountsSub}>Akcijinės prekės iš visų parduotuvių</Text>
                        </View>
                        <Ionicons name="chevron-forward" size={20} color={colors.onPrimary} />
                    </TouchableOpacity>
                }
                renderItem={({ item }) => {
                    const isExpanded = expandedL1 === item.id;
                    const l2 = l2Map[item.id] || [];
                    return (
                        <View style={[styles.l1Container, isExpanded && styles.l1ContainerExpanded]}>
                            <TouchableOpacity
                                style={[styles.l1Row, isExpanded && styles.l1RowExpanded]}
                                onPress={() => toggleL1(item.id)}
                            >
                                <Text style={styles.l1Icon}>{CATEGORY_ICONS[item.name] || '📦'}</Text>
                                <Text style={styles.l1Text}>{item.name}</Text>
                                <Ionicons
                                    name={isExpanded ? 'chevron-up' : 'chevron-down'}
                                    size={20}
                                    color={isExpanded ? colors.primary : colors.success}
                                />
                            </TouchableOpacity>
                            {isExpanded && (
                                <View style={styles.l2Container}>
                                    {l2.length === 0 ? (
                                        <ActivityIndicator size="small" color={colors.primary} style={{ padding: 12 }} />
                                    ) : (
                                        l2.map((cat, index) => (
                                            <View key={cat.id}>
                                                {index > 0 && <View style={styles.divider} />}
                                                <TouchableOpacity
                                                    style={styles.l2Row}
                                                    onPress={() => router.push(`/browse/${cat.id}?name=${encodeURIComponent(cat.name)}`)}
                                                >
                                                    <Text style={styles.l2Text}>{cat.name}</Text>
                                                    <Ionicons name="chevron-forward" size={18} color={colors.primary} />
                                                </TouchableOpacity>
                                            </View>
                                        ))
                                    )}
                                </View>
                            )}
                        </View>
                    );
                }}
            />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.pageBackground },
    list: { padding: 16, gap: 10 },
    discountsCard: {
        backgroundColor: c.primary,
        borderRadius: 14,
        paddingHorizontal: 16,
        paddingVertical: 18,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        elevation: 2,
        shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.12, shadowRadius: 4,
    },
    discountsIcon: { fontSize: 28 },
    discountsTextWrap: { flex: 1 },
    discountsTitle: {
        fontSize: 17,
        fontWeight: '700',
        color: c.onPrimary,
    },
    discountsSub: {
        fontSize: 12,
        color: c.onPrimary,
        opacity: 0.8,
        marginTop: 2,
    },
    l1Container: {
        backgroundColor: c.cardBackground,
        borderRadius: 12,
        overflow: 'hidden',
        elevation: 1,
        shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06, shadowRadius: 2,
        borderLeftWidth: 3,
        borderLeftColor: c.softAccent,
    },
    l1ContainerExpanded: {
        borderLeftColor: c.primary,
    },
    l1Row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    l1RowExpanded: {
        backgroundColor: c.softAccentWash,
    },
    l1Text: {
        fontSize: 15,
        fontWeight: '600',
        color: c.textPrimary,
        flex: 1,
    },
    l2Container: {
        borderTopWidth: 0.5,
        borderTopColor: c.softAccent,
    },
    l2Row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        paddingLeft: 24,
    },
    l2Text: {
        fontSize: 14,
        color: c.textPrimary,
        flex: 1,
    },
    divider: {
        height: 0.5,
        backgroundColor: c.softAccent,
        marginLeft: 24,
    },
    l1Icon: {
        fontSize: 20,
        marginRight: 12,
    },
});
