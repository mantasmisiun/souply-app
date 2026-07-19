import {
    View,
    Text,
    ScrollView,
    TouchableOpacity,
    StyleSheet,
    Modal,
    Dimensions,
 Animated as RNAnimated } from "react-native";
import Animated from 'react-native-reanimated';
import { useCollapsingHeader, CollapsingHeader } from '@/components/CollapsingHeader';
import { SkeletonBox } from '@/components/SkeletonBox';
import { ProductImage } from '@/components/ProductImage';
import React, { useEffect, useLayoutEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE_URL } from '@/config/api';
import { getUserId } from '@/config/user';
import { useTheme, radius, elevation, type AppTheme } from '@/constants/theme';
import MiniPriceChart, { PriceChartSvg, type PricePoint, preparePriceData, timeXPositions } from '@/components/MiniPriceChart';
import { useDisplayMode } from '@/contexts/DisplayPreferenceContext';
import { useTranslation } from 'react-i18next';
import { formatDate, formatEuro, formatAmountStr } from '@/utils/formatCurrency';
import { ChainFilterBar } from '@/components/ChainFilterBar';
import { ChainLogoStrip } from '@/components/ChainLogoStrip';
import { getChainMiniLogoUrl } from '@/utils/chainBrandName';
import { addProductToBasket } from '@/utils/basketUtils';
import { useTemplateAddState } from '@/state/templateAddState';
import { useBasketState } from '@/state/basketState';
import { useBasketSession } from '@/state/basketSession';
import { AddOrStepper } from '@/components/AddOrStepper';
import { ScreenHeading } from '@/components/ScreenHeading';

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
const MODAL_CHART_PADDING = { top: 14, bottom: 34, left: 0, right: 0 };

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
    const [crosshairIndex, setCrosshairIndex] = useState<number | null>(null);
    const crosshairTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);

    const allData = useMemo(() => preparePriceData(prices), [prices]);

    // ── ONE MONTH AT A TIME ──────────────────────────────────────────────
    const now = new Date();
    const nowYm = now.getFullYear() * 12 + now.getMonth();
    const firstYm = useMemo(() => {
        if (!allData.length) return nowYm;
        const d = new Date(allData[0].date);
        return d.getFullYear() * 12 + d.getMonth();
    }, [allData, nowYm]);
    const [viewYm, setViewYm] = useState(nowYm);
    const [pickerYear, setPickerYear] = useState(now.getFullYear());
    const shiftMonth = (d: 1 | -1) => {
        setViewYm(ym => Math.max(firstYm, Math.min(nowYm, ym + d)));
        setCrosshairIndex(null);
    };
    const viewYear = Math.floor(viewYm / 12);
    const viewMonth = viewYm % 12;
    const monthLabel = formatDate(new Date(viewYear, viewMonth, 1), { month: 'long', year: 'numeric' });

    // Fixed y-scale: top = the product's all-time maximum, bottom = 0 — every
    // month renders on the identical scale.
    const yMax = useMemo(() => Math.max(0, ...allData.map(p => Number(p.price) || 0)), [allData]);

    // Build one month's view: in-month points + a virtual CARRY-IN of the last
    // pre-month point (the price known when the month began). Its promo rides
    // along only if it was still running at the month's start — the chart's
    // promoEnd logic then ends it at the right date inside the month.
    const buildMonth = useCallback((ym: number) => {
        const y = Math.floor(ym / 12), m = ym % 12;
        const start = new Date(y, m, 1).getTime();
        const endRaw = new Date(y, m + 1, 1).getTime();
        const end = Math.min(endRaw, Date.now());
        const inMonth = allData.filter(pt => {
            const tp = new Date(pt.date).getTime();
            return tp >= start && tp < endRaw;
        });
        const prev = [...allData].reverse().find(pt => new Date(pt.date).getTime() < start);
        if (!prev) return { data: inMonth, window: { start, end } };
        const promoAlive = prev.promoPrice != null &&
            (prev.promoEnd == null || new Date(prev.promoEnd).getTime() > start);
        const carryIn: PricePoint = {
            ...prev,
            date: new Date(start).toISOString(),
            promoPrice: promoAlive ? prev.promoPrice : null,
            promoEnd: promoAlive ? prev.promoEnd : null,
            virtual: true,
        };
        return { data: [carryIn, ...inMonth], window: { start, end } };
    }, [allData]);
    // Three panes so a pan FOLLOWS THE FINGER, showing the neighbour month's data
    // as it slides in (not a discrete pop on release).
    const monthCur = useMemo(() => buildMonth(viewYm), [buildMonth, viewYm]);
    const monthPrev = useMemo(() => buildMonth(viewYm - 1), [buildMonth, viewYm]);
    const monthNext = useMemo(() => buildMonth(viewYm + 1), [buildMonth, viewYm]);
    const data = monthCur.data;
    const chartWindow = monthCur.window;
    const windowEnd = chartWindow.end;

    const chartWidth = MODAL_CHART_MIN_WIDTH;
    // Fixed right gutter for the CURRENT price labels — outside the pan strip, so
    // panning never drags the axis labels along.
    const GUTTER = 44;
    const paneWidth = chartWidth - GUTTER;
    // Origin distance between adjacent panes: plot areas butt together (each pane's
    // left padding lands exactly on the neighbour's right padding), so a pan shows
    // one CONTINUOUS line across the month boundary — no dead gap.
    const paneStep = paneWidth - (MODAL_CHART_PADDING.left + MODAL_CHART_PADDING.right);

    // Compute point X positions for gesture hit-testing (must match PriceChartSvg math)
    const padding = MODAL_CHART_PADDING;
    const chartW = paneWidth - padding.left - padding.right;
    // Same TIME-scaled positions the SVG draws (month window domain) — the
    // crosshair must hit-test against where the points actually are.
    const pointXs = useMemo(() => timeXPositions(data, chartW, padding.left, chartWindow),
        [data, chartW, chartWindow.start, chartWindow.end]);

    const handleChartTouch = (x: number) => {
        if (!pointXs.length) return;
        let nearest = 0, minDist = Infinity;
        pointXs.forEach((px, i) => { const d = Math.abs(px - x); if (d < minDist) { minDist = d; nearest = i; } });
        setCrosshairIndex(nearest);
        if (crosshairTimer.current) clearTimeout(crosshairTimer.current);
        crosshairTimer.current = setTimeout(() => setCrosshairIndex(null), 3000);
    };
    // GESTURE INTENT: an immediate horizontal pull is a PAN (the chart follows the
    // finger, neighbour month sliding in); touch-and-hold (or a tap) is a SCRUB.
    // Once decided, the gesture keeps its mode.
    const panX = useRef(new RNAnimated.Value(0)).current;
    const gestureRef = useRef<{ x0: number; t0: number; mode: 'undecided' | 'pan' | 'scrub' } | null>(null);
    const animatingRef = useRef(false);
    // Commit AFTER the slide: the strip stays parked at ±paneStep until the new month
    // renders; the effect below then recenters it in the same commit — without this
    // the old month flashed at center for a frame between setValue(0) and React's
    // re-render.
    const settlePan = (target: number, after?: () => void) => {
        animatingRef.current = true;
        RNAnimated.timing(panX, { toValue: target, duration: 180, useNativeDriver: true }).start(() => {
            if (after) after();
            else { panX.setValue(0); animatingRef.current = false; }
        });
    };
    useLayoutEffect(() => {
        panX.setValue(0);
        animatingRef.current = false;
    }, [viewYm, panX]);
    // The ‹ › buttons ride the same slide animation as a pan.
    const slideToMonth = (d: 1 | -1) => {
        if (animatingRef.current) return;
        if (d === 1 && viewYm >= nowYm) return;
        if (d === -1 && viewYm <= firstYm) return;
        settlePan(-d * paneStep, () => shiftMonth(d));
    };
    const handleTouchStart = (x: number) => {
        gestureRef.current = { x0: x, t0: Date.now(), mode: 'undecided' };
    };
    const handleTouchMove = (x: number) => {
        const g = gestureRef.current;
        if (!g) return;
        const dx = x - g.x0;
        if (g.mode === 'undecided') {
            if (Math.abs(dx) > 12) g.mode = 'pan';
            else if (Date.now() - g.t0 > 160) g.mode = 'scrub';
            else return;
        }
        if (g.mode === 'pan') {
            // Rubber-band at the data bounds instead of sliding into nothing.
            let d = dx;
            if (d > 0 && viewYm <= firstYm) d = d * 0.25;
            if (d < 0 && viewYm >= nowYm) d = d * 0.25;
            panX.setValue(d);
            if (crosshairIndex !== null) setCrosshairIndex(null);
        } else {
            handleChartTouch(x);
        }
    };
    const handleTouchEnd = (x: number) => {
        const g = gestureRef.current;
        gestureRef.current = null;
        if (!g) return;
        if (g.mode === 'pan') {
            const dx = x - g.x0;
            if (dx < -paneWidth * 0.28 && viewYm < nowYm) settlePan(-paneStep, () => shiftMonth(1));
            else if (dx > paneWidth * 0.28 && viewYm > firstYm) settlePan(paneStep, () => shiftMonth(-1));
            else settlePan(0);
        } else {
            handleChartTouch(x);   // tap, or the scrub's final position
        }
    };

    // Show crosshair point or last point
    const displayIndex = crosshairIndex ?? (data.length > 0 ? data.length - 1 : null);
    const displayPt = displayIndex !== null ? data[displayIndex] : null;
    // The DEFAULT display (no scrub) represents the window's end ("now" for the
    // current month): a promo dead by then must not render as the price.
    // A SCRUBBED historical point keeps its promo — it was running on that date.
    const displayPromoActive = displayPt != null && displayPt.promoPrice != null &&
        (crosshairIndex !== null ||
            displayPt.promoEnd == null || new Date(displayPt.promoEnd).getTime() >= windowEnd);

    if (allData.length === 0) {
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
                        {displayPromoActive ? (
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

            {/* Month navigator: ‹ [month year] › — label opens the year/month picker */}
            <View style={styles.monthNavRow}>
                <TouchableOpacity
                    onPress={() => slideToMonth(-1)}
                    disabled={viewYm <= firstYm}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                    <Ionicons name="chevron-back" size={20}
                        color={viewYm <= firstYm ? colors.border : colors.textSecondary} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setPickerYear(viewYear); setPickerOpen(true); }}>
                    <Text style={styles.monthNavLabel}>{monthLabel}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={() => slideToMonth(1)}
                    disabled={viewYm >= nowYm}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                    <Ionicons name="chevron-forward" size={20}
                        color={viewYm >= nowYm ? colors.border : colors.textSecondary} />
                </TouchableOpacity>
            </View>

            {/* Chart: three contiguous month panes (pan follows the finger) + fixed price gutter */}
            <View style={{ width: chartWidth, height: MODAL_CHART_HEIGHT, flexDirection: 'row' }}>
                <View style={{ width: paneWidth, height: MODAL_CHART_HEIGHT, overflow: 'hidden' }}>
                    <RNAnimated.View
                        style={{
                            flexDirection: 'row',
                            width: paneWidth * 3,
                            marginLeft: -paneStep,
                            transform: [{ translateX: panX }],
                        }}
                    >
                        {[monthPrev, monthCur, monthNext].map((mo, idx) => (
                            <View
                                key={idx}
                                style={{
                                    width: paneWidth,
                                    height: MODAL_CHART_HEIGHT,
                                    marginLeft: idx > 0 ? -(padding.left + padding.right) : 0,
                                }}
                            >
                                {mo.data.length > 0 ? (
                                    <PriceChartSvg
                                        data={mo.data}
                                        width={paneWidth}
                                        height={MODAL_CHART_HEIGHT}
                                        colors={colors}
                                        isModal={true}
                                        activePtIndex={idx === 1 ? crosshairIndex : null}
                                        shortDate={shortDate}
                                        formatEuro={formatEuro}
                                        window={mo.window}
                                        yMax={yMax}
                                        pointDateLabels
                                    />
                                ) : (
                                    <View style={styles.chartModalEmpty}>
                                        <Text style={styles.chartModalEmptyText}>{t('product.noDataForPeriod')}</Text>
                                    </View>
                                )}
                            </View>
                        ))}
                    </RNAnimated.View>
                    <View
                        style={{ position: 'absolute', top: 0, left: 0, width: paneWidth, height: MODAL_CHART_HEIGHT }}
                        onStartShouldSetResponder={() => true}
                        onMoveShouldSetResponder={() => true}
                        onResponderGrant={e => handleTouchStart(e.nativeEvent.locationX)}
                        onResponderMove={e => handleTouchMove(e.nativeEvent.locationX)}
                        onResponderRelease={e => handleTouchEnd(e.nativeEvent.locationX)}
                    />
                </View>
                {/* CURRENT price labels — the month's latest known regular (+ live promo) */}
                <View style={{ width: GUTTER, height: MODAL_CHART_HEIGHT }}>
                    {(() => {
                        const lastPt = data.length > 0 ? data[data.length - 1] : null;
                        if (!lastPt) return null;
                        const chartH = MODAL_CHART_HEIGHT - padding.top - padding.bottom;
                        const hi = yMax > 0 ? yMax * 1.05 : 1;
                        const yFor = (v: number) => padding.top + chartH - (v / hi) * chartH;
                        const promoLive = lastPt.promoPrice != null &&
                            (lastPt.promoEnd == null || new Date(lastPt.promoEnd).getTime() >= windowEnd);
                        return (
                            <>
                                {/* Current-price ring markers — FIXED overlay at the pane edge,
                                    never covered by a sliding pane, never dragged by a pan. */}
                                <View style={[styles.gutterRing, { borderColor: colors.textSecondary, top: yFor(Number(lastPt.price)) - 5 }]} />
                                <View style={[styles.gutterDot, { backgroundColor: colors.textSecondary, top: yFor(Number(lastPt.price)) - 3 }]} />
                                <Text style={[styles.gutterPrice, { color: colors.textSecondary, top: yFor(Number(lastPt.price)) - 7 }]}>
                                    {formatEuro(Number(lastPt.price))}
                                </Text>
                                {promoLive && (
                                    <>
                                        <View style={[styles.gutterRing, { borderColor: colors.primary, top: yFor(Number(lastPt.promoPrice)) - 5 }]} />
                                        <View style={[styles.gutterDot, { backgroundColor: colors.primary, top: yFor(Number(lastPt.promoPrice)) - 3 }]} />
                                        <Text style={[styles.gutterPrice, { color: colors.primary, top: yFor(Number(lastPt.promoPrice)) - 7 }]}>
                                            {formatEuro(Number(lastPt.promoPrice))}
                                        </Text>
                                    </>
                                )}
                            </>
                        );
                    })()}
                </View>
            </View>

            {/* Year + month picker */}
            {pickerOpen && (
                <View style={styles.monthPicker}>
                    <View style={styles.monthPickerYearRow}>
                        <TouchableOpacity onPress={() => setPickerYear(y => y - 1)}
                            disabled={pickerYear <= Math.floor(firstYm / 12)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <Ionicons name="chevron-back" size={18}
                                color={pickerYear <= Math.floor(firstYm / 12) ? colors.border : colors.textSecondary} />
                        </TouchableOpacity>
                        <Text style={styles.monthPickerYear}>{pickerYear}</Text>
                        <TouchableOpacity onPress={() => setPickerYear(y => y + 1)}
                            disabled={pickerYear >= Math.floor(nowYm / 12)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <Ionicons name="chevron-forward" size={18}
                                color={pickerYear >= Math.floor(nowYm / 12) ? colors.border : colors.textSecondary} />
                        </TouchableOpacity>
                    </View>
                    <View style={styles.monthPickerGrid}>
                        {Array.from({ length: 12 }, (_, m) => {
                            const ym = pickerYear * 12 + m;
                            const enabled = ym >= firstYm && ym <= nowYm;
                            const active = ym === viewYm;
                            return (
                                <TouchableOpacity
                                    key={m}
                                    style={[styles.monthPickerCell, active && styles.monthPickerCellActive]}
                                    disabled={!enabled}
                                    onPress={() => { setViewYm(ym); setCrosshairIndex(null); setPickerOpen(false); }}
                                >
                                    <Text style={[
                                        styles.monthPickerCellText,
                                        !enabled && { color: colors.border },
                                        active && styles.monthPickerCellTextActive,
                                    ]}>
                                        {formatDate(new Date(pickerYear, m, 1), { month: 'short' })}
                                    </Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </View>
            )}

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
    const { id } = useLocalSearchParams<{ id: string }>();
    // Template vs basket is driven by the SESSION target (not a route param).
    const sessionTarget = useBasketSession(s => s.target);
    const templateId = sessionTarget?.kind === 'template' ? sessionTarget.templateId : null;
    const isTemplateMode = templateId != null;
    useEffect(() => { if (templateId != null) useTemplateAddState.getState().hydrate(templateId); }, [templateId]);
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
    const BAR_HEIGHT = isTemplateMode ? 132 : 84; // basket mode: session-bar clearance

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

    // One commit for the header AddOrStepper (basket mode): add (session-aware),
    // update or remove the draft-basket line. qty 0 = remove (and drop the
    // basket if it was the last line).
    const commitQty = useCallback(async (qty: number) => {
        if (!product) return;
        if (basketQuantity === 0 && qty > 0) {
            setIsAdding(true);
            try {
                const r = await addProductToBasket(product.id, draftBasketId, setDraftBasketId, qty, mode);
                if (r.success) setBasketQuantity(qty);
            } finally { setIsAdding(false); }
            return;
        }
        setBasketQuantity(qty);
        const bid = draftBasketIdRef.current;
        if (!bid) return;
        const all = await fetch(`${API_BASE_URL}/api/baskets/${bid}/items`).then(r => r.json()).catch(() => []);
        const found = Array.isArray(all) ? all.find((i: any) => i.productId === product.id) : null;
        if (qty <= 0) {
            if (found) await fetch(`${API_BASE_URL}/api/basket-items/${found.id}`, { method: 'DELETE' });
            const remaining = Array.isArray(all) ? all.filter((i: any) => i.id !== found?.id) : [];
            if (remaining.length === 0) {
                await fetch(`${API_BASE_URL}/api/baskets/${bid}`, { method: 'DELETE' });
                setDraftBasketId(null);
            }
        } else if (found) {
            await fetch(`${API_BASE_URL}/api/basket-items/${found.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity: qty }),
            });
        }
    }, [product, basketQuantity, draftBasketId, setDraftBasketId, mode]);

    // Template-mode commit (the sticky bottom AddOrStepper): the picker/stepper
    // set the absolute quantity (0 = remove).
    const commitTemplateQty = useCallback((qty: number) => {
        if (!product || templateId == null) return;
        if (qty <= 0) templateSetQty(product.id, 0).catch(() => {});
        else if (templateQuantity === 0) templateAdd(product.id, qty).catch(() => {});
        else templateSetQty(product.id, qty).catch(() => {});
    }, [product, templateId, templateQuantity, templateAdd, templateSetQty]);

    if (loading) return (
        <>
            {/* Same chrome as the loaded page: floating back chip, a chips-
                skeleton row pinned where the store filter lands, and the
                title + breadcrumb + SP-card skeletons as page content. */}
            <CollapsingHeader
                controller={header}
                back
                pinned={
                    <View style={{ flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
                        {[92, 64].map((w, i) => (
                            <SkeletonBox key={i} width={w} height={34} borderRadius={20} />
                        ))}
                    </View>
                }
            />
            <ScrollView
                style={styles.container}
                contentContainerStyle={{ paddingTop: header.paddingTop, paddingBottom: 32 }}
            >
                <View style={{ paddingHorizontal: 16, gap: 8 }}>
                    <SkeletonBox width={260} height={26} borderRadius={7} />
                    <SkeletonBox width={200} height={26} borderRadius={7} />
                    <SkeletonBox width={220} height={12} borderRadius={5} />
                </View>
                {Array.from({ length: 3 }).map((_, i) => (
                    <View
                        key={i}
                        style={{
                            flexDirection: 'row', alignItems: 'center', gap: 12,
                            backgroundColor: colors.cardBackground, borderRadius: radius.lg,
                            marginHorizontal: 16, marginTop: 10, padding: 12,
                        }}
                    >
                        <SkeletonBox width={52} height={52} borderRadius={8} />
                        <View style={{ flex: 1, gap: 6 }}>
                            <SkeletonBox width={150} height={13} borderRadius={5} />
                            <SkeletonBox width={90} height={11} borderRadius={5} />
                            <SkeletonBox width={70} height={13} borderRadius={5} />
                        </View>
                        <SkeletonBox width={MINI_CHART_WIDTH} height={MINI_CHART_HEIGHT} borderRadius={6} />
                    </View>
                ))}
            </ScrollView>
        </>
    );
    if (!product) return <Text style={styles.centered}>Produktas nerastas</Text>;

    return (
        <>
            {/* Glass back bar; title + breadcrumb collapse on scroll; filter pinned. */}
            <CollapsingHeader
                controller={header}
                back
                right={!isTemplateMode && product ? (
                    <AddOrStepper
                        product={product}
                        quantity={basketQuantity}
                        onCommit={commitQty}
                        busy={isAdding}
                        addLabel={t('basketSession.add')}
                        style={styles.headerStepper}
                    />
                ) : undefined}
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
                {/* Title + breadcrumb: LIST CONTENT — scrolls natively with the
                    page (iOS 26 large-title model). */}
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
                {/* Add ⇄ stepper now lives at the TOP-RIGHT of the header
                    (see CollapsingHeader `right` below); the body is just the
                    SP list. Template mode keeps its sticky bottom bar. */}

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
                        // A promo is only a promo while it RUNS: past promoEnd the
                        // strike-through + promo price would advertise a dead deal
                        // (čiobreliai: expired 1,60 shown next to crossed-out 2,29).
                        // No promoEnd (receipt-observed) = treated as active.
                        const promoActive = latestPrice != null && latestPrice.promoPrice != null &&
                            (latestPrice.promoEnd == null || new Date(latestPrice.promoEnd).getTime() >= Date.now());
                        // Per-base-unit pricing (€/kg, €/l, €/vnt). Only for units we
                        // can convert; SPs with no amount/unit keep the pack-price-only
                        // display. baseAmount 1 (a 1 l bottle, weighable 1 kg) means
                        // per-unit == pack price — render it ONCE with the /unit suffix.
                        const UNIT_BASE: Record<string, { div: number; label: string }> = {
                            g: { div: 1000, label: 'kg' }, kg: { div: 1, label: 'kg' },
                            ml: { div: 1000, label: 'l' }, l: { div: 1, label: 'l' },
                            vnt: { div: 1, label: 'vnt' },
                        };
                        const spAmountNum = parseFloat(String(sp.amount));
                        const base = sp.unit ? UNIT_BASE[sp.unit] : undefined;
                        const baseAmount = base && Number.isFinite(spAmountNum) && spAmountNum > 0
                            ? spAmountNum / base.div
                            : null;
                        const perUnitLabel = base?.label ?? null;
                        const showPackRowPrice = latestPrice != null && baseAmount != null && baseAmount !== 1;

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
                                        {(amountStr || showPackRowPrice) && (
                                            <View style={styles.spAmountRow}>
                                                {amountStr ? <Text style={styles.spAmount}>{amountStr}</Text> : null}
                                                {showPackRowPrice && latestPrice && (
                                                    <>
                                                        <Text style={[styles.spPackPrice, promoActive && styles.spPackPriceStrike]}>
                                                            {formatEuro(Number(latestPrice.price))}
                                                        </Text>
                                                        {promoActive && (
                                                            <Text style={styles.spPackPromoPrice}>
                                                                {formatEuro(Number(latestPrice.promoPrice))}
                                                            </Text>
                                                        )}
                                                    </>
                                                )}
                                            </View>
                                        )}
                                        {latestPrice && (
                                            <View style={styles.priceRow}>
                                                <Text style={[
                                                    styles.spPrice,
                                                    promoActive && styles.spPriceStrike,
                                                ]}>
                                                    {baseAmount != null
                                                        ? `${formatEuro(Number(latestPrice.price) / baseAmount)}/${perUnitLabel}`
                                                        : formatEuro(Number(latestPrice.price))}
                                                </Text>
                                                {promoActive && (
                                                    <Text style={styles.spPromoPrice}>
                                                        {baseAmount != null
                                                            ? `${formatEuro(Number(latestPrice.promoPrice) / baseAmount)}/${perUnitLabel}`
                                                            : formatEuro(Number(latestPrice.promoPrice))}
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
            {isTemplateMode && (
                <View style={[styles.addBar, { paddingBottom: 12 }]}>
                    <AddOrStepper
                        product={product}
                        quantity={templateQuantity}
                        onCommit={commitTemplateQty}
                        size="large"
                        fullWidth
                        addLabel={t('basketTab.templates.addToTemplate')}
                        addIcon="albums-outline"
                    />
                </View>
            )}

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
    inlineAddBlock: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },

    // Header Add/stepper: a fixed min width so the −/+ get more room from the
    // amount (space-between spreads them) and the button↔stepper toggle doesn't
    // resize the header slot.
    headerStepper: { minWidth: 150 },

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
    },
    // amount + pack price share one line ("500 ml  1,09 €"); the big price
    // row below carries the per-unit value (€/kg, €/l, €/vnt).
    spAmountRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 6,
        marginTop: 2,
    },
    spPackPrice: {
        fontSize: 12,
        fontWeight: '600',
        color: c.textSecondary,
    },
    spPackPriceStrike: {
        textDecorationLine: 'line-through',
        color: c.textMuted,
        fontWeight: '400',
    },
    spPackPromoPrice: {
        fontSize: 12,
        fontWeight: '600',
        color: c.primary,
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
    gutterPrice: {
        position: 'absolute',
        left: 10,
        fontSize: 10,
        fontWeight: '600',
    },
    gutterRing: {
        position: 'absolute',
        left: -8,
        width: 10, height: 10, borderRadius: 5,
        borderWidth: 1.5,
        opacity: 0.4,
    },
    gutterDot: {
        position: 'absolute',
        left: -6,
        width: 6, height: 6, borderRadius: 3,
    },
    monthNavRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        marginBottom: 10,
    },
    monthNavLabel: {
        fontSize: 14,
        fontWeight: '600',
        color: c.textPrimary,
        minWidth: 150,
        textAlign: 'center',
        textTransform: 'capitalize',
    },
    monthPicker: {
        position: 'absolute',
        top: 74,
        alignSelf: 'center',
        backgroundColor: c.cardBackground,
        borderRadius: radius.lg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: c.border,
        padding: 12,
        width: 260,
        ...elevation.level3,
    },
    monthPickerYearRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 8,
        marginBottom: 8,
    },
    monthPickerYear: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    monthPickerGrid: { flexDirection: 'row', flexWrap: 'wrap' },
    monthPickerCell: {
        width: '25%',
        paddingVertical: 9,
        alignItems: 'center',
        borderRadius: radius.md,
    },
    monthPickerCellActive: { backgroundColor: c.primary },
    monthPickerCellText: { fontSize: 13, color: c.textPrimary, textTransform: 'capitalize' },
    monthPickerCellTextActive: { color: c.onPrimary, fontWeight: '700' },
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