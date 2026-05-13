import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useReceiptQueueStore, type QueueItem } from "../../state/receiptQueueStore";
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Image,
    Modal,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { API_BASE_URL } from "../../config/api";
import { getUserId } from "../../config/user";
import { useTheme, type AppTheme } from "../../constants/theme";
import { SkeletonBox } from "../../components/SkeletonBox";
import { PendingSwipesBanner } from "../../components/PendingSwipesBanner";
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

/** Mixed-list discriminated union for FlatList rendering. */
type ListItem =
  | { kind: "queue"; data: QueueItem }
  | { kind: "section"; title: string; id: string }
  | { kind: "receipt"; data: Receipt };

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

function queueStatusLabel(item: QueueItem): string {
  if (item.status === "pending") return "Laukiama";
  if (item.status === "awaiting_network") return "Laukiama tinklo";
  if (item.status === "error") {
    return item.error === "Kvitas jau įkeltas" ? "Jau įkeltas" : "Nepavyko";
  }
  // processing
  const p = item.progress;
  if (!p) return "Apdorojama";
  if (p.startsWith("Nusk")) return "Nuskaitoma";
  if (p.startsWith("Atpažįst") || p.includes("/")) return "Atpažįstama";
  if (p.startsWith("Išsaug")) return "Įkeliama";
  return "Apdorojama";
}

/** Title that appears as the queue card heading. Filename when known. */
function queueCardTitle(item: QueueItem): string {
  if (item.name) return item.name;
  return "Kvitas";
}

/** Progress fraction 0..1 for the bottom bar. Returns null for indeterminate. */
function queueProgressFraction(item: QueueItem): number | null {
  if (item.status !== "processing") return null;
  if (item.progressTotal && item.progressTotal > 0 && item.progressDone != null) {
    return Math.min(1, item.progressDone / item.progressTotal);
  }
  if (item.progress?.startsWith("Išsaug")) return 0.95;
  if (item.progress?.startsWith("Atpažįst")) return 0.4;
  return null; // indeterminate (OCR phase)
}

const hasPendingSwipes = (item: Receipt) =>
  item.processingStatus === "completed" &&
  (item.mandatorySwipesRequired ?? 0) > 0 &&
  (item.mandatorySwipesCompleted ?? 0) < (item.mandatorySwipesRequired ?? 0);

export default function ReceiptsScreen() {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const checkCandidate = useLevelStore(s => s.checkCandidate);
  useFocusEffect(useCallback(() => { checkCandidate(); }, [checkCandidate]));
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  // Chain filter for the list. `null` = "Visi" (show every chain).
  // Resets on focus only when the underlying chain disappears from the
  // user's receipts (e.g. after a delete), so navigating away and back
  // preserves the user's current filter.
  const [selectedChain, setSelectedChain] = useState<string | null>(null);
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
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [previewOnly, setPreviewOnly] = useState(false);
  const [pdfConverting, setPdfConverting] = useState(false);
  const queueItems = useReceiptQueueStore((s) => s.items);
  const removeQueueItem = useReceiptQueueStore((s) => s.removeItem);
  const recentIds = useReceiptQueueStore((s) => s.recentIds);
  const pruneRecentIds = useReceiptQueueStore((s) => s.pruneRecentIds);
  const addItems = useReceiptQueueStore((s) => s.addItems);

  const onPickCamera = () => {
    setUploadMenuOpen(false);
    if (previewOnly) {
      // Camera preview mode still needs a URI path; capture screen handles it.
      router.push(`/receipt/capture?preview=true` as any);
    } else {
      router.push("/receipt/capture" as any);
    }
  };

  // File upload — single or multiple — always enqueues. The interactive
  // /receipt-process screen is reachable via camera capture or by tapping
  // an existing receipt; never auto-navigated from file pick.
  const onPickFile = async () => {
    setUploadMenuOpen(false);
    await new Promise(resolve => setTimeout(resolve, 300));
    const picked = await DocumentPicker.getDocumentAsync({
      type: ["image/*", "application/pdf"],
      copyToCacheDirectory: true,
      multiple: true,
    });
    if (picked.canceled || !picked.assets?.length) return;

    // Show the PDF spinner only if any picked file is a PDF — for plain
    // images we add to the queue immediately.
    const hasPdf = picked.assets.some(a =>
      (a.mimeType === 'application/pdf') ||
      (a.name?.toLowerCase().endsWith('.pdf') ?? false)
    );
    if (hasPdf) setPdfConverting(true);

    const entries: { uris: string[]; name?: string }[] = [];
    for (const asset of picked.assets) {
      const mimeType = asset.mimeType ?? '';
      const isPdf = mimeType === 'application/pdf' || (asset.name?.toLowerCase().endsWith('.pdf') ?? false);
      if (isPdf) {
        try {
          const pdfBase64 = await FileSystem.readAsStringAsync(asset.uri, {
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
            console.warn(`[batch] PDF conversion HTTP ${res.status} for ${asset.name}`);
            continue;
          }
          const { images } = await res.json();
          if (!Array.isArray(images) || images.length === 0) continue;
          const timestamp = Date.now();
          const paths: string[] = [];
          for (let i = 0; i < images.length; i++) {
            const path = `${FileSystem.cacheDirectory}batch-pdf-${timestamp}-${i}.png`;
            await FileSystem.writeAsStringAsync(path, images[i], {
              encoding: FileSystem.EncodingType.Base64,
            });
            paths.push(path);
          }
          entries.push({ uris: paths, name: asset.name ?? undefined });
        } catch (e) {
          console.warn("[batch] PDF conversion failed:", e);
        }
      } else {
        entries.push({ uris: [asset.uri], name: asset.name ?? undefined });
      }
    }
    if (hasPdf) setPdfConverting(false);
    if (entries.length === 0) {
      Alert.alert(
        "Įkėlimas nepavyko",
        "Nepavyko paruošti nė vieno failo. Patikrinkite internetą ir bandykite vėl.",
      );
      return;
    }
    addItems(entries);
  };

  const fetchReceipts = async () => {
    try {
      const userId = await getUserId();
      const response = await fetchWithTimeout(
        `${API_BASE_URL}/api/users/${userId}/receipts`,
        { timeoutMs: TIMEOUT_STANDARD_MS },
      );
      const data = await response.json();
      const rows = Array.isArray(data) ? data : [];
      setReceipts(rows);
    } catch (error) {
      console.error("Failed to fetch receipts:", error);
    } finally {
      // Only the very first fetch needs to flip the initial spinner off.
      // Background refreshes leave `loading` alone (it's already false).
      setLoading((prev) => (prev ? false : prev));
    }
  };

  // Safety-net poll for legacy server-side processing. With the new
  // batch flow, receipts arrive as `completed` — this rarely engages.
  // Memoising the dep as a boolean prevents the interval from being
  // torn down and recreated every time `setReceipts` runs.
  const hasPendingProcessing = useMemo(
    () =>
      receipts.some(
        (r) =>
          r.processingStatus === "processing" ||
          r.processingStatus === "pending",
      ),
    [receipts],
  );
  useEffect(() => {
    if (!hasPendingProcessing) return;
    const interval = setInterval(fetchReceipts, 3000);
    return () => clearInterval(interval);
  }, [hasPendingProcessing]);
  useFocusEffect(
    useCallback(() => {
      fetchReceipts();
    }, []),
  );

  // Refresh receipts list whenever a batch queue item finishes processing.
  const lastCompletedAt = useReceiptQueueStore((s) => s.lastCompletedAt);
  useEffect(() => {
    if (!lastCompletedAt) return;
    fetchReceipts();
  }, [lastCompletedAt]);

  // Clear recentIds (and thus the "Nauji" section + banner) only once
  // the *entire* batch is done — i.e., no recent receipt still has
  // pending swipes. Pruning individuals would split the batch visually,
  // making receipts hop from "Nauji" to "Anksčiau" while their siblings
  // are still in flight. Worse UX than keeping them grouped.
  useEffect(() => {
    if (recentIds.length === 0) return;
    const anyStillPending = receipts.some(
      (r) => recentIds.includes(r.id) && hasPendingSwipes(r),
    );
    // Defensive: also clear if recentIds references receipts that no
    // longer exist server-side (deleted, never persisted). Otherwise
    // a ghost ID would block the batch from ever closing out.
    const anyKnownRecent = receipts.some((r) => recentIds.includes(r.id));
    if (!anyStillPending && anyKnownRecent) {
      pruneRecentIds([]);
    }
  }, [receipts, recentIds, pruneRecentIds]);

  // Resume prompt: if a draft was saved by a previous /receipt-process
  // session that didn't survive to POST, offer the user the option to
  // pick up where they left off.
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

  // ── Derived: pending-swipes banner state ─────────────────────────
  const recentReceiptsWithPending = useMemo(
    () => receipts.filter((r) => recentIds.includes(r.id) && hasPendingSwipes(r)),
    [receipts, recentIds],
  );
  const pendingSwipesCount = useMemo(
    () =>
      recentReceiptsWithPending.reduce(
        (sum, r) =>
          sum +
          Math.max(0, (r.mandatorySwipesRequired ?? 0) - (r.mandatorySwipesCompleted ?? 0)),
        0,
      ),
    [recentReceiptsWithPending],
  );
  const batchInFlight = queueItems.some(
    (i) => i.status === "pending" || i.status === "processing",
  );
  const showBanner = pendingSwipesCount > 0 && !batchInFlight;
  const bannerDisabled = !isOnline;

  const onStartBanner = () => {
    const ids = recentReceiptsWithPending.map((r) => r.id);
    if (ids.length === 0) return;
    router.push({
      pathname: "/swipe/queue",
      params: {
        receiptIds: ids.join(","),
        returnTo: "/(tabs)/receipts",
      },
    } as any);
  };

  // ── Derived: chain filter chips ──────────────────────────────────
  // Aggregate receipts by chainName, sort by count desc so the chains
  // the user actually shops at most appear first. Chains with zero
  // receipts (and the bucket for receipts whose chain couldn't be
  // matched — chainName null) don't get their own chip.
  const chainFilters = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of receipts) {
      if (!r.chainName) continue;
      counts.set(r.chainName, (counts.get(r.chainName) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [receipts]);

  // Drop the selected filter if the underlying chain no longer has
  // receipts (e.g. user deleted the last one). Prevents the UI from
  // sitting on a now-empty filter that hides the whole list.
  useEffect(() => {
    if (selectedChain === null) return;
    if (!chainFilters.some((c) => c.name === selectedChain)) {
      setSelectedChain(null);
    }
  }, [chainFilters, selectedChain]);

  // ── Derived: section-aware data array ────────────────────────────
  const listData: ListItem[] = useMemo(() => {
    const out: ListItem[] = [];
    // Queue items always show — they're transient processing state and
    // a chain filter wouldn't apply (chain isn't resolved yet).
    for (const q of queueItems) out.push({ kind: "queue", data: q });
    const filtered = selectedChain
      ? receipts.filter((r) => r.chainName === selectedChain)
      : receipts;
    const recent = filtered.filter((r) => recentIds.includes(r.id));
    const older = filtered.filter((r) => !recentIds.includes(r.id));
    if (recent.length > 0) {
      out.push({ kind: "section", title: "Nauji", id: "sec-nauji" });
      for (const r of recent) out.push({ kind: "receipt", data: r });
      if (older.length > 0) {
        out.push({ kind: "section", title: "Anksčiau", id: "sec-anksciau" });
      }
    }
    for (const r of older) out.push({ kind: "receipt", data: r });
    return out;
  }, [queueItems, receipts, recentIds, selectedChain]);

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

  const renderQueueCard = (item: QueueItem) => {
    const statusLabel = queueStatusLabel(item);
    const isDuplicate = item.error === "Kvitas jau įkeltas";
    const isError = item.status === "error";
    const isPending = item.status === "pending";
    const isAwaiting = item.status === "awaiting_network";
    const isProcessing = item.status === "processing";

    const statusColor = isError
      ? isDuplicate ? colors.textMuted : colors.error
      : isAwaiting
      ? colors.warning
      : isPending
      ? colors.textMuted
      : colors.primary;

    const leftIcon = (() => {
      if (isError) return (
        <Ionicons name={isDuplicate ? "copy-outline" : "alert-circle-outline"} size={28} color={statusColor} />
      );
      if (isAwaiting) return <Ionicons name="cloud-offline-outline" size={28} color={colors.warning} />;
      if (isPending) return <Ionicons name="time-outline" size={28} color={colors.textMuted} />;
      return <ActivityIndicator size="small" color={colors.primary} />;
    })();

    const subline = (() => {
      if (isError) return item.error && !isDuplicate ? item.error : null;
      if (isAwaiting) return "Atnaujinsime, kai grįš internetas";
      if (isPending) return null;
      return item.progress ?? null;
    })();

    const progressFrac = queueProgressFraction(item);

    return (
      <View
        key={item.id}
        style={[
          styles.card,
          styles.queueCard,
          isError && !isDuplicate && { borderLeftColor: colors.error },
          isAwaiting && { borderLeftColor: colors.warning },
        ]}
      >
        <View style={{ marginRight: 12 }}>{leftIcon}</View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={styles.queueTitle} numberOfLines={1}>
              {queueCardTitle(item)}
            </Text>
            <View style={[styles.statusBadge, { backgroundColor: statusColor }]}>
              <Text style={styles.statusText}>{statusLabel}</Text>
            </View>
          </View>
          {subline ? (
            <Text style={styles.queueSubline} numberOfLines={1}>{subline}</Text>
          ) : null}
        </View>
        {isError && (
          <TouchableOpacity onPress={() => removeQueueItem(item.id)} style={{ paddingLeft: 8 }} hitSlop={8}>
            <Ionicons name="close" size={20} color={colors.textMuted} />
          </TouchableOpacity>
        )}
        {/* Bottom progress bar: 4px sliver. Determinate when we know the
            product count, indeterminate-ish (partial fill) otherwise. */}
        {isProcessing && (
          <View style={styles.progressTrack} pointerEvents="none">
            <View
              style={[
                styles.progressFill,
                progressFrac != null
                  ? { width: `${Math.max(8, progressFrac * 100)}%` }
                  : styles.progressIndeterminate,
              ]}
            />
          </View>
        )}
      </View>
    );
  };

  const renderReceiptCard = (item: Receipt) => {
    const shopHeadline =
      item.storeName || item.chainName || "Neatpažinta parduotuvė";
    const shopAddress = item.storeAddress || null;
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
            router.push({
              pathname: "/swipe/queue",
              params: {
                receiptIds: String(item.id),
                returnTo: "/(tabs)/receipts",
              },
            } as any);
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
  };

  return (
    <View style={styles.container}>
      {/* Chain filter chips — own section under the navbar, white
          background continuous with the (now-white) navbar above.
          Hidden when the user has no receipts yet (nothing to filter)
          or only a single chain (filter would have no effect). */}
      {chainFilters.length > 1 && (
        <View style={styles.filterBar}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterScroll}
          >
            <TouchableOpacity
              style={[styles.chip, selectedChain === null && styles.chipActive]}
              onPress={() => setSelectedChain(null)}
            >
              <Text style={[styles.chipText, selectedChain === null && styles.chipTextActive]}>
                Visi
              </Text>
            </TouchableOpacity>
            {chainFilters.map((f) => {
              const active = selectedChain === f.name;
              return (
                <TouchableOpacity
                  key={f.name}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setSelectedChain(f.name)}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {f.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}
      <FlatList
        data={listData}
        keyExtractor={(it) =>
          it.kind === "queue" ? `q-${it.data.id}` :
          it.kind === "section" ? it.id :
          `r-${it.data.id}`
        }
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          showBanner ? (
            <PendingSwipesBanner
              pendingCount={pendingSwipesCount}
              disabled={bannerDisabled}
              disabledHint={bannerDisabled ? "Laukiama interneto" : undefined}
              onPress={onStartBanner}
            />
          ) : null
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => { setRefreshing(true); await fetchReceipts(); setRefreshing(false); }}
            colors={[colors.primary]}
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={
          queueItems.length === 0 ? (
            <View style={styles.centered}>
              <Ionicons name="receipt-outline" size={56} color={colors.textMuted} />
              <Text style={styles.emptyText}>Kvitų nėra</Text>
              <Text style={styles.emptySubText}>Įkelkite pirkinių kvitą ir stebėkite savo išlaidas</Text>
              <TouchableOpacity style={styles.emptyButton} onPress={() => setUploadMenuOpen(true)}>
                <Text style={styles.emptyButtonText}>Įkelti kvitą</Text>
              </TouchableOpacity>
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          if (item.kind === "queue") return renderQueueCard(item.data);
          if (item.kind === "section") {
            return (
              <Text style={styles.sectionHeader}>{item.title}</Text>
            );
          }
          return renderReceiptCard(item.data);
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

  // ── Chain filter chips ───────────────────────────────────────────
  // Visual + structural copy of the L2-category browse screen's
  // bubble row so the two screens read as the same component family.
  filterBar: {
    backgroundColor: c.cardBackground,
    borderBottomWidth: 0.5,
    borderBottomColor: c.border,
    flexGrow: 0,
    flexShrink: 0,
  },
  filterScroll: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.cardBackground,
  },
  chipActive: {
    backgroundColor: c.primary,
    borderColor: c.primary,
  },
  chipText: {
    fontSize: 13,
    color: c.textPrimary,
  },
  chipTextActive: {
    color: c.onPrimary,
    fontWeight: "600",
  },
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
  queueCard: {
    paddingBottom: 18,
    overflow: "hidden",
    position: "relative",
    borderLeftColor: c.primary,
  },
  queueTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: c.textPrimary,
    flex: 1,
    minWidth: 0,
  },
  queueSubline: {
    fontSize: 12,
    color: c.textMuted,
    marginTop: 4,
  },
  progressTrack: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 4,
    backgroundColor: c.surfaceMuted,
  },
  progressFill: {
    height: "100%",
    backgroundColor: c.primary,
    borderTopRightRadius: 2,
  },
  progressIndeterminate: {
    width: "30%",
    opacity: 0.7,
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
  sectionHeader: {
    fontSize: 11,
    fontWeight: "700",
    color: c.textMuted,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginTop: 4,
    marginBottom: 8,
    paddingHorizontal: 2,
  },
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
