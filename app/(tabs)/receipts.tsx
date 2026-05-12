import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Image,
    Modal,
    Pressable,
    RefreshControl,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { API_BASE_URL } from "../../config/api";
import { getUserId } from "../../config/user";
import { useTheme, type AppTheme } from "../../constants/theme";
import { SkeletonBox } from "../../components/SkeletonBox";
import { DEV_MODE } from "../../constants/flags";
import {
    clearReceiptDraft,
    loadReceiptDraft,
} from "../../state/receiptDraft";
import { fetchWithTimeout, TIMEOUT_HEAVY_MS, TIMEOUT_STANDARD_MS } from "../../utils/fetchWithTimeout";
import { useNetworkStatus } from "../../state/networkStatus";
import { useLevelStore } from "../../state/levelStore";

interface Receipt {
  id: number;
  filePath: string;
  fileType: string;
  processingStatus: string;
  receiptDate: string | null;
  receiptNo: string | null;
  chainName: string | null;
  chainLogoUrl: string | null;
  storeName: string | null;
  storeAddress: string | null;
  mandatorySwipesRequired: number;
  mandatorySwipesCompleted: number;
  /**
   * Persisted parsed receipt blob. mysql2 returns this as either a
   * pre-parsed object (JSON column) or a raw string (TEXT column),
   * depending on the underlying schema version.
   */
  parsedData?: unknown;
}

/**
 * `JSON.parse` that swallows errors. Used for receipt rows whose
 * `parsedData` column is a TEXT blob — a malformed row shouldn't
 * crash the receipt list.
 */
const safeJsonParse = (raw: string): any => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export default function ReceiptsScreen() {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const checkCandidate = useLevelStore(s => s.checkCandidate);
  useFocusEffect(useCallback(() => { checkCandidate(); }, [checkCandidate]));
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();
  // Block scan actions when offline — OCR still works but every
  // downstream HTTP call (store match, product match, POST, upload,
  // comparison) will fail. Better to stop the user up front than
  // surface a cascade of errors after a 5-second OCR. FAB visually
  // dims and the "+" becomes inert while offline; existing-receipt
  // taps still navigate fine (loadExistingReceipt has its own
  // error handling for broken parsedData).
  const isOnline = useNetworkStatus((s) => s.isOnline);
  const [lastUploadedId, setLastUploadedId] = useState<number | null>(null);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [previewOnly, setPreviewOnly] = useState(false);
  const [pdfConverting, setPdfConverting] = useState(false);

  const goToProcess = (uri: string) => {
    const params = new URLSearchParams({ uri });
    if (previewOnly) params.set("preview", "true");
    router.push(`/receipt-process?${params.toString()}` as any);
  };

  const onPickCamera = () => {
    setUploadMenuOpen(false);
    if (previewOnly) {
      // Camera preview mode still needs a URI path; capture screen handles it.
      router.push(`/receipt/capture?preview=true` as any);
    } else {
      router.push("/receipt/capture" as any);
    }
  };

  const handlePdf = async (uri: string) => {
    setPdfConverting(true);
    try {
      const pdfBase64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const res = await fetchWithTimeout(
        `${API_BASE_URL}/api/receipts/pdf-to-image`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pdfBase64 }),
          timeoutMs: TIMEOUT_HEAVY_MS,
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      const { images } = await res.json();
      if (!Array.isArray(images) || images.length === 0) {
        throw new Error("Serverio atsakyme trūksta nuotraukų");
      }
      const timestamp = Date.now();
      const outPaths: string[] = [];
      for (let i = 0; i < images.length; i++) {
        const path = `${FileSystem.cacheDirectory}receipt-pdf-${timestamp}-p${i}.png`;
        await FileSystem.writeAsStringAsync(path, images[i], {
          encoding: FileSystem.EncodingType.Base64,
        });
        outPaths.push(path);
      }
      const params = new URLSearchParams({ uris: outPaths.join(",") });
      if (previewOnly) params.set("preview", "true");
      router.push(`/receipt-process?${params.toString()}` as any);
    } catch (e: any) {
      Alert.alert(
        "Nepavyko apdoroti PDF",
        e?.message ?? "Nežinoma klaida konvertuojant PDF į paveikslėlį."
      );
    } finally {
      setPdfConverting(false);
    }
  };

  // Unified file picker: accepts both images and PDFs, detects type, routes accordingly.
  // Users don't need to know whether their receipt is a photo or a PDF file.
  const onPickFile = async () => {
    setUploadMenuOpen(false);
    await new Promise(resolve => setTimeout(resolve, 300));
    const picked = await DocumentPicker.getDocumentAsync({
      type: ["image/*", "application/pdf"],
      copyToCacheDirectory: true,
    });
    if (picked.canceled || !picked.assets?.[0]) return;
    const asset = picked.assets[0];
    const mimeType = asset.mimeType ?? '';
    const isPdf = mimeType === 'application/pdf' || (asset.name?.toLowerCase().endsWith('.pdf') ?? false);
    if (isPdf) {
      await handlePdf(asset.uri);
    } else {
      goToProcess(asset.uri);
    }
  };

  const fetchReceipts = async (removePlaceholder = false) => {
    try {
      const userId = await getUserId();
      const response = await fetchWithTimeout(
        `${API_BASE_URL}/api/users/${userId}/receipts`,
        { timeoutMs: TIMEOUT_STANDARD_MS },
      );
      const data = await response.json();
      const rows = Array.isArray(data) ? data : [];
      setReceipts((prev) => {
        const hasPlaceholder = prev.some((r) => r.id === -1);
        if (hasPlaceholder && !removePlaceholder) {
          return [prev.find((r) => r.id === -1)!, ...rows];
        }
        return rows;
      });
    } catch (error) {
      console.error("Failed to fetch receipts:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const hasProcessing = receipts.some(
      (r) =>
        r.processingStatus === "processing" || r.processingStatus === "pending",
    );
    if (!hasProcessing && !lastUploadedId) return;

    const interval = setInterval(async () => {
      await fetchReceipts();
      if (lastUploadedId) {
        setReceipts((prev) => {
          const stillExists = prev.some((r) => r.id === lastUploadedId);
          if (!stillExists) {
            Alert.alert("Dublikatas", "Šis kvitas jau buvo įkeltas anksčiau");
            setLastUploadedId(null);
          }
          return prev;
        });
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [receipts, lastUploadedId]);
  useFocusEffect(
    useCallback(() => {
      fetchReceipts();
    }, []),
  );

  // Resume prompt: if a draft was saved by a previous /receipt-process
  // session that didn't survive to POST, offer the user the option to
  // pick up where they left off. Fires once per mount of this screen;
  // using ref-less `checked` local because the effect should only run
  // on first focus, not on every re-render.
  useEffect(() => {
    let active = true;
    (async () => {
      const draft = await loadReceiptDraft();
      if (!active) return;
      if (!draft) return;
      Alert.alert(
        "Tęsti kvito analizę?",
        "Anksčiau pradėtas kvito apdorojimas nebuvo užbaigtas. Ar tęsti?",
        [
          {
            text: "Atšaukti",
            style: "cancel",
            onPress: () => {
              clearReceiptDraft().catch(() => {});
            },
          },
          {
            text: "Tęsti",
            onPress: () => {
              const params = new URLSearchParams();
              if (draft.imageUris.length > 1) {
                params.set("uris", draft.imageUris.join(","));
              } else {
                params.set("uri", draft.imageUris[0]);
              }
              router.push(`/receipt-process?${params.toString()}` as any);
            },
          },
        ],
      );
    })();
    return () => {
      active = false;
    };
  }, []);

  const hasPendingSwipes = (item: Receipt) =>
    item.processingStatus === "completed" &&
    (item.mandatorySwipesRequired ?? 0) > 0 &&
    (item.mandatorySwipesCompleted ?? 0) < (item.mandatorySwipesRequired ?? 0);

  const getStatusColor = (item: Receipt) => {
    if (hasPendingSwipes(item)) return colors.warning;
    switch (item.processingStatus) {
      case "completed":
        return colors.success;
      case "processing":
        return colors.warning;
      case "failed":
        return colors.error;
      default:
        return colors.textSecondary;
    }
  };

  const getStatusText = (item: Receipt) => {
    if (hasPendingSwipes(item)) return "Padėk atpažinti";
    switch (item.processingStatus) {
      case "completed":
        return "Apdorotas";
      case "processing":
        return "Apdorojama";
      case "failed":
        return "Nepavyko";
      default:
        return "Laukiama";
    }
  };

  if (loading) {
    return (
      <View style={[styles.list, { paddingTop: 16 }]}>
        {Array.from({ length: 5 }).map((_, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.cardBackground, borderRadius: 12, padding: 14, marginBottom: 10, gap: 12 }}>
            <SkeletonBox width={44} height={44} borderRadius={8} />
            <View style={{ flex: 1, gap: 8 }}>
              <SkeletonBox width='70%' height={13} borderRadius={6} />
              <SkeletonBox width='45%' height={11} borderRadius={6} />
            </View>
            <View style={{ alignItems: 'flex-end', gap: 8 }}>
              <SkeletonBox width={48} height={11} borderRadius={6} />
              <SkeletonBox width={56} height={18} borderRadius={8} />
            </View>
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={styles.container}>
      <FlatList
        data={receipts}
        keyExtractor={(item) => item.id.toString()}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => { setRefreshing(true); await fetchReceipts(); setRefreshing(false); }}
            colors={[colors.primary]}
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.centered}>
            <Ionicons name="receipt-outline" size={56} color={colors.textMuted} />
            <Text style={styles.emptyText}>Kvitų nėra</Text>
            <Text style={styles.emptySubText}>Įkelkite pirkinių kvitą ir stebėkite savo išlaidas</Text>
            <TouchableOpacity style={styles.emptyButton} onPress={() => setUploadMenuOpen(true)}>
              <Text style={styles.emptyButtonText}>Įkelti kvitą</Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item }) => {
          if (item.id === -1) {
            return (
              <View style={[styles.card, styles.placeholderCard]}>
                <ActivityIndicator
                  size="small"
                  color={colors.primary}
                  style={{ marginRight: 12 }}
                />
                <Text style={styles.placeholderText}>Kvitas įkeliamas...</Text>
              </View>
            );
          }
          // Chain identity is carried by the logo on the left — the text row
          // just needs the specific store so we don't visually repeat.
          const shopHeadline =
            item.storeName || item.chainName || "Neatpažinta parduotuvė";
          const shopAddress = item.storeAddress || null;
          // Prefer the OCR'd shop date over the DB `receiptDate`
          // column. The column is set by `updateReceiptDetails` only
          // when the price-persist path completes; rows that only
          // reach `createReceipt` end up with the row's default
          // (insert time = upload time), which is what showed up
          // here as "the date of upload". `parsedData.footer.date`
          // is populated by the parser whenever the OCR has a usable
          // timestamp, so it's the source of truth for "when was the
          // shopping done".
          const parsedFooterDate = (() => {
              const pd = item.parsedData;
              if (!pd) return null;
              const obj = typeof pd === "string" ? safeJsonParse(pd) : pd;
              const raw = obj?.footer?.date ?? obj?.date ?? null;
              return typeof raw === "string" && raw.trim() ? raw : null;
          })();
          const dateSource = parsedFooterDate ?? item.receiptDate;
          const dateLabel = dateSource
            ? new Date(dateSource).toLocaleDateString("lt-LT")
            : "—";
          return (
            <TouchableOpacity
              style={[styles.card, hasPendingSwipes(item) && styles.cardPending]}
              onPress={() => {
                if (hasPendingSwipes(item)) {
                  router.push({ pathname: "/swipe/queue", params: { receiptId: String(item.id) } } as any);
                } else {
                  router.push(`/receipt-process?receiptId=${item.id}`);
                }
              }}
            >
              <View style={styles.cardLeft}>
                {item.chainLogoUrl ? (
                  <Image
                    source={{ uri: item.chainLogoUrl }}
                    style={styles.cardLogo}
                    resizeMode="contain"
                  />
                ) : (
                  <Ionicons name="receipt-outline" size={28} color={colors.primary} />
                )}
              </View>
              <View style={styles.cardContent}>
                <Text style={styles.cardTitle} numberOfLines={1}>
                  {shopHeadline}
                </Text>
                {shopAddress && (
                  <Text style={styles.cardAddress} numberOfLines={1}>
                    {shopAddress}
                  </Text>
                )}
              </View>
              <View style={styles.cardRight}>
                <Text style={styles.cardDate}>{dateLabel}</Text>
                <View
                  style={[
                    styles.statusBadge,
                    { backgroundColor: getStatusColor(item) },
                  ]}
                >
                  <Text style={styles.statusText}>
                    {getStatusText(item)}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          );
        }}
      />
      <TouchableOpacity
        style={[styles.fab, !isOnline && { opacity: 0.4 }]}
        onPress={() => {
          if (!isOnline) {
            Alert.alert(
              "Nėra interneto ryšio",
              "Kvitų įkėlimas neįmanomas be interneto. Prisijunk prie tinklo ir bandyk vėl.",
            );
            return;
          }
          setUploadMenuOpen(true);
        }}
      >
        <Ionicons name="add" size={28} color={colors.onPrimary} />
      </TouchableOpacity>

      <Modal
        visible={pdfConverting}
        transparent
        animationType="fade"
      >
        <View style={styles.menuBackdrop}>
          <View style={[styles.menuCard, { alignItems: "center", gap: 12 }]}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.menuTitle}>PDF konvertuojamas į vaizdą</Text>
          </View>
        </View>
      </Modal>

      <Modal
        visible={uploadMenuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setUploadMenuOpen(false)}
      >
        <Pressable style={styles.menuBackdrop} onPress={() => setUploadMenuOpen(false)}>
          <Pressable style={styles.menuCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.menuTitle}>Kvito įkėlimas</Text>

            <TouchableOpacity style={styles.menuRow} onPress={onPickCamera}>
              <Ionicons name="camera-outline" size={22} color={colors.primary} />
              <Text style={styles.menuRowText}>Fotografuoti</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.menuRow} onPress={onPickFile}>
              <Ionicons name="cloud-upload-outline" size={22} color={colors.primary} />
              <Text style={styles.menuRowText}>Įkelti</Text>
            </TouchableOpacity>

            {/* Preview-only mode is a parser-iteration tool, not a user
                feature — hide it from release builds. DEV_MODE is a
                compile-time boolean in constants/flags.ts; when false,
                the minifier drops this whole block. */}
            {DEV_MODE && (
              <TouchableOpacity
                style={styles.previewToggle}
                onPress={() => setPreviewOnly((v) => !v)}
              >
                <Ionicons
                  name={previewOnly ? "checkbox" : "square-outline"}
                  size={20}
                  color={previewOnly ? colors.primary : colors.textMuted}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.previewToggleText}>Peržiūra — neišsaugoti</Text>
                  <Text style={styles.previewToggleHint}>
                    OCR ir parserio išvestis rodoma, bet kvitas nesukuriamas duomenų bazėje.
                  </Text>
                </View>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={styles.menuCancel}
              onPress={() => setUploadMenuOpen(false)}
            >
              <Text style={styles.menuCancelText}>Atšaukti</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.pageBackground },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { padding: 16, paddingBottom: 80 },
  card: {
    backgroundColor: c.cardBackground,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    borderLeftWidth: 3,
    borderLeftColor: c.softAccent,
  },
  cardPending: {
    backgroundColor: c.primaryMuted,
    borderLeftColor: c.primary,
    shadowOpacity: 0.12,
  },
  cardLeft: { marginRight: 12, width: 36, alignItems: "center", justifyContent: "center" },
  cardLogo: { width: 32, height: 32 },
  cardContent: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 15, fontWeight: "600", color: c.textPrimary },
  cardAddress: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
  cardRight: { alignItems: "flex-end", marginLeft: 8 },
  cardDate: { fontSize: 12, color: c.textSecondary, marginBottom: 6 },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  statusText: { fontSize: 11, color: c.textInverse, fontWeight: "600" },
  emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600', marginTop: 16, textAlign: 'center' },
  emptySubText: { fontSize: 13, color: c.textMuted, marginTop: 6, textAlign: 'center', lineHeight: 18 },
  emptyButton: { marginTop: 20, backgroundColor: c.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24 },
  emptyButtonText: { color: c.onPrimary, fontWeight: '700', fontSize: 14 },
  fab: {
    position: "absolute",
    bottom: 24,
    right: 24,
    backgroundColor: c.primary,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
    shadowColor: c.primaryShadow,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
  },
  placeholderCard: {
    flexDirection: "row",
    alignItems: "center",
    opacity: 0.7,
  },
  placeholderText: {
    fontSize: 14,
    color: c.textSecondary,
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: c.overlayBackdrop,
    justifyContent: "center",
    padding: 24,
  },
  menuCard: {
    backgroundColor: c.cardBackground,
    borderRadius: 14,
    padding: 16,
    gap: 6,
  },
  menuTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: c.textPrimary,
    marginBottom: 4,
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  menuRowText: {
    fontSize: 15,
    color: c.textPrimary,
    fontWeight: "500",
  },
  previewToggle: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 8,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: c.borderSubtle,
  },
  previewToggleText: {
    fontSize: 14,
    color: c.textPrimary,
    fontWeight: "600",
  },
  previewToggleHint: {
    fontSize: 11,
    color: c.textMuted,
    marginTop: 2,
  },
  menuCancel: {
    alignItems: "center",
    paddingVertical: 12,
    marginTop: 4,
  },
  menuCancelText: {
    fontSize: 14,
    color: c.textSecondary,
    fontWeight: "600",
  },
});
