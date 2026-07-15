import {
    View,
    Text,
    FlatList,
    TouchableOpacity,
    StyleSheet,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTheme, type AppTheme } from '../../../constants/theme';
import { API_BASE_URL } from '../../../config/api';
import { SkeletonBox } from '../../../components/SkeletonBox';

interface Category {
    id: number;
    name: string;
    parentCategoryId: number | null;
}

// ─── L1 accordion item ────────────────────────────────────────────────────────

const L1Item = memo(function L1Item({
    item, isExpanded, l2, onToggle, onSelectL2, colors, styles,
}: {
    item: Category;
    isExpanded: boolean;
    l2: Category[];
    onToggle: (id: number) => void;
    onSelectL2: (cat: Category, l1: Category) => void;
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
            if (isExpanded) animatedHeight.value = withTiming(h, { duration: 150 });
        }
    };

    return (
        <View style={[styles.l1Container, isExpanded && styles.l1ContainerExpanded]}>
            <TouchableOpacity style={styles.l1Row} onPress={() => onToggle(item.id)}>
                <Text style={styles.l1Text}>{item.name}</Text>
                <Animated.View style={chevronStyle}>
                    <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
                </Animated.View>
            </TouchableOpacity>
            <Animated.View style={animatedContentStyle}>
                <View onLayout={handleLayout} style={styles.l2Container}>
                    {l2.length === 0 ? (
                        <MaterialProgress size="small" color={colors.primary} style={{ padding: 12 }} />
                    ) : (
                        l2.map((cat, index) => (
                            <View key={cat.id}>
                                {index > 0 && <View style={styles.divider} />}
                                <TouchableOpacity
                                    style={styles.l2Row}
                                    onPress={() => onSelectL2(cat, item)}
                                >
                                    <Text style={styles.l2Text}>{cat.name}</Text>
                                    <Ionicons name="chevron-forward" size={16} color={colors.primary} />
                                </TouchableOpacity>
                            </View>
                        ))
                    )}
                </View>
            </Animated.View>
        </View>
    );
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function CatalogIndexScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { top } = useSafeAreaInsets();
    const router = useRouter();

    const [l1Categories, setL1Categories] = useState<Category[]>([]);
    const [expandedL1, setExpandedL1] = useState<number | null>(null);
    const [l2Map, setL2Map] = useState<Record<number, Category[]>>({});
    const [loadingL1, setLoadingL1] = useState(true);

    useEffect(() => {
        fetch(`${API_BASE_URL}/api/categories`)
            .then(r => r.json())
            .then((all: Category[]) => {
                if (!Array.isArray(all)) return;
                setL1Categories(all.filter(c => c.parentCategoryId === null));
            })
            .catch(() => {})
            .finally(() => setLoadingL1(false));
    }, []);

    const toggleL1 = useCallback((l1Id: number) => {
        const next = expandedL1 === l1Id ? null : l1Id;
        setExpandedL1(next);
        if (next && !l2Map[next]) {
            fetch(`${API_BASE_URL}/api/categories/${next}/subcategories`)
                .then(r => r.json())
                .then((data: Category[]) => {
                    if (!Array.isArray(data)) return;
                    setL2Map(prev => ({ ...prev, [next]: data }));
                })
                .catch(() => {});
        }
    }, [expandedL1, l2Map]);

    const openCategory = useCallback((cat: Category, l1: Category) => {
        router.push({
            pathname: '/admin/catalog/[categoryId]' as any,
            params: { categoryId: String(cat.id), catName: cat.name, l1name: l1.name },
        });
    }, [router]);

    return (
        <View style={styles.container}>
            <View style={[styles.listHeader, { paddingTop: top + 4 }]}>
                <Text style={styles.listHeaderTitle}>Katalogas</Text>
                <Text style={styles.listHeaderSub}>Pasirinkite kategoriją</Text>
            </View>
            {loadingL1 ? (
                <View style={styles.skeletonList}>
                    {Array.from({ length: 6 }).map((_, i) => (
                        <View key={i} style={styles.skeletonListItem}>
                            <SkeletonBox width={200} height={14} borderRadius={6} />
                            <SkeletonBox width={16} height={16} borderRadius={8} />
                        </View>
                    ))}
                </View>
            ) : (
                <FlatList
                    data={l1Categories}
                    keyExtractor={item => item.id.toString()}
                    renderItem={({ item }) => (
                        <L1Item
                            item={item}
                            isExpanded={expandedL1 === item.id}
                            l2={l2Map[item.id] ?? []}
                            onToggle={toggleL1}
                            onSelectL2={openCategory}
                            colors={colors}
                            styles={styles}
                        />
                    )}
                />
            )}
        </View>
    );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },

    listHeader: {
        paddingHorizontal: 16,
        paddingBottom: 12,
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5,
        borderBottomColor: c.border,
    },
    listHeaderTitle: {
        fontSize: 22,
        fontWeight: '700',
        color: c.textPrimary,
    },
    listHeaderSub: {
        fontSize: 13,
        color: c.textSecondary,
        marginTop: 2,
    },

    l1Container: {
        backgroundColor: c.cardBackground,
        marginBottom: 1,
    },
    l1ContainerExpanded: {
        borderBottomWidth: 0.5,
        borderBottomColor: c.border,
    },
    l1Row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 16,
        gap: 8,
    },
    l1Text: {
        flex: 1,
        fontSize: 16,
        fontWeight: '600',
        color: c.textPrimary,
    },
    l2Container: {
        position: 'absolute',
        width: '100%',
        backgroundColor: c.pageBackground,
    },
    l2Row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 24,
        paddingVertical: 14,
    },
    l2Text: {
        flex: 1,
        fontSize: 15,
        color: c.textPrimary,
    },
    divider: {
        height: 0.5,
        backgroundColor: c.borderSubtle,
        marginLeft: 24,
    },

    skeletonList: { padding: 16, gap: 14 },
    skeletonListItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: c.cardBackground,
        padding: 16,
        borderRadius: 8,
    },
});
