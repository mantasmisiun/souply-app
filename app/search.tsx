import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Image,
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

type SearchMode = "products" | "store-products";

interface ProductRow {
  id: number;
  name: string;
  categoryId: number;
  imageUrl?: string | null;
}

interface StoreProductRow {
  id: number;
  productId: number;
  storeProductName: string;
  amount: number | null;
  unit: string | null;
  imageUrl: string | null;
}

type StoreGridItem = StoreProductRow | { kind: "create" };

const safeDecode = (v?: string) => {
  try {
    return v ? decodeURIComponent(v) : "";
  } catch {
    return v ?? "";
  }
};

const isCreateRow = (item: StoreGridItem): item is { kind: "create" } => {
  return (item as { kind?: string }).kind === "create";
};

export default function SearchScreen() {
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

    const [query, setQuery] = useState("");
    const [searching, setSearching] = useState(false);
    const [inputKey, setInputKey] = useState(0);
    const [creating, setCreating] = useState(false);
    const [productResults, setProductResults] = useState<ProductRow[]>([]);
    const [storeResults, setStoreResults] = useState<StoreProductRow[]>([]);
    const source = typeof params.source === 'string' ? params.source : '';
    const isReceiptSource = source === 'receipt-index' || source === 'receipt-category';

    // Only receipt routes can ever use store-products mode.
    const effectiveMode: SearchMode =
    isReceiptSource && params.mode === 'store-products'
        ? 'store-products'
        : 'products';

    const canCreateInStoreMode =
    effectiveMode === 'store-products' &&
    Number.isFinite(createCategoryId) &&
    createCategoryId > 0 &&
    Number.isFinite(chainId) &&
    chainId > 0;

  const closeAndBack = () => {
    router.back();
  };

  const closeAfterReceiptPick = () => {
    if (source === "receipt-category") {
      router.back();
      router.back();
      router.back();
      return;
    }
    if (source === "receipt-index") {
      router.back();
      router.back();
      return;
    }
    router.back();
  };
    


useEffect(() => {
  setStoreResults([]);
  setProductResults([]);
}, [effectiveMode]);

useEffect(() => {
  const q = query.trim();
  if (!q) {
    setProductResults([]);
    setStoreResults([]);
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
            setStoreResults([]);
            setProductResults([]);
          }
          return;
        }

        const res = await fetch(
          `${API_BASE_URL}/api/store-products/search?name=${encodeURIComponent(q)}&chainId=${chainId}`
        );
        const data = await res.json();

        if (!cancelled) {
          setStoreResults(Array.isArray(data) ? data : []);
          setProductResults([]);
        }
      } else {
        const res = await fetch(
          `${API_BASE_URL}/api/products/search?q=${encodeURIComponent(q)}`
        );
        const data = await res.json();
        const qLower = q.toLowerCase();

        const cleaned: ProductRow[] = (Array.isArray(data) ? data : [])
          .filter((p: any) =>
            p &&
            Number.isFinite(Number(p.id)) &&
            Number(p.id) > 0 &&
            Number.isFinite(Number(p.categoryId)) &&
            Number(p.categoryId) > 0 &&
            typeof p.name === "string" &&
            p.name.trim().length > 0 &&
            !(String(p.name).trim().toLowerCase() === qLower && !p.imageUrl)
          )
          .map((p: any) => ({
            id: Number(p.id),
            categoryId: Number(p.categoryId),
            name: String(p.name).trim(),
            imageUrl: p.imageUrl ?? null,
          }));

        if (!cancelled) {
          setProductResults(cleaned);
          setStoreResults([]);
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

  const handleCreateStoreProduct = async () => {
    const draftName = (query.trim() || ocrName).trim();
    if (!draftName) {
      Alert.alert("Trūksta pavadinimo", "Įveskite produkto pavadinimą.");
      return;
    }
    if (!canCreateInStoreMode) {
      Alert.alert("Klaida", "Šioje vietoje produkto kūrimas negalimas.");
      return;
    }
    if (!Number.isFinite(productIndex)) {
      Alert.alert("Klaida", "Nerastas redaguojamas kvito produktas.");
      return;
    }

    try {
      setCreating(true);

      const pRes = await fetch(`${API_BASE_URL}/api/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId: createCategoryId, name: draftName }),
      });
      const pData = await pRes.json();
      if (!pRes.ok || !pData?.id)
        throw new Error(pData?.error || "Nepavyko sukurti produkto");

      const spRes = await fetch(`${API_BASE_URL}/api/store-products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: pData.id,
          chainId,
          storeProductName: draftName,
        }),
      });
      const spData = await spRes.json();
      if (!spRes.ok || !spData?.id)
        throw new Error(
          spData?.error || "Nepavyko sukurti parduotuvės produkto",
        );

      setPendingPick({
        productIndex: Number(productIndex),
        storeProductId: spData.id,
        productId: pData.id,
        storeProductName: draftName,
        imageUrl: null,
        amount: null,
        unit: null,
      });

      closeAfterReceiptPick();
    } catch (e: any) {
      Alert.alert("Klaida", e?.message || "Nepavyko sukurti produkto");
    } finally {
      setCreating(false);
    }
  };

  const storeGridData = useMemo<StoreGridItem[]>(
    () =>
      canCreateInStoreMode
        ? [...storeResults, { kind: "create" }]
        : storeResults,
    [storeResults, canCreateInStoreMode],
  );

  const renderStoreCard = (sp: StoreProductRow) => (
    <TouchableOpacity
      style={styles.productCard}
      onPress={() => handlePickStoreProduct(sp)}
      activeOpacity={0.7}
    >
      <View style={styles.productImageContainer}>
        {sp.imageUrl ? (
          <Image
            source={{ uri: sp.imageUrl }}
            style={styles.productImage}
            resizeMode="contain"
          />
        ) : (
          <Ionicons name="cube-outline" size={40} color="#e0e0e0" />
        )}
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

  const renderCreateCard = () => {
    const draftName = (query.trim() || ocrName).trim();
    const disabled = creating || !draftName || !canCreateInStoreMode;
    return (
      <TouchableOpacity
        style={[
          styles.productCard,
          styles.createProductCard,
          disabled && styles.createProductCardDisabled,
        ]}
        disabled={disabled}
        onPress={handleCreateStoreProduct}
        activeOpacity={0.8}
      >
        <View style={styles.productImageContainer}>
          <View style={styles.createProductPlaceholder}>
            <Text style={styles.createBroccoli}>🥦</Text>
            <View style={styles.createPlusBadge}>
              <Ionicons name="add" size={14} color="#ffffff" />
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
          headerTitle: () => (
            <TextInput
              key={inputKey}
              autoFocus
              placeholder="Ieškoti produkto..."
              placeholderTextColor="#9e9e9e"
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
              style={{ marginRight: 12 }}
            >
              <Ionicons name="close" size={24} color="#2e7d32" />
            </TouchableOpacity>
          ),
        }}
      />
      <View style={styles.container}>
        {searching ? (
          <ActivityIndicator
            style={styles.centered}
            size="large"
            color="#2e7d32"
          />
        ) : effectiveMode === "store-products" ? (
          <FlatList<StoreGridItem>
            key="store-products-search-grid"
            data={storeGridData}
            keyExtractor={(item, idx) =>
              isCreateRow(item) ? `create-${idx}` : `sp-${item.id}-${idx}`
            }
            contentContainerStyle={styles.list}
            numColumns={2}
            columnWrapperStyle={styles.row}
            ListEmptyComponent={
              <Text style={styles.emptyText}>
                {query.trim() ? "Produktų nerasta" : "Įveskite paieškos tekstą"}
              </Text>
            }
            renderItem={({ item }) =>
            isCreateRow(item) ? renderCreateCard() : renderStoreCard(item)
            }
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
                    imageUrl={item.imageUrl}
                    quantity={quantity}
                    onOpen={() => router.push(`/product/${item.id}` as any)}
                    onAdd={async () => {
                        const result = await addProductToBasket(item.id, draftBasketId, setDraftBasketId);
                        if (result.success) setBasketQuantities(prev => ({ ...prev, [item.id]: 1 }));
                    }}
                    onDec={() => syncQty(Number((quantity - 1).toFixed(1)))}
                    onInc={() => syncQty(Number((quantity + 1).toFixed(1)))}
                    />
                );
                }}
          />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f5f5f5" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  searchInput: { fontSize: 16, flex: 1, color: "#212121" },
  list: { padding: 12 },
  row: { gap: 12, marginBottom: 12 },
  productCard: {
    backgroundColor: "white",
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
  productInfo: { flex: 1, width: "100%" },
  productName: { fontSize: 13, color: "#212121", lineHeight: 18 },
  amountText: { fontSize: 12, color: "#9e9e9e", marginTop: 2 },
  emptyText: {
    textAlign: "center",
    padding: 32,
    fontSize: 15,
    color: "#757575",
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
    backgroundColor: "#f1f3f4",
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
    backgroundColor: "#9e9e9e",
    alignItems: "center",
    justifyContent: "center",
  },
});
