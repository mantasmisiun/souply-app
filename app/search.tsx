import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    FlatList,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { API_BASE_URL } from "../config/api";
import { useReceiptPickerState } from "../state/basketState";
import { useBasketState } from '../state/basketState';
import { addProductToBasket } from '../utils/basketUtils';
import BasketProductCard from '../components/browse/BasketProductCard';
import { ProductImage } from "../components/ProductImage";
import CreateStoreProductModal, {
  CreatedStoreProductPayload,
} from "../components/receipt/CreateStoreProductModal";
import { useTheme, type AppTheme } from "../constants/theme";

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
  imageUrls?: ImageUrlList;
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
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const params = useLocalSearchParams<{
        mode?: string;
        chainId?: string;
        productIndex?: string;
        ocrName?: string;
        createCategoryId?: string;
        source?: string;
    }>();
    const router = useRouter();
    const { setPendingPick } = useReceiptPickerState();
    const { draftBasketId, setDraftBasketId } = useBasketState();
    const [basketQuantities, setBasketQuantities] = useState<Record<number, number>>({});
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
    const [query, setQuery] = useState("");
    const [searching, setSearching] = useState(false);
    const [inputKey, setInputKey] = useState(0);
    const [productResults, setProductResults] = useState<ProductRow[]>([]);
    const source = typeof params.source === 'string' ? params.source : '';
    const isReceiptSource = source === 'receipt-index' || source === 'receipt-category';
    const [localResults, setLocalResults] = useState<StoreProductRow[]>([]);
    const [otherResults, setOtherResults] = useState<OtherChainProductRow[]>([]);
    const effectiveMode: SearchMode =
    isReceiptSource && params.mode === 'store-products'
        ? 'store-products'
        : 'products';

    const canCreateInStoreMode =
    effectiveMode === 'store-products' &&
    Number.isFinite(chainId) &&
    chainId > 0;

  const closeAndBack = () => {
    router.back();
  };

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
                p.name.trim().length > 0
            )
            .map((p: any) => ({
                id: Number(p.id),
                categoryId: Number(p.categoryId),
                name: String(p.name).trim(),
                imageUrls: p.imageUrls ?? null,
            }));

        if (!cancelled) {
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
        "Kitur rastas produktas",
        `Pridėti „${p.productName}“ į šios parduotuvės sąrašą?`,
        [
        { text: "Atšaukti", style: "cancel" },
        {
            text: "Pridėti",
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
                if (!res.ok || !created?.id) throw new Error("Nepavyko sukurti StoreProduct");

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
                Alert.alert("Klaida", e?.message || "Nepavyko pridėti produkto");
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
            Kurti naują produktą
          </Text>
          <Text style={styles.amountText} numberOfLines={2}>
            {draftName ? `Pavadinimas: ${draftName}` : "Įveskite pavadinimą"}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: "",
          headerLeft: () => (
            <TouchableOpacity
              onPress={closeAndBack}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Ionicons name="chevron-back" size={28} color={colors.primary} />
            </TouchableOpacity>
          ),
          headerTitle: () => (
            <TextInput
              key={inputKey}
              autoFocus
              placeholder="Ieškoti produkto..."
              placeholderTextColor={colors.textMuted}
              defaultValue={query}
              onChangeText={setQuery}
              style={styles.searchInput}
              autoCorrect={false}
              autoCapitalize="none"
            />
          ),
          headerRight: () => (
            <TouchableOpacity
              onPress={closeAndBack}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Ionicons name="close" size={24} color={colors.primary} />
            </TouchableOpacity>
          ),
        }}
      />
      <View style={styles.container}>
        {searching ? (
          <ActivityIndicator
            style={styles.centered}
            size="large"
            color={colors.primary}
          />
        ) : effectiveMode === "store-products" ? (
          <FlatList<StoreGridItem>
            key="store-products-search-grid"
            data={storeGridData}
            keyExtractor={(item, idx) => {
                if (item.kind === "create") return `create-${idx}`;
                if (item.kind === "local") return `local-${item.data.id}-${idx}`;
                return `other-${item.data.productId}-${idx}`;
            }}
            contentContainerStyle={styles.list}
            numColumns={2}
            columnWrapperStyle={styles.row}
            ListEmptyComponent={
              <Text style={styles.emptyText}>
                {query.trim() ? "Produktų nerasta" : "Įveskite paieškos tekstą"}
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
            data={productResults}
            keyExtractor={(item, idx) => `p-${item.id}-${idx}`}
            contentContainerStyle={styles.list}
            numColumns={2}
            columnWrapperStyle={styles.row}
            ListEmptyComponent={
              <Text style={styles.emptyText}>
                {query.trim() ? "Produktų nerasta" : "Įveskite paieškos tekstą"}
              </Text>
            }
            renderItem={({ item }) => {
                if (!Number.isFinite(item.id) || item.id <= 0 || !Number.isFinite(item.categoryId) || !item.name?.trim()) return null;
                const quantity = basketQuantities[item.id] ?? 0;

                const syncQty = async (newQty: number) => {
                    setBasketQuantities(prev => ({ ...prev, [item.id]: Math.max(0, newQty) }));
                    try {
                    const currentDraftId = useBasketState.getState().draftBasketId;
                    if (!currentDraftId) return;

                    const res = await fetch(`${API_BASE_URL}/api/baskets/${currentDraftId}/items`);
                    const items = await res.json();
                    const basketItem = items.find((i: any) => i.productId === item.id);

                    if (newQty <= 0) {
                        if (basketItem) {
                        await fetch(`${API_BASE_URL}/api/basket-items/${basketItem.id}`, { method: 'DELETE' });
                        }
                        return;
                    }

                    if (basketItem) {
                        await fetch(`${API_BASE_URL}/api/basket-items/${basketItem.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ quantity: newQty }),
                        });
                    }
                    } catch {}
                };

                return (
                    <BasketProductCard
                    name={item.name}
                    imageUrls={item.imageUrls}
                    quantity={quantity}
                    onOpen={() => router.push(`/product/${item.id}` as any)}
                    onAdd={async () => {
                        // Optimistic flip to 1: paints the quantity control in
                        // place of the add button immediately, so a rapid
                        // re-tap hits the qty control instead of re-adding.
                        // Rolls back on failure.
                        setBasketQuantities(prev => ({ ...prev, [item.id]: 1 }));
                        const result = await addProductToBasket(item.id, draftBasketId, setDraftBasketId);
                        if (!result.success) {
                            setBasketQuantities(prev => {
                                const next = { ...prev };
                                delete next[item.id];
                                return next;
                            });
                        }
                    }}
                    onDec={() => syncQty(Number((quantity - 1).toFixed(1)))}
                    onInc={() => syncQty(Number((quantity + 1).toFixed(1)))}
                    />
                );
                }}
          />
        )}
      </View>
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
    </>
  );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.pageBackground },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  searchInput: { fontSize: 16, flex: 1, color: c.textPrimary },
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
