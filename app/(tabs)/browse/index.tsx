import { View, FlatList, TouchableOpacity, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { SkeletonBox } from '../../../components/SkeletonBox';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
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

const EMPTY_L2: Category[] = [];

const L1Item = memo(function L1Item({ item, isExpanded, l2, onToggle, router, colors, styles }: {
    item: Category;
    isExpanded: boolean;
    l2: Category[];
    onToggle: (id: number) => void;
    router: ReturnType<typeof useRouter>;
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
}) {
    const contentHeightRef = useRef(0);
    const animatedHeight = useSharedValue(0);
    const chevronRotation = useSharedValue(0);

    useLayoutEffect(() => {
        animatedHeight.value = withTiming(isExpanded ? contentHeightRef.current : 0, {
            duration: 220,
            easing: Easing.inOut(Easing.quad),
        });
        chevronRotation.value = withTiming(isExpanded ? 1 : 0, { duration: 220 });
    }, [isExpanded]);

    const animatedContentStyle = useAnimatedStyle(() => ({
        height: animatedHeight.value,
        overflow: 'hidden',
    }));

    const chevronStyle = useAnimatedStyle(() => ({
        transform: [{ rotate: `${chevronRotation.value * 180}deg` }],
    }));

    const handleLayout = (e: { nativeEvent: { layout: { height: number } } }) => {
        const h = e.nativeEvent.layout.height;
        if (h > 0 && h !== contentHeightRef.current) {
            contentHeightRef.current = h;
            if (isExpanded) {
                animatedHeight.value = withTiming(h, { duration: 150 });
            }
        }
    };

    const l2Rows = l2.length === 0 ? (
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
    );

    return (
        <View style={[styles.l1Container, isExpanded && styles.l1ContainerExpanded]}>
            <TouchableOpacity
                style={[styles.l1Row, isExpanded && styles.l1RowExpanded]}
                onPressIn={() => onToggle(item.id)}
            >
                <Text style={styles.l1Icon}>{CATEGORY_ICONS[item.name] || '📦'}</Text>
                <Text style={styles.l1Text}>{item.name}</Text>
                <Animated.View style={chevronStyle}>
                    <Ionicons name="chevron-down" size={20} color={isExpanded ? colors.primary : colors.success} />
                </Animated.View>
            </TouchableOpacity>
            {/* Ghost view: absolutely positioned so its layout isn't constrained by
                animatedHeight. onLayout here always returns the natural content height. */}
            <View
                style={{ position: 'absolute', opacity: 0, left: 0, right: 0 }}
                pointerEvents="none"
                onLayout={handleLayout}
            >
                <View style={styles.l2Container}>{l2Rows}</View>
            </View>
            <Animated.View style={animatedContentStyle}>
                <View style={styles.l2Container}>{l2Rows}</View>
            </Animated.View>
        </View>
    );
});

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
            .then((data: Category[]) => {
                const cats = Array.isArray(data) ? data : [];
                setL1Categories(cats);
                Promise.all(
                    cats.map(cat =>
                        fetch(`${API_BASE_URL}/api/categories/${cat.id}/subcategories`)
                            .then(r => r.json())
                            .then(sub => ({ id: cat.id, sub: Array.isArray(sub) ? sub : [] as Category[] }))
                            .catch(() => ({ id: cat.id, sub: [] as Category[] }))
                    )
                ).then(results => {
                    const map: Record<number, Category[]> = {};
                    results.forEach(({ id, sub }) => { map[id] = sub; });
                    setL2Map(map);
                });
            })
            .finally(() => setLoading(false));
    }, []);

    const toggleL1 = useCallback((id: number) => {
        setExpandedL1(prev => prev === id ? null : id);
    }, []);

    if (loading) return (
        <View style={[styles.container, { padding: 16, gap: 10 }]}>
            <SkeletonBox height={70} borderRadius={16} />
            {Array.from({ length: 8 }).map((_, i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', padding: 14, backgroundColor: colors.cardBackground, borderRadius: 12, gap: 12 }}>
                    <SkeletonBox width={32} height={32} borderRadius={16} />
                    <SkeletonBox width={180} height={14} borderRadius={7} />
                </View>
            ))}
        </View>
    );

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
                renderItem={({ item }) => (
                    <L1Item
                        item={item}
                        isExpanded={expandedL1 === item.id}
                        l2={l2Map[item.id] ?? EMPTY_L2}
                        onToggle={toggleL1}
                        router={router}
                        colors={colors}
                        styles={styles}
                    />
                )}
            />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
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
