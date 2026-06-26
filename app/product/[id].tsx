import {
    View,
    Text,
    ScrollView,
    TouchableOpacity,
    StyleSheet,
    Modal,
    Dimensions,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import Animated from 'react-native-reanimated';
import { useCollapsingHeader, CollapsingHeader } from '../../components/CollapsingHeader';
import { SkeletonBox } from '../../components/SkeletonBox';
import { ProductImage } from '../../components/ProductImage';
import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { useTheme, radius, elevation, type AppTheme } from '../../constants/theme';
import MiniPriceChart, { PriceChartSvg, type PricePoint, type RangeKey, preparePriceData, filterByRange } from '../../components/MiniPriceChart';
import { useDisplayMode } from '../../contexts/DisplayPreferenceContext';
import { useTranslation } from 'react-i18next';
import { formatDate, formatEuro, formatAmountStr } from '../../utils/formatCurrency';
import { ChainFilterBar } from '../../components/ChainFilterBar';
import { ChainLogoStrip } from '../../components/ChainLogoStrip';
import { getChainMiniLogoUrl } from '../../utils/chainBrandName';
import { addProductToBasket } from '../../utils/basketUtils';
import { TemplateReturnBanner } from '../../components/template/TemplateReturnBanner';
import { useTemplateAddState } from '../../state/templateAddState';
import { useBasketState } from '../../state/basketState';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import AmountPickerModal from '../../components/AmountPickerModal';
import { QuantityControl } from '../../components/QuantityControl';
import { ScreenHeading } from '../../components/ScreenHeading';
import { resolveCanonicalStep, resolveDisplayUnit } from '../../utils/canonicalStep';

interface StoreProduct {
    id: number;
    productId: number;
    chainId: number;
    storeProductName: string;
    brandName: string | null;
    amount: string;
    unit: string;
    isWeighable: number;
    chainName: string;
    logoUrl: string;
    imageUrl: string | null;
}

interface Chain {
    id: number;
    name: string;
    logoUrl: string;
}

interface Product {
    id: number;
    name: string;
    imageUrls: (string | null | undefined)[] | string | null;
    categoryId: number;
    minAmount: number | null;
    maxAmount: number | null;
    unit: string | null;
    hasWeighable: boolean;
    canonicalUnit: string | null;
    canonicalStep: number | null;
    canonicalFamily: 'fluid' | 'count' | null;
}

// Fixed chart footprint — never scales with the system font, so large-font
// devices keep the same graph width and the text gets the rest of the card.
const MINI_CHART_WIDTH = 70;
const MINI_CHART_HEIGHT = 64;

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const MODAL_CHART_HEIGHT = 260;
// Modal chart's min width fits the card (screen width minus outer padding)
// so very short histories don't look squished. Longer histories grow the
// SVG width horizontally, and the parent ScrollView handles the overflow.
const MODAL_CHART_MIN_WIDTH = SCREEN_WIDTH - 80;

const shortDate = (d: string) =>
    formatDate(d, { month: 'short', day: 'numeric' });

// Must stay in sync with MODAL_CHART_PADDING in MiniPriceChart.tsx for hit-test math.
const MODAL_CHART_PADDING = { top: 14, bottom: 18, left: 46, right: 10 };

function ModalChart({
    prices,
    colors,
    styles,
}: {
    prices: PricePoint[];
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
}) {
    const { t } = useTranslation();
    const [rangeKey, setRangeKey] = useState<RangeKey>('all');
    const [crosshairIndex, setCrosshairIndex] = useState<number | null>(null);
    const crosshairTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const allData = useMemo(() => preparePriceData(prices), [prices]);
    const data = useMemo(() => filterByRange(allData, rangeKey), [allData, rangeKey]);

    const chartWidth = MODAL_CHART_MIN_WIDTH;

    // Compute point X positions for gesture hit-testing (must match PriceChartSvg math)
    const padding = MODAL_CHART_PADDING;
    const chartW = chartWidth - padding.left - padding.right;
    const pointXs = useMemo(() => data.map((_, i) =>
        data.length === 1
            ? padding.left + chartW / 2
            : padding.left + (i / (data.length - 1)) * chartW
    ), [data, chartW]);

    const handleChartTouch = (x: number) => {
        if (!pointXs.length) return;
        let nearest = 0, minDist = Infinity;
        pointXs.forEach((px, i) => { const d = Math.abs(px - x); if (d < minDist) { minDist = d; nearest = i; } });
        setCrosshairIndex(nearest);
        if (crosshairTimer.current) clearTimeout(crosshairTimer.current);
        crosshairTimer.current = setTimeout(() => setCrosshairIndex(null), 3000);
    };

    // Show crosshair point or last point
    const displayIndex = crosshairIndex ?? (data.length > 0 ? data.length - 1 : null);
    const displayPt = displayIndex !== null ? data[displayIndex] : null;

    const RANGE_LABELS: Record<RangeKey, string> = { '1M': '1M', '3M': '3M', '6M': '6M', 'all': t('product.rangeAll') };

    if (data.length === 0) {
        return (
            <View style={styles.chartModalEmpty}>
                <Text style={styles.chartModalEmptyText}>{t('product.noDataForPeriod')}</Text>
            </View>
        );
    }

    return (
        <>
            {/* Price display row */}
            {displayPt && (
                <View style={styles.chartPriceDisplay}>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                        {displayPt.promoPrice !== null && displayPt.promoPrice !== undefined ? (
                            <>
                                <Text style={styles.chartDisplayPromo}>
                                    {formatEuro(Number(displayPt.promoPrice))}
                                </Text>
                                <Text style={styles.chartDisplayStrike}>
                                    {formatEuro(Number(displayPt.price))}
                                </Text>
                            </>
                        ) : (
                            <Text style={styles.chartDisplayPrice}>
                                {formatEuro(Number(displayPt.price))}
                            </Text>
                        )}
                    </View>
                    <Text style={styles.chartDisplayDate}>{shortDate(displayPt.date)}</Text>
                </View>
            )}

            {/* Range pills */}
            <View style={styles.rangePills}>
                {(['1M', '3M', '6M', 'all'] as RangeKey[]).map(key => (
                    <TouchableOpacity
                        key={key}
                        style={[styles.rangePill, rangeKey === key && styles.rangePillActive]}
                        onPress={() => { setRangeKey(key); setCrosshairIndex(null); }}
                    >
                        <Text style={[styles.rangePillText, rangeKey === key && styles.rangePillTextActive]}>
                            {RANGE_LABELS[key]}
                        </Text>
                    </TouchableOpacity>
                ))}
            </View>

            {/* Chart */}
            <View style={{ width: chartWidth, height: MODAL_CHART_HEIGHT }}>
                <PriceChartSvg
                    data={data}
                    width={chartWidth}
                    height={MODAL_CHART_HEIGHT}
                    colors={colors}
                    isModal={true}
                    activePtIndex={crosshairIndex}
                    shortDate={shortDate}
                    formatEuro={formatEuro}
                />
                <View
                    style={{ position: 'absolute', top: 0, left: 0, width: chartWidth, height: MODAL_CHART_HEIGHT }}
                    onStartShouldSetResponder={() => true}
                    onMoveShouldSetResponder={() => true}
                    onResponderGrant={e => handleChartTouch(e.nativeEvent.locationX)}
                    onResponderMove={e => handleChartTouch(e.nativeEvent.locationX)}
                />
            </View>

            {/* Legend */}
            <View style={styles.chartModalFooter}>
                <View style={styles.chartModalLegend}>
                    <View style={styles.chartModalLegendItem}>
                        <View style={[styles.chartModalLegendDot, { backgroundColor: colors.textSecondary }]} />
                        <Text style={styles.chartModalLegendLabel}>{t('product.regularPrice')}</Text>
                    </View>
                    <View style={styles.chartModalLegendItem}>
                        <View style={[styles.chartModalLegendDot, { backgroundColor: colors.primary }]} />
                        <Text style={styles.chartModalLegendLabel}>{t('product.promoPrice')}</Text>
                    </View>
                </View>
            </View>
        </>
    );
}

export default function ProductDetailScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { id, templateId: rawTemplateId } =
        useLocalSearchParams<{ id: string; templateId?: string }>();
    const templateId = rawTemplateId != null && rawTemplateId.length > 0 ? Number(rawTemplateId) : null;
    const isTemplateMode = templateId != null && Number.isFinite(templateId);
    const [product, setProduct] = useState<Product | null>(null);
    const [categoryParts, setCategoryParts] = useState<string[]>([]);
    const [storeProducts, setStoreProducts] = useState<StoreProduct[]>([]);
    const [allChains, setAllChains] = useState<Chain[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedChainId, setSelectedChainId] = useState<number | null>(null);
    const [priceCache, setPriceCache] = useState<{ [key: string]: PricePoint[] }>({});
    const [chartModalSp, setChartModalSp] = useState<StoreProduct | null>(null);
    const [isAdding, setIsAdding] = useState(false);
    const [basketQuantity, setBasketQuantity] = useState(0);
    const [amountModalVisible, setAmountModalVisible] = useState(false);
    const { mode, ready: prefReady } = useDisplayMode();
    const { draftBasketId, setDraftBasketId } = useBasketState();
    const templateItems = useTemplateAddState(s => s.items);
    const templateAdd = useTemplateAddState(s => s.add);
    const templateSetQty = useTemplateAddState(s => s.setQuantity);
    const templateEntry = useMemo(
        () => (isTemplateMode ? templateItems.find(i => i.productId === Number(id)) : undefined),
        [isTemplateMode, templateItems, id],
    );
    const templateQuantity = templateEntry?.quantity ?? 0;
    const { bottom: bottomInset } = useSafeAreaInsets();
    // Collapsing header: title+breadcrumb hide on scroll, store filter stays pinned.
    const header = useCollapsingHeader();
    const draftBasketIdRef = useRef(draftBasketId);
    useEffect(() => { draftBasketIdRef.current = draftBasketId; }, [draftBasketId]);

    useEffect(() => {
        fetch(`${API_BASE_URL}/api/chains`)
            .then(r => r.json())
            .then(data => setAllChains(Array.isArray(data) ? data : []))
            .catch(() => {});
    }, []);

    // Get chains for tabs: use DB-sourced logos from /api/chains as the base,
    // filled in by storeProducts for any chain the API hasn't returned yet.
    const chains = useMemo(() => {
        const chainMap = new Map<number, Chain>();
        allChains.forEach(c => chainMap.set(c.id, c));
        storeProducts.forEach(sp => {
            if (!chainMap.has(sp.chainId)) {
                chainMap.set(sp.chainId, { id: sp.chainId, name: sp.chainName, logoUrl: sp.logoUrl });
            }
        });
        return [1, 2, 3, 4, 5].flatMap(id => {
            const c = chainMap.get(id);
            const hasProducts = storeProducts.some(sp => sp.chainId === id);
            return c && hasProducts ? [c] : [];
        });
    }, [allChains, storeProducts]);

    const filteredStoreProducts = useMemo(() => {
        if (!selectedChainId) return storeProducts;
        return storeProducts.filter(sp => sp.chainId === selectedChainId);
    }, [storeProducts, selectedChainId]);

    // Fetch product and store products
    useEffect(() => {
        if (!prefReady) return; // wait for AsyncStorage-backed mode load
        const fetchData = async () => {
            setLoading(true);
            try {
                // In base mode, the SP fetch returns the whole cluster
                // (head + all variants) so chain tabs + the list below show
                // every variant side-by-side. In sku mode it's exactly this
                // Product's SPs, same as pre-Phase-1.
                // userId personalises the SP set to this user's equivalence
                // component (unions swiped-equivalent SPs, incl. 688 orphans).
                const userId = await getUserId();
                const [prodRes, spRes] = await Promise.all([
                    fetch(`${API_BASE_URL}/api/products/${id}`),
                    fetch(`${API_BASE_URL}/api/store-products/product/${id}?mode=${mode}&userId=${encodeURIComponent(userId)}`),
                ]);
                const prodData = await prodRes.json();
                const spData = await spRes.json();
                setProduct(prodData);
                setStoreProducts(Array.isArray(spData) ? spData : []);
                if (prodData?.categoryId) {
                    fetch(`${API_BASE_URL}/api/categories/${prodData.categoryId}/path`)
                        .then(r => r.json())
                        .then(({ path }) => {
                            if (typeof path === 'string') setCategoryParts(path.split(' > '));
                        })
                        .catch(() => {});
                }
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [id, mode, prefReady]);

    // Fetch price history for visible store products
    useEffect(() => {
        const fetchPrices = async () => {
            for (const sp of filteredStoreProducts) {
                const cacheKey = `${sp.id}-all`;
                if (priceCache[cacheKey]) continue;
                try {
                    const res = await fetch(`${API_BASE_URL}/api/prices/store-product/${sp.id}/history`);
                    const data = await res.json();
                    setPriceCache(prev => ({ ...prev, [cacheKey]: Array.isArray(data) ? data : [] }));
                } catch {
                    setPriceCache(prev => ({ ...prev, [cacheKey]: [] }));
                }
            }
        };
        if (filteredStoreProducts.length > 0) fetchPrices();
    }, [filteredStoreProducts]);

    const getPricesForSp = (spId: number): PricePoint[] => priceCache[`${spId}-all`] || [];

    // Template mode renders a return banner below the add bar, eating
    // another ~64pt of bottom space the ScrollView needs to clear so the
    // final SP card isn't hidden under the stack.
    const BAR_HEIGHT = isTemplateMode ? 132 : 64;

    const fetchBasketQty = useCallback(() => {
        const bid = useBasketState.getState().draftBasketId;
        if (!bid) { setBasketQuantity(0); return; }
        fetch(`${API_BASE_URL}/api/baskets/${bid}/items`)
            .then(r => r.json())
            .then((items: any[]) => {
                if (!Array.isArray(items)) return;
                const found = items.find((i: any) => i.productId === Number(id));
                setBasketQuantity(found ? parseFloat(found.quantity) : 0);
            })
            .catch(() => {});
    }, [id]);

    useFocusEffect(useCallback(() => { fetchBasketQty(); }, [fetchBasketQty]));

    const handleAdd = useCallback(() => {
        if (!product || isAdding) return;
        const hasRange = product.minAmount !== null && product.maxAmount !== null
            && product.minAmount !== product.maxAmount;
        if (hasRange || !!product.hasWeighable) {
            setAmountModalVisible(true);
            return;
        }
        const qty = resolveCanonicalStep(product);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setIsAdding(true);
        if (isTemplateMode && templateId != null) {
            templateAdd(product.id, qty)
                .catch(() => {})
                .finally(() => setIsAdding(false));
            return;
        }
        addProductToBasket(product.id, draftBasketId, setDraftBasketId, qty, mode)
            .then(result => { if (result.success) setBasketQuantity(qty); })
            .finally(() => setIsAdding(false));
    }, [product, isAdding, draftBasketId, mode, isTemplateMode, templateId, templateAdd]);

    const handleTemplateDecrement = useCallback(() => {
        if (!product) return;
        const step = resolveCanonicalStep(product);
        const next = Math.max(0, Math.round((templateQuantity - step) / step) * step);
        templateSetQty(product.id, next).catch(() => {});
    }, [product, templateQuantity, templateSetQty]);

    const handleTemplateIncrement = useCallback(() => {
        if (!product) return;
        const step = resolveCanonicalStep(product);
        const next = Math.round((templateQuantity + step) / step) * step;
        templateSetQty(product.id, next).catch(() => {});
    }, [product, templateQuantity, templateSetQty]);

    const handleDecrement = useCallback(() => {
        if (!product) return;
        const step = resolveCanonicalStep(product);
        const newQty = Math.round((basketQuantity - step) / step) * step;
        const bid = draftBasketIdRef.current;
        if (newQty <= 0) {
            setBasketQuantity(0);
            if (!bid) return;
            fetch(`${API_BASE_URL}/api/baskets/${bid}/items`).then(r => r.json()).then(async (all: any[]) => {
                const found = Array.isArray(all) ? all.find((i: any) => i.productId === product.id) : null;
                if (found) await fetch(`${API_BASE_URL}/api/basket-items/${found.id}`, { method: 'DELETE' });
                const remaining = Array.isArray(all) ? all.filter((i: any) => i.id !== found?.id) : [];
                if (remaining.length === 0) {
                    await fetch(`${API_BASE_URL}/api/baskets/${bid}`, { method: 'DELETE' });
                    setDraftBasketId(null);
                }
            }).catch(() => {});
        } else {
            setBasketQuantity(newQty);
            if (!bid) return;
            fetch(`${API_BASE_URL}/api/baskets/${bid}/items`).then(r => r.json()).then(async (all: any[]) => {
                const found = Array.isArray(all) ? all.find((i: any) => i.productId === product.id) : null;
                if (found) await fetch(`${API_BASE_URL}/api/basket-items/${found.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ quantity: newQty }),
                });
            }).catch(() => {});
        }
    }, [product, basketQuantity, setDraftBasketId]);

    const handleIncrement = useCallback(() => {
        if (!product) return;
        const step = resolveCanonicalStep(product);
        const newQty = Math.round((basketQuantity + step) / step) * step;
        const bid = draftBasketIdRef.current;
        setBasketQuantity(newQty);
        if (!bid) return;
        fetch(`${API_BASE_URL}/api/baskets/${bid}/items`).then(r => r.json()).then(async (all: any[]) => {
            const found = Array.isArray(all) ? all.find((i: any) => i.productId === product.id) : null;
            if (found) await fetch(`${API_BASE_URL}/api/basket-items/${found.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity: newQty }),
            });
        }).catch(() => {});
    }, [product, basketQuantity]);

    if (loading) return (
        <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, gap: 10 }}>
            <View style={{ backgroundColor: colors.cardBackground, borderRadius: radius.lg, padding: 16, gap: 10 }}>
                {Array.from({ length: 4 }).map((_, i) => (
                    <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                        <SkeletonBox width={52} height={52} borderRadius={8} />
                        <View style={{ flex: 1, gap: 6 }}>
                            <SkeletonBox width={140} height={12} borderRadius={5} />
                            <SkeletonBox width={80} height={11} borderRadius={5} />
                            <SkeletonBox width={60} height={13} borderRadius={5} />
                        </View>
                        <SkeletonBox width={MINI_CHART_WIDTH} height={MINI_CHART_HEIGHT} borderRadius={6} />
                    </View>
                ))}
            </View>
        </ScrollView>
    );
    if (!product) return <Text style={styles.centered}>Produktas nerastas</Text>;

    return (
        <>
            {/* Glass back bar; title + breadcrumb collapse on scroll; filter pinned. */}
            <CollapsingHeader
                controller={header}
                background={colors.cardBackground}
                back
                collapsing={
                    <ScreenHeading
                        title={product.name}
                        subtitle={categoryParts.length > 0 ? (
                            <View style={styles.breadcrumbRow}>
                                {categoryParts.map((part, i) => (
                                    <React.Fragment key={i}>
                                        {i > 0 && <Text style={styles.navBreadcrumbSep}>›</Text>}
                                        <Text style={styles.navBreadcrumbPart} numberOfLines={1}>{part}</Text>
                                    </React.Fragment>
                                ))}
                            </View>
                        ) : undefined}
                    />
                }
                pinned={
                    <ChainFilterBar
                        chains={chains}
                        selectedId={selectedChainId}
                        onSelect={setSelectedChainId}
                        allLabel={t('product.allStores')}
                    />
                }
            />
            {/* Only the SP list scrolls / rubber-bands; paddingTop reserves the
                overlay's space (the opaque overlay hides the brief measure jump). */}
            <Animated.ScrollView
                {...header.scroll}
                style={styles.container}
                contentContainerStyle={{ paddingTop: header.paddingTop, paddingBottom: BAR_HEIGHT + 16 }}
            >

                {/* StoreProduct list */}
                {filteredStoreProducts.length === 0 ? (
                    <View style={styles.emptyContainer}>
                        <Ionicons name="alert-circle-outline" size={40} color={colors.border} />
                        <Text style={styles.emptyText}>{t('product.notAvailable')}</Text>
                    </View>
                ) : (
                    filteredStoreProducts.map(sp => {
                        const prices = getPricesForSp(sp.id);
                        const latestPrice = prices.length > 0
                            ? prices[prices.length - 1]
                            : null;
                        const amountStr = formatAmountStr(sp.amount, sp.unit, !!sp.isWeighable);

                        return (
                            <View key={sp.id} style={styles.spCard}>
                                <View style={styles.spLeft}>
                                    <ProductImage
                                        uris={[sp.imageUrl]}
                                        imageStyle={styles.spImage}
                                        placeholderStyle={styles.spImagePlaceholder}
                                        emojiStyle={styles.spImageEmoji}
                                    />

                                    <View style={styles.spInfo}>
                                        <Text style={styles.spName} numberOfLines={2}>{sp.storeProductName}</Text>
                                        {amountStr ? <Text style={styles.spAmount}>{amountStr}</Text> : null}
                                        {latestPrice && (
                                            <View style={styles.priceRow}>
                                                <Text style={[
                                                    styles.spPrice,
                                                    latestPrice.promoPrice != null && styles.spPriceStrike,
                                                ]}>
                                                    {formatEuro(Number(latestPrice.price))}
                                                </Text>
                                                {latestPrice.promoPrice && (
                                                    <Text style={styles.spPromoPrice}>
                                                        {formatEuro(Number(latestPrice.promoPrice))}
                                                    </Text>
                                                )}
                                            </View>
                                        )}
                                    </View>
                                </View>
                                <View style={styles.spRight}>
                                    <MiniPriceChart
                                        prices={prices}
                                        width={MINI_CHART_WIDTH}
                                        height={MINI_CHART_HEIGHT}
                                        onTap={() => setChartModalSp(sp)}
                                    />
                                </View>
                                <ChainLogoStrip
                                    chainLogos={[{ chainId: sp.chainId, logoUrl: getChainMiniLogoUrl(sp.chainId, sp.logoUrl) }]}
                                    style={{ position: 'absolute', top: 12, left: 12, transform: [{ scale: 0.7 }], transformOrigin: 'top left', backgroundColor: 'transparent', paddingHorizontal: 0, paddingVertical: 0, shadowOpacity: 0, elevation: 0 }}
                                />
                            </View>
                        );
                    })
                )}
                <View style={{ height: 40 }} />
            </Animated.ScrollView>

            {/* Sticky add-to bar. Template mode shows a +/− stepper for
                products already in the template (so users tweak amount
                from the product detail without bouncing back to the
                editor); otherwise the primary "Į šabloną" CTA. Basket
                mode keeps the pre-existing QuantityControl ↔ "Į krepšelį"
                toggle untouched. */}
            <View style={[styles.addBar, { paddingBottom: isTemplateMode ? 12 : (bottomInset || 12) }]}>
                {isTemplateMode && templateQuantity > 0 ? (
                    <QuantityControl
                        quantity={templateQuantity}
                        onDecrement={handleTemplateDecrement}
                        onIncrement={handleTemplateIncrement}
                        unit={resolveDisplayUnit(product)}
                        size="large"
                        style={{ width: '100%' }}
                    />
                ) : isTemplateMode ? (
                    <TouchableOpacity
                        style={[styles.addButton, isAdding && styles.addButtonDone]}
                        onPress={handleAdd}
                        disabled={isAdding}
                        activeOpacity={0.8}
                    >
                        {isAdding
                            ? <MaterialProgress size="small" color="#fff" />
                            : <Ionicons name="albums-outline" size={20} color="#fff" />}
                        <Text style={styles.addButtonText}>{t('basketTab.templates.addToTemplate')}</Text>
                    </TouchableOpacity>
                ) : basketQuantity > 0 ? (
                    <QuantityControl
                        quantity={basketQuantity}
                        onDecrement={handleDecrement}
                        onIncrement={handleIncrement}
                        unit={resolveDisplayUnit(product)}
                        size="large"
                        style={{ width: '100%' }}
                    />
                ) : (
                    <TouchableOpacity
                        style={[styles.addButton, isAdding && styles.addButtonDone]}
                        onPress={handleAdd}
                        disabled={isAdding}
                        activeOpacity={0.8}
                    >
                        {isAdding
                            ? <MaterialProgress size="small" color="#fff" />
                            : <Ionicons name="cart-outline" size={20} color="#fff" />}
                        <Text style={styles.addButtonText}>{t('product.addToBasket')}</Text>
                    </TouchableOpacity>
                )}
            </View>
            {isTemplateMode && templateId != null && (
                <TemplateReturnBanner templateId={templateId} />
            )}

            <AmountPickerModal
                visible={amountModalVisible}
                productName={product.name}
                canonicalUnit={product.canonicalUnit}
                canonicalStep={product.canonicalStep}
                canonicalFamily={product.canonicalFamily}
                minAmount={product.minAmount ?? 0}
                maxAmount={product.maxAmount ?? 0}
                unit={product.unit ?? 'g'}
                isWeighable={!!product.hasWeighable}
                onCancel={() => setAmountModalVisible(false)}
                onConfirm={async (amount) => {
                    setAmountModalVisible(false);
                    setIsAdding(true);
                    if (isTemplateMode && templateId != null) {
                        try {
                            // Picker is the "set absolute quantity" surface
                            // — override any existing row rather than
                            // incrementing (mirrors the template editor's
                            // per-row input).
                            if (templateEntry) {
                                await templateSetQty(product.id, amount);
                            } else {
                                await templateAdd(product.id, amount);
                            }
                        } catch {
                            // Swallow; template detail screen will reflect
                            // server truth on next focus.
                        } finally {
                            setIsAdding(false);
                        }
                        return;
                    }
                    const result = await addProductToBasket(product.id, draftBasketId, setDraftBasketId, amount, mode);
                    setIsAdding(false);
                    if (result.success) setBasketQuantity(amount);
                }}
            />

            <Modal
                visible={chartModalSp !== null}
                transparent
                animationType="fade"
                onRequestClose={() => setChartModalSp(null)}
            >
                <TouchableOpacity
                    style={styles.chartModalBackdrop}
                    activeOpacity={1}
                    onPress={() => setChartModalSp(null)}
                >
                    <TouchableOpacity
                        style={styles.chartModalCard}
                        activeOpacity={1}
                        onPress={() => {}}
                    >
                        <Text style={styles.chartModalTitle} numberOfLines={2}>
                            {chartModalSp?.storeProductName}
                        </Text>
                        <Text style={styles.chartModalSub}>{t('product.priceHistory')}</Text>
                        {chartModalSp && (() => {
                            const prices = getPricesForSp(chartModalSp.id);
                            const allData = preparePriceData(prices);
                            if (!allData.length) {
                                return (
                                    <View style={styles.chartModalEmpty}>
                                        <Ionicons name="analytics-outline" size={28} color={colors.border} />
                                        <Text style={styles.chartModalEmptyText}>{t('product.priceHistoryEmpty')}</Text>
                                    </View>
                                );
                            }
                            return <ModalChart prices={prices} colors={colors} styles={styles} />;
                        })()}
                    </TouchableOpacity>
                </TouchableOpacity>
            </Modal>
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },

    breadcrumbRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    navBreadcrumbSep: { fontSize: 10, color: c.textMuted },
    navBreadcrumbPart: { fontSize: 11, color: c.textMuted, flexShrink: 1, minWidth: 16 },

    // StoreProduct cards
    spCard: {
        flexDirection: 'row',
        backgroundColor: c.cardBackground,
        marginHorizontal: 16,
        marginTop: 10,
        borderRadius: radius.lg,
        padding: 12,
        ...elevation.level1,
    },
    spLeft: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        gap: 10,
    },
    spImage: {
        width: 52,
        height: 52,
        borderRadius: radius.md,
    },
    spImagePlaceholder: {
        width: 52,
        height: 52,
        borderRadius: radius.md,
        backgroundColor: c.surfaceSubtle,
        alignItems: 'center',
        justifyContent: 'center',
    },
    spImageEmoji: {
        fontSize: 28,
        opacity: 0.4,
    },
    spInfo: {
        flex: 1,
        minWidth: 0,
        justifyContent: 'center',
    },
    spName: {
        fontSize: 13,
        color: c.textPrimary,
        fontWeight: '500',
        lineHeight: 18,
    },
    spAmount: {
        fontSize: 12,
        color: c.textMuted,
        marginTop: 2,
    },
    priceRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        alignItems: 'center',
        marginTop: 3,
    },
    spPrice: {
        fontSize: 14,
        fontWeight: '700',
        color: c.textPrimary,
    },
    spPriceStrike: {
        textDecorationLine: 'line-through',
        color: c.textMuted,
        fontWeight: '400',
        fontSize: 12,
    },
    spPromoPrice: {
        fontSize: 14,
        fontWeight: '700',
        color: c.primary,
    },
    spRight: {
        width: MINI_CHART_WIDTH,
        flexShrink: 0,
        justifyContent: 'center',
        alignItems: 'center',
    },

    // Chart
    chartPrice: {
        fontSize: 11,
        color: c.primary,
        fontWeight: '600',
        marginTop: 2,
    },
    chartPriceStack: {
        alignItems: 'center',
        marginTop: 2,
        gap: 1,
    },
    chartPriceStrike: {
        fontSize: 10,
        color: c.textMuted,
        textDecorationLine: 'line-through',
    },
    chartPricePromo: {
        fontSize: 12,
        color: c.primary,
        fontWeight: '700',
    },
    // Chart modal (tap-to-expand)
    chartModalBackdrop: {
        flex: 1,
        backgroundColor: c.overlayBackdrop,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    chartModalCard: {
        backgroundColor: c.cardBackground,
        borderRadius: radius.xl,
        padding: 20,
        width: '100%',
        maxWidth: 480,
        ...elevation.level3,
    },
    chartModalTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: c.textPrimary,
    },
    chartModalSub: {
        fontSize: 12,
        color: c.textSecondary,
        marginTop: 2,
        marginBottom: 12,
    },
    chartModalEmpty: {
        height: MODAL_CHART_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
    },
    chartModalEmptyText: {
        fontSize: 13,
        color: c.textMuted,
    },
    chartModalFooter: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 12,
    },
    chartModalLegend: {
        flexDirection: 'row',
        gap: 14,
    },
    chartModalLegendItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    chartModalLegendDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    chartModalLegendLabel: {
        fontSize: 12,
        color: c.textSecondary,
        fontWeight: '500',
    },
    chartModalPriceStack: {
        alignItems: 'flex-end',
    },
    chartModalLastPrice: {
        fontSize: 16,
        fontWeight: '700',
        color: c.primary,
    },

    // Empty
    emptyContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        padding: 48,
        gap: 12,
    },
    emptyText: {
        fontSize: 14,
        color: c.textMuted,
        textAlign: 'center',
    },

    // Range pills
    rangePills: {
        flexDirection: 'row',
        gap: 6,
        marginBottom: 10,
    },
    rangePill: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: radius.pill,
        backgroundColor: c.softAccent,
    },
    rangePillActive: {
        backgroundColor: c.primary,
    },
    rangePillText: {
        fontSize: 12,
        fontWeight: '500',
        color: c.textSecondary,
    },
    rangePillTextActive: {
        color: c.onPrimary,
    },
    // Chart price display (above range pills)
    chartPriceDisplay: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginBottom: 8,
    },
    chartDisplayPrice: {
        fontSize: 22,
        fontWeight: '700',
        color: c.textPrimary,
    },
    chartDisplayPromo: {
        fontSize: 22,
        fontWeight: '700',
        color: c.primary,
    },
    chartDisplayStrike: {
        fontSize: 14,
        color: c.textMuted,
        textDecorationLine: 'line-through',
    },
    chartDisplayDate: {
        fontSize: 12,
        color: c.textMuted,
    },

    // Bottom add-to-basket bar
    addBar: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: c.cardBackground,
        borderTopLeftRadius: radius.lg,
        borderTopRightRadius: radius.lg,
        ...elevation.level3,
        paddingHorizontal: 16,
        paddingTop: 10,
    },
    addButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: c.primary,
        borderRadius: radius.pill,
        paddingVertical: 14,
    },
    addButtonDone: {
        opacity: 0.75,
    },
    addButtonText: {
        fontSize: 15,
        fontWeight: '700',
        color: '#fff',
    },
});