import { View, FlatList, TouchableOpacity, Text, StyleSheet, ActivityIndicator, LayoutAnimation, UIManager, Platform } from 'react-native';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../../config/api';
import { useTheme, type AppTheme } from '../../../constants/theme';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
    UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface Category {
    id: number;
    name: string;
    parentCategoryId: number | null;
}

const CATEGORY_ICONS: Record<string, string> = {
    'Daržovės ir vaisiai': '🥦',
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
    list: { padding: 16 },
    l1Container: {
        backgroundColor: c.cardBackground,
        borderRadius: 12,
        marginBottom: 10,
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
