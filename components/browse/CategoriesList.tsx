import { View, FlatList, TouchableOpacity, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../config/api';
import { useTheme, type AppTheme } from '../../constants/theme';
import { SkeletonBox } from '../SkeletonBox';

export interface Category {
    id: number;
    name: string;
    /** Canonical Lithuanian name (used for icon lookup). Server-side
     *  responses use it for stable icon lookup independent of the user's
     *  current language. Falls back to `name` when missing. */
    nameKey?: string;
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

const L1Item = memo(function L1Item({ item, isExpanded, l2, onToggle, onSelectL2, colors, styles }: {
    item: Category;
    isExpanded: boolean;
    l2: Category[];
    onToggle: (id: number) => void;
    onSelectL2: (l2: Category) => void;
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
                    onPress={() => onSelectL2(cat)}
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
                onPress={() => onToggle(item.id)}
            >
                <Text style={styles.l1Icon}>{CATEGORY_ICONS[item.nameKey ?? item.name] || '📦'}</Text>
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

interface Props {
    /** Called when the user taps an L2 (subcategory) row. Caller decides
     *  routing (Narsyti tab navigates to /browse/[id]; template-add appends
     *  a templateId param so downstream screens know to add to the template
     *  instead of the basket). */
    onSelectL2: (l2: Category) => void;
}

export function CategoriesList({ onSelectL2 }: Props) {
    const colors = useTheme();
    const { i18n } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [l1Categories, setL1Categories] = useState<Category[]>([]);
    const [l2Map, setL2Map] = useState<Record<number, Category[]>>({});
    const [expandedL1, setExpandedL1] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);

    // Re-fetch on language change. First launch boots at 'lt' and flips to
    // the persisted language once settingsStore.hydrate() resolves; aborting
    // the in-flight request on cleanup keeps the late 'lt' response from
    // overwriting fresh 'en' data.
    useEffect(() => {
        let cancelled = false;
        const ctrl = new AbortController();
        fetch(`${API_BASE_URL}/api/categories`, { signal: ctrl.signal })
            .then(r => r.json())
            .then((data: Category[]) => {
                if (cancelled) return;
                const cats = Array.isArray(data) ? data : [];
                setL1Categories(cats);
                return Promise.all(
                    cats.map(cat =>
                        fetch(`${API_BASE_URL}/api/categories/${cat.id}/subcategories`, { signal: ctrl.signal })
                            .then(r => r.json())
                            .then(sub => ({ id: cat.id, sub: Array.isArray(sub) ? sub : [] as Category[] }))
                            .catch((err: any) => {
                                if (err?.name === 'AbortError') throw err;
                                return { id: cat.id, sub: [] as Category[] };
                            })
                    )
                ).then(results => {
                    if (cancelled) return;
                    const map: Record<number, Category[]> = {};
                    results.forEach(({ id, sub }) => { map[id] = sub; });
                    setL2Map(map);
                });
            })
            .catch((err: any) => {
                if (err?.name !== 'AbortError') console.warn('[browse] L1 fetch failed:', err);
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; ctrl.abort(); };
    }, [i18n.language]);

    const toggleL1 = useCallback((id: number) => {
        setExpandedL1(prev => prev === id ? null : id);
    }, []);

    if (loading) {
        return (
            <View style={[styles.container, { padding: 16, gap: 10 }]}>
                {Array.from({ length: 8 }).map((_, i) => (
                    <View
                        key={i}
                        style={{
                            flexDirection: 'row', alignItems: 'center', gap: 12,
                            paddingHorizontal: 16, paddingVertical: 14,
                            backgroundColor: colors.cardBackground, borderRadius: 12,
                            borderLeftWidth: 3, borderLeftColor: colors.softAccent,
                        }}
                    >
                        <SkeletonBox width={24} height={24} borderRadius={6} />
                        <SkeletonBox width={180} height={15} borderRadius={7} style={{ flex: 1 }} />
                        <SkeletonBox width={16} height={16} borderRadius={4} />
                    </View>
                ))}
            </View>
        );
    }

    return (
        <FlatList
            style={styles.container}
            data={l1Categories}
            keyExtractor={item => item.id.toString()}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => (
                <L1Item
                    item={item}
                    isExpanded={expandedL1 === item.id}
                    l2={l2Map[item.id] ?? EMPTY_L2}
                    onToggle={toggleL1}
                    onSelectL2={onSelectL2}
                    colors={colors}
                    styles={styles}
                />
            )}
        />
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    list: { padding: 16, gap: 10 },
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
