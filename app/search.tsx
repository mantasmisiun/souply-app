import {
    Ionicons } from "@expo/vector-icons";
import { Stack,
    useFocusEffect,
    useLocalSearchParams,
    useRouter } from "expo-router";
import { GlassIconButton } from "../components/GlassIconButton";
import { useCallback,
    useEffect,
    useMemo,
    useRef,
    useState } from "react";
import { useTranslation } from "react-i18next";
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { LiquidGlass } from "@/components/LiquidGlass";
import { MaterialProgress } from '@/components/MaterialProgress';
import { useBasketQuantities } from '@/hooks/useBasketQuantities';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';
import { API_BASE_URL } from "../config/api";
import { useReceiptPickerState , useBasketState } from "../state/basketState";
import { useBasketSession } from "../state/basketSession";
import { addProductToBasket } from '@/utils/basketUtils';
import BasketProductCard, { type UnitPriceBadge } from '@/components/browse/BasketProductCard';
import { useTemplateAddState } from '@/state/templateAddState';
import { ProductImage } from "../components/ProductImage";
import CreateStoreProductModal, {
  CreatedStoreProductPayload,
} from "../components/receipt/CreateStoreProductModal";
import { useTheme, radius, elevation, type AppTheme } from "../constants/theme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSafeBottomTabBarHeight } from "@/hooks/useSafeBottomTabBarHeight";
import { Toast, type ToastHandle } from '@/components/Toast';

// Pick the first URL from the API's imageUrls (string | array | null) for
// places that only support a single imageUrl field (e.g. pendingPick).
const firstImageUrl = (raw: ImageUrlList): string | null => {
  if (!raw) return null;
  let arr: unknown = raw;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr)) return null;
  const first = arr.find((u) => typeof u === "string" && u.length > 0);
  return typeof first === "string" ? first : null;
};

type SearchMode = "products" | "store-products";

type ImageUrlList = (string | null | undefined)[] | string | null | undefined;

interface ProductRow {
  id: number;
  name: string;
  categoryId: number;
  categoryName?: string | null;
  imageUrls?: ImageUrlList;
  chainLogos?: { chainId: number; logoUrl: string | null }[] | string | null;
  minAmount?: number | null;
  maxAmount?: number | null;
  unit?: string | null;
  canonicalUnit?: string | null;
  canonicalStep?: number | null;
  canonicalFamily?: 'fluid' | 'count' | null;
  hasWeighable?: number | boolean;
  badge?: UnitPriceBadge | null;
}

interface StoreProductRow {
  id: number;
  productId: number;
  storeProductName: string;
  amount: number | null;
  unit: string | null;
  imageUrl: string | null;
  chainLogoUrl?: string | null;
}

interface OtherChainProductRow {
  productId: number;
  productName: string;
  categoryId: number;
  imageUrls?: ImageUrlList;
  sourceChainLogoUrl?: string | null;
}

type StoreGridItem =
  | { kind: "local"; data: StoreProductRow }
  | { kind: "other"; data: OtherChainProductRow }
  | { kind: "create" };

const safeDecode = (v?: string) => {
  try {
    return v ? decodeURIComponent(v) : "";
  } catch {
    return v ?? "";
  }
};

export default function SearchScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const params = useLocalSearchParams<{
        mode?: string;
        chainId?: string;
        productIndex?: string;
        ocrName?: string;
        createCategoryId?: string;
        source?: string;
        templateId?: string;
    }>();
    // Template vs basket is driven by the SESSION target (not a route param).
    const sessionTarget = useBasketSession(s => s.target);
    const templateIdNum = sessionTarget?.kind === 'template' ? sessionTarget.templateId : null;
    const isTemplateMode = templateIdNum != null;
    useEffect(() => { if (templateIdNum != null) useTemplateAddState.getState().hydrate(templateIdNum); }, [templateIdNum]);
    const templateItems = useTemplateAddState(s => s.items);
    const templateAdd = useTemplateAddState(s => s.add);
    const templateSetQty = useTemplateAddState(s => s.setQuantity);
    const templateMap = useMemo(() => {
        const m: Record<number, { quantity: number }> = {};
        if (!isTemplateMode) return m;
        for (const it of templateItems) m[it.productId] = { quantity: it.quantity };
        return m;
    }, [templateItems, isTemplateMode]);
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const barClearance = useSafeBottomTabBarHeight();
    const { setPendingPick } = useReceiptPickerState();
    const { draftBasketId, setDraftBasketId } = useBasketState();
    // ONE target-aware source (session basket → draft fallback, basketRev-reactive).
    const { basketId: targetBasketId, quantities: basketQuantities, setQuantities: setBasketQuantities, refresh: refreshBasketQuantities } = useBasketQuantities();
    const chainId =
        typeof params.chainId === "string" ? Number(params.chainId) : NaN;
    const productIndex =
        typeof params.productIndex === "string" ? Number(params.productIndex) : NaN;
    const createCategoryId =
        typeof params.createCategoryId === "string"
        ? Number(params.createCategoryId)
        : NaN;
    const ocrName = safeDecode(
        typeof params.ocrName === "string" ? params.ocrName : "",
    ).trim();
    const [createModalVisible, setCreateModalVisible] = useState(false);
    const toastRef = useRef<ToastHandle>(null);

    // BROWSE PARITY: hydrate quantities from the draft basket on every focus.
    // Without this, products already in the basket rendered the "Add" CTA here,
    // and re-adding 409'd ("already in basket") into a SILENT rollback — the
    // "can't add milk at all" report. Also drives the bottom basket bar count.
    // initDraftBasket first: after a JS reload (OTA restart) the zustand store
    // is empty even though a server-side draft exists — recover it like browse
    // does, otherwise every in-basket product renders "Add" and re-adding 409s.
    const hydrateBasket = useCallback(async () => {
        try {
            if (!useBasketState.getState().draftBasketId) {
                await useBasketState.getState().initDraftBasket();
            }
            await refreshBasketQuantities();
        } catch {}
    }, [refreshBasketQuantities]);
    useFocusEffect(useCallback(() => { void hydrateBasket(); }, [hydrateBasket]));

    // Absolute quantity set for an already-added product — used by the amount
    // picker's edit-reopen (tap the quantity on a card). Same server sync as
    // the per-card syncQty stepper.
    const setBasketQtyAbsolute = useCallback(async (productId: number, newQty: number) => {
        setBasketQuantities(prev => ({ ...prev, [productId]: Math.max(0, newQty) }));
        try {
            const currentDraftId = targetBasketId ?? useBasketState.getState().draftBasketId;
            if (!currentDraftId) return;
            const res = await fetch(`${API_BASE_URL}/api/baskets/${currentDraftId}/items`);
            const items = await res.json();
            const basketItem = items.find((i: any) => i.productId === productId);
            if (!basketItem) return;
            if (newQty <= 0) {
                await fetch(`${API_BASE_URL}/api/basket-items/${basketItem.id}`, { method: 'DELETE' });
                return;
            }
            await fetch(`${API_BASE_URL}/api/basket-items/${basketItem.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity: newQty }),
            });
        } catch {}
    }, [targetBasketId, setBasketQuantities]);

    // Fresh add (non-picker path; the weighable/range picker is owned by
    // AddOrStepper and also lands here via onCommit). Adopts server truth on
    // 409 rather than rolling back to "Add".
    const addToBasket = useCallback((item: ProductRow, qty: number) => {
        setBasketQuantities(prev => ({ ...prev, [item.id]: qty }));
        addProductToBasket(item.id, draftBasketId, setDraftBasketId, qty).then(result => {
            if (!result.success) {
                void hydrateBasket();
                toastRef.current?.show(result.message);
            } else {
                toastRef.current?.show(t('catalog.addedToast'));
            }
        });
    }, [draftBasketId, setDraftBasketId, hydrateBasket, t]);

    // Single commit for AddOrStepper: add / set-absolute / remove (or the
    // template store). `currentQty` is the card's current qty (0 ⇒ fresh add).
    const commitCardQty = useCallback((item: ProductRow, currentQty: number, qty: number) => {
        if (isTemplateMode) {
            const tq = templateMap[item.id]?.quantity ?? 0;
            if (qty <= 0) { templateSetQty(item.id, 0).catch(() => {}); return; }
            if (tq === 0) { templateAdd(item.id, qty).catch(() => {}); return; }
            templateSetQty(item.id, qty).catch(() => {});
            return;
        }
        if (currentQty === 0 && qty > 0) { addToBasket(item, qty); return; }
        void setBasketQtyAbsolute(item.id, qty);
    }, [isTemplateMode, templateMap, templateSetQty, templateAdd, addToBasket, setBasketQtyAbsolute]);
    const [query, setQuery] = useState("");
    const [searching, setSearching] = useState(false);
    const [inputKey, setInputKey] = useState(0);
    const searchInputRef = useRef<TextInput>(null);
    // Measured height of the floating search header (pill + chips) — the lists
    // pad by it and scroll UNDER it, fading via the gradient.
    const [headerH, setHeaderH] = useState(0);
    const clearQuery = useCallback(() => {
        searchInputRef.current?.clear();
        setQuery("");
        searchInputRef.current?.focus();
    }, []);
    const [productResults, setProductResults] = useState<ProductRow[]>([]);
    const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
    const source = typeof params.source === 'string' ? params.source : '';
    const isReceiptSource = source === 'receipt-index' || source === 'receipt-category';
    const [localResults, setLocalResults] = useState<StoreProductRow[]>([]);
    const [otherResults, setOtherResults] = useState<OtherChainProductRow[]>([]);
    const effectiveMode: SearchMode =
    isReceiptSource && params.mode === 'store-products'
        ? 'store-products'
        : 'products';

    const categoryChips = useMemo(() => {
        if (effectiveMode !== 'products' || productResults.length === 0) return [];
        const counts = new Map<number, { name: string; count: number }>();
        for (const p of productResults) {
            const entry = counts.get(p.categoryId);
            if (entry) entry.count++;
            else counts.set(p.categoryId, { name: p.categoryName ?? '', count: 1 });
        }
        return Array.from(counts.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .map(([id, { name, count }]) => ({ id, name, count }))
            .filter(c => c.name.length > 0 && !c.name.startsWith('Nepriskirt'));
    }, [productResults, effectiveMode]);

    const filteredProductResults = useMemo(() =>
        selectedCategoryId === null
            ? productResults
            : productResults.filter(p => p.categoryId === selectedCategoryId),
        [productResults, selectedCategoryId],
    );

    const canCreateInStoreMode =
    effectiveMode === 'store-products' &&
    Number.isFinite(chainId) &&
    chainId > 0;

  const closeAndBack = useCallback(() => {
    router.back();
  }, [router]);

  const closeAfterReceiptPick = () => {
    if (source === "receipt-category") {
      router.dismiss(3);
      return;
    }
    if (source === "receipt-index") {
      router.dismiss(2);
      return;
    }
    router.back();
  };
    
    useEffect(() => {
        setLocalResults([]);
        setOtherResults([]);
        setProductResults([]);
    }, [effectiveMode]);

    useEffect(() => {
    const q = query.trim();
        if (!q) {
        setProductResults([]);
        setLocalResults([]);
        setOtherResults([]);
        setSearching(false);
        return;
        }

    let cancelled = false;
    const timer = setTimeout(async () => {
        try {
        setSearching(true);

        if (effectiveMode === "store-products") {
            if (!Number.isFinite(chainId)) {
            if (!cancelled) {
                setLocalResults([]);
                setOtherResults([]);
                setProductResults([]);
            }
            return;
            }

            const categoryPart =
                Number.isFinite(createCategoryId) && createCategoryId > 0
                    ? `&categoryId=${createCategoryId}`
                    : "";

                const res = await fetch(
                `${API_BASE_URL}/api/store-products/search-unified?chainId=${chainId}&name=${encodeURIComponent(q)}${categoryPart}`
                );
                const data = await res.json();

                if (!cancelled) {
                setLocalResults(Array.isArray(data?.localStoreProducts) ? data.localStoreProducts : []);
                setOtherResults(Array.isArray(data?.otherChainProducts) ? data.otherChainProducts : []);
                setProductResults([]);
                }
        } else {
            const res = await fetch(
            `${API_BASE_URL}/api/products/search?q=${encodeURIComponent(q)}`
            );
            const data = await res.json();
            const cleaned: ProductRow[] = (Array.isArray(data) ? data : [])
            .filter((p: any) =>
                p &&
                Number.isFinite(Number(p.id)) &&
                Number(p.id) > 0 &&
                Number.isFinite(Number(p.categoryId)) &&
                Number(p.categoryId) > 0 &&
                typeof p.name === "string" &&
                p.name.trim().length > 0 &&
                !String(p.categoryName ?? '').startsWith('Nepriskirt')
            )
            .map((p: any) => ({
                id: Number(p.id),
                categoryId: Number(p.categoryId),
                categoryName: typeof p.categoryName === 'string' ? p.categoryName : null,
                name: String(p.name).trim(),
                imageUrls: p.imageUrls ?? null,
                chainLogos: p.chainLogos ?? null,
                minAmount: p.minAmount ?? null,
                maxAmount: p.maxAmount ?? null,
                canonicalUnit: p.canonicalUnit ?? null,
            }));

        if (!cancelled) {
                setSelectedCategoryId(null);
                setProductResults(cleaned);
                setLocalResults([]);
                setOtherResults([]);
                }
        }
        } finally {
        if (!cancelled) setSearching(false);
        }
    }, 300);

    return () => {
        cancelled = true;
        clearTimeout(timer);
    };
    }, [query, effectiveMode, chainId]);
    const handlePickOtherProduct = async (p: OtherChainProductRow) => {
    if (!Number.isFinite(chainId) || !Number.isFinite(productIndex)) return;

    Alert.alert(
        t('search.foundElsewhereTitle'),
        t('search.addPrompt', { name: p.productName }),
        [
        { text: t('common.cancel'), style: "cancel" },
        {
            text: t('search.addAction'),
            onPress: async () => {
            try {
                const res = await fetch(`${API_BASE_URL}/api/store-products`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    productId: p.productId,
                    chainId,
                    storeProductName: p.productName,
                }),
                });
                const created = await res.json();
                if (!res.ok || !created?.id) throw new Error(t('search.errorCreateSp'));

                setPendingPick({
                productIndex: Number(productIndex),
                storeProductId: created.id,
                productId: p.productId,
                storeProductName: p.productName,
                imageUrl: firstImageUrl(p.imageUrls),
                amount: null,
                unit: null,
                });
                closeAfterReceiptPick();
            } catch (e: any) {
                Alert.alert(t('search.errorGeneric'), e?.message || t('search.errorAdd'));
            }
            },
        },
        ]
    );
    };
  const handlePickStoreProduct = (sp: StoreProductRow) => {
    if (!Number.isFinite(productIndex)) {
      router.back();
      return;
    }
    setPendingPick({
      productIndex: Number(productIndex),
      storeProductId: sp.id,
      productId: sp.productId,
      storeProductName: sp.storeProductName,
      imageUrl: sp.imageUrl,
      amount: sp.amount,
      unit: sp.unit,
    });
    closeAfterReceiptPick();
  };

    const storeGridData = useMemo<StoreGridItem[]>(() => {
    const items: StoreGridItem[] = [
        ...localResults.map((r): StoreGridItem => ({ kind: "local", data: r })),
        ...otherResults.map((r): StoreGridItem => ({ kind: "other", data: r })),
    ];
    if (canCreateInStoreMode) items.push({ kind: "create" });
    return items;
    }, [localResults, otherResults, canCreateInStoreMode]);

  const renderStoreCard = (sp: StoreProductRow) => (
    <TouchableOpacity
      style={styles.productCard}
      onPress={() => handlePickStoreProduct(sp)}
      activeOpacity={0.7}
    >
      <View style={styles.productImageContainer}>
        <ProductImage
          uris={[sp.imageUrl]}
          imageStyle={styles.productImage}
          placeholderStyle={styles.productImagePlaceholder}
          emojiStyle={styles.productImageEmoji}
        />
      </View>
      <View style={styles.productInfo}>
        <Text style={styles.productName} numberOfLines={3}>
          {sp.storeProductName}
        </Text>
        {sp.amount !== null && sp.unit && (
          <Text style={styles.amountText}>
            {sp.amount} {sp.unit}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );

  const renderOtherCard = (p: OtherChainProductRow) => (
  <TouchableOpacity
    style={styles.productCard}
    onPress={() => handlePickOtherProduct(p)}
    activeOpacity={0.7}
  >
    <View
      style={{
        position: "absolute",
        top: 8,
        left: 8,
        backgroundColor: colors.warningMuted,
        borderRadius: 8,
        paddingHorizontal: 6,
        paddingVertical: 2,
        zIndex: 1,
      }}
    >
      <Text style={{ fontSize: 11, color: colors.onWarning, fontWeight: "600" }}>Kitur</Text>
    </View>

    <View style={styles.productImageContainer}>
      <ProductImage
        uris={p.imageUrls}
        imageStyle={styles.productImage}
        placeholderStyle={styles.productImagePlaceholder}
        emojiStyle={styles.productImageEmoji}
      />
    </View>

    <View style={styles.productInfo}>
      <Text style={styles.productName} numberOfLines={3}>
        {p.productName}
      </Text>
    </View>
  </TouchableOpacity>
);

  const renderCreateCard = () => {
    const draftName = (query.trim() || ocrName).trim();
    const disabled = !canCreateInStoreMode;
    return (
      <TouchableOpacity
        style={[
          styles.productCard,
          styles.createProductCard,
          disabled && styles.createProductCardDisabled,
        ]}
        disabled={disabled}
        onPress={() => setCreateModalVisible(true)}
        activeOpacity={0.8}
      >
        <View style={styles.productImageContainer}>
          <View style={styles.createProductPlaceholder}>
            <Text style={styles.createBroccoli}>🫜</Text>
            <View style={styles.createPlusBadge}>
              <Ionicons name="add" size={14} color={colors.textInverse} />
            </View>
          </View>
        </View>
        <View style={styles.productInfo}>
          <Text style={styles.productName} numberOfLines={2}>
            {t('search.createNewTitle')}
          </Text>
          <Text style={styles.amountText} numberOfLines={2}>
            {draftName ? t('search.createNewName', { name: draftName }) : t('search.createNewPrompt')}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  // Render the search bar in-screen instead of via navigation.setOptions.
  // On Android, calling setOptions for headerRight rebuilds the entire
  // header — the TextInput inside headerTitle remounts and the keyboard
  // dismisses. Keeping the input inside the screen tree avoids that.
  const headerTop = headerH || insets.top + 64;
  // ONE input instance (the keyboard dies if this remounts — see inputKey note),
  // wrapped by the platform pill below.
  const pillInner = (
    <>
      <Ionicons name="search" size={20} color={colors.textMuted} />
      <TextInput
        ref={searchInputRef}
        key={inputKey}
        autoFocus
        placeholder={t('search.searchPlaceholder')}
        placeholderTextColor={colors.textMuted}
        defaultValue={query}
        onChangeText={setQuery}
        style={styles.searchInput}
        autoCorrect={false}
        autoCapitalize="none"
      />
      {/* M3: the clear affordance is a PLAIN trailing icon, not a chip. */}
      {query.length > 0 ? (
        <TouchableOpacity onPress={clearQuery} hitSlop={10}>
          <Ionicons name="close" size={20} color={colors.textMuted} />
        </TouchableOpacity>
      ) : null}
    </>
  );
  const searchHeader = (
    <View
      style={styles.headerOverlay}
      pointerEvents="box-none"
      onLayout={(e) => setHeaderH(Math.round(e.nativeEvent.layout.height))}
    >
      {/* Fade wash: transparent at the header's bottom edge, strengthening
          toward the screen top but never fully hiding results — they dim as
          they slide under the pill/chips and clip at the screen edge (same
          spec as CollapsingHeader). */}
      <View pointerEvents="none" style={[styles.headerFade, { height: headerTop }]}>
        <Svg width="100%" height="100%">
          <Defs>
            <SvgLinearGradient id="searchTopFade" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.pageBackground} stopOpacity="0.75" />
              <Stop offset="1" stopColor={colors.pageBackground} stopOpacity="0" />
            </SvgLinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#searchTopFade)" />
        </Svg>
      </View>
      {/* Two rows (M3-Expressive layout: controls OUTSIDE the search pill):
          back chip on its own row, then the full-width search pill. */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <View style={styles.topBarRow}>
          <GlassIconButton icon="chevron-back" onPress={closeAndBack} size={24} glass />
        </View>
        {Platform.OS === 'ios' ? (
          // iOS 26: search lives in its own Liquid Glass capsule.
          <LiquidGlass style={styles.searchPill}>{pillInner}</LiquidGlass>
        ) : (
          // Android: M3 docked search pill. SOLID card-white with a hairline
          // outline + soft elevation — the tonal translucent fill had no
          // contrast against the cream page; white-on-cream is the app's
          // established card language and keeps the input clearly findable.
          <View style={[styles.searchPill, styles.searchPillSolid]}>
            {pillInner}
          </View>
        )}
      </View>
      {effectiveMode === 'products' && categoryChips.length > 1 && (
          <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.bubblesRow}
              contentContainerStyle={styles.bubblesContainer}
          >
              <TouchableOpacity
                  style={[styles.bubble, selectedCategoryId === null && styles.bubbleActive]}
                  onPress={() => setSelectedCategoryId(null)}
              >
                  <Text style={[styles.bubbleText, selectedCategoryId === null && styles.bubbleTextActive]}>
                      {t('catalog.allProducts')}
                  </Text>
              </TouchableOpacity>
              {categoryChips.map(chip => (
                  <TouchableOpacity
                      key={chip.id}
                      style={[styles.bubble, selectedCategoryId === chip.id && styles.bubbleActive]}
                      onPress={() => setSelectedCategoryId(chip.id)}
                  >
                      <Text style={[styles.bubbleText, selectedCategoryId === chip.id && styles.bubbleTextActive]}>
                          {chip.name}
                      </Text>
                  </TouchableOpacity>
              ))}
          </ScrollView>
      )}
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        {searching ? (
          // Centering must live on a WRAPPER: styles.centered on the spinner
          // itself stretches the native view full-screen while the drawable
          // renders at its own size in the top-left corner.
          <View style={[styles.centered, { paddingTop: headerTop }]}>
            <MaterialProgress size="large" color={colors.primary} />
          </View>
        ) : effectiveMode === "store-products" ? (
          <FlatList<StoreGridItem>
            key="store-products-search-grid"
            data={storeGridData}
            keyboardDismissMode="on-drag"
            onScrollBeginDrag={() => { useBasketSession.getState().collapseDock?.(); }}
            keyExtractor={(item, idx) => {
                if (item.kind === "create") return `create-${idx}`;
                if (item.kind === "local") return `local-${item.data.id}-${idx}`;
                return `other-${item.data.productId}-${idx}`;
            }}
            contentContainerStyle={[styles.list, { paddingTop: headerTop + 12 }]}
            numColumns={2}
            columnWrapperStyle={styles.row}
            ListEmptyComponent={
              <Text style={styles.emptyText}>
                {query.trim() ? t('search.notFound') : t('search.enterQuery')}
              </Text>
            }
            renderItem={({ item }) => {
                if (item.kind === "create") return renderCreateCard();
                if (item.kind === "other") return renderOtherCard(item.data);
                return renderStoreCard(item.data);
            }}
          />
        ) : (
          <FlatList<ProductRow>
            key="products-search-grid"
            data={filteredProductResults}
            keyboardDismissMode="on-drag"
            onScrollBeginDrag={() => { useBasketSession.getState().collapseDock?.(); }}
            keyExtractor={(item, idx) => `p-${item.id}-${idx}`}
            contentContainerStyle={[
              styles.list,
              // Under the floating search header; clear the floating bottom bar
              // so the last row is fully visible.
              { paddingTop: headerTop + 12, paddingBottom: barClearance },
            ]}
            numColumns={2}
            columnWrapperStyle={styles.row}
            ListEmptyComponent={
              <Text style={styles.emptyText}>
                {query.trim() ? t('search.notFound') : t('search.enterQuery')}
              </Text>
            }
            renderItem={({ item }) => {
                if (!Number.isFinite(item.id) || item.id <= 0 || !Number.isFinite(item.categoryId) || !item.name?.trim()) return null;
const quantity = basketQuantities[item.id] ?? 0;

                const isVolume = item.unit === 'ml' || item.canonicalUnit === 'l';
                const bigUnit = isVolume ? 'l' : 'kg';
                const smallUnit = isVolume ? 'ml' : 'g';
                const fmt = (v: number) => v >= 1000 ? `${v / 1000} ${bigUnit}` : `${v} ${smallUnit}`;
                const amountText = item.minAmount != null && item.maxAmount != null
                    ? (() => { const mn = Number(item.minAmount); const mx = Number(item.maxAmount); return mn === mx ? fmt(mn) : `${fmt(mn)} - ${fmt(mx)}`; })()
                    : '';
                const templateQty = isTemplateMode ? (templateMap[item.id]?.quantity ?? 0) : 0;
                const cardQty = isTemplateMode ? templateQty : quantity;
                return (
                    <BasketProductCard
                    name={item.name}
                    imageUrls={item.imageUrls}
                    chainLogos={item.chainLogos}
                    badge={item.badge}
                    amountText={amountText}
                    product={item}
                    quantity={cardQty}
                    addLabel={isTemplateMode ? t('basketTab.templates.addToTemplate') : undefined}
                    onOpen={() => router.push(`/catalog/product/${item.id}` as any)}
                    onCommit={(qty) => commitCardQty(item, cardQty, qty)}
                    />
                );
                }}
          />
        )}
      </View>
      {searchHeader}
      {/* The bottom basket indicator is now the universal, root-level
          BasketListSheet (the "collecting items" session sheet) — the old
          per-screen basketBar here was redundant and fought it on Android
          (elevation z-order), so it's removed. */}
      <CreateStoreProductModal
        visible={createModalVisible}
        onClose={() => setCreateModalVisible(false)}
        chainId={chainId}
        initialName={query.trim() || ocrName}
        initialCategoryId={Number.isFinite(createCategoryId) ? createCategoryId : null}
        onCreated={(created: CreatedStoreProductPayload) => {
          if (!Number.isFinite(productIndex)) {
            throw new Error("Nerastas redaguojamas kvito produktas.");
          }
          setPendingPick({
            productIndex: Number(productIndex),
            storeProductId: created.storeProductId,
            productId: created.productId,
            storeProductName: created.storeProductName,
            imageUrl: created.imageUrl,
            amount: created.amount,
            unit: created.unit,
            priceVerified: false,
          });
          closeAfterReceiptPick();
        }}
      />
      <Toast ref={toastRef} />
    </>
  );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    basketBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingTop: 12,
        backgroundColor: c.cardBackground,
        borderTopLeftRadius: radius.lg,
        borderTopRightRadius: radius.lg,
        ...elevation.level3,
        gap: 12,
    },
    basketBarLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
    basketBarCount: { fontSize: 14, fontWeight: '600', color: c.primary },
    basketBarButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: c.primary,
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderRadius: radius.pill,
    },
    basketBarButtonText: { fontSize: 14, fontWeight: '700', color: c.onPrimary },
  container: { flex: 1, backgroundColor: c.pageBackground },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  searchInput: { fontSize: 16, flex: 1, color: c.textPrimary, paddingVertical: 0 },
  // Floating header overlay — NO bar background; the gradient fade behind it
  // (headerFade) is the only surface, so items dissolve as they pass under.
  headerOverlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, elevation: 10 },
  headerFade: { position: 'absolute', top: 0, left: 0, right: 0 },
  // Two stacked rows (M3-Expressive: controls OUTSIDE the pill): back chip
  // row, then the full-width search pill. 16dp side margins per M3.
  topBar: {
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  topBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    // GlassIconButton carries its own 4dp margins — pull back to the edge.
    marginLeft: -4,
  },
  // M3(E) docked search pill: full-width, 52dp tall, full-pill corners, icon +
  // input + plain clear icon inside. Fill comes per-platform at the call site
  // (translucent tonal on Android, LiquidGlass capsule on iOS).
  searchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 52,
    borderRadius: radius.pill,
    paddingHorizontal: 16,
    overflow: 'hidden',
  },
  // Android fill: solid white + hairline outline + soft lift (opaque, so the
  // elevation shadow renders cleanly — no translucent-view gray-border artifact).
  searchPillSolid: {
    backgroundColor: c.cardBackground,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    elevation: 2,
  },
  bubblesRow: {
    flexGrow: 0,
    flexShrink: 0,
  },
  bubblesContainer: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.cardBackground,
  },
  bubbleActive: {
    backgroundColor: c.primary,
    borderColor: c.primary,
  },
  bubbleText: {
    fontSize: 13,
    color: c.textPrimary,
  },
  bubbleTextActive: {
    color: c.onPrimary,
    fontWeight: '600',
  },
  list: { padding: 12 },
  row: { gap: 12, marginBottom: 12 },
  productCard: {
    backgroundColor: c.cardBackground,
    borderRadius: 12,
    padding: 12,
    alignItems: "center",
    elevation: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    flex: 1,
    maxWidth: "50%",
  },
  productImageContainer: {
    width: "100%",
    height: 130,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  productImage: { width: "100%", height: "100%" },
  productImagePlaceholder: {
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceMuted,
    borderRadius: 8,
  },
  productImageEmoji: {
    fontSize: 44,
    opacity: 0.4,
  },
  productInfo: { flex: 1, width: "100%" },
  productName: { fontSize: 13, color: c.textPrimary, lineHeight: 18 },
  amountText: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  emptyText: {
    textAlign: "center",
    padding: 32,
    fontSize: 15,
    color: c.textSecondary,
  },
  createProductCard: {
    width: "100%",
    maxWidth: "100%",
  },
  createProductCardDisabled: {
    opacity: 0.6,
  },
  createProductPlaceholder: {
    width: "100%",
    height: "100%",
    borderRadius: 10,
    backgroundColor: c.surfaceMuted,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  createBroccoli: {
    fontSize: 44,
    opacity: 0.55,
  },
  createPlusBadge: {
    position: "absolute",
    right: 8,
    bottom: 8,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: c.primary,
    alignItems: "center",
    justifyContent: "center",
  },
});
