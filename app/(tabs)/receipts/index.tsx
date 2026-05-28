import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useSafeBottomTabBarHeight } from "../../../hooks/useSafeBottomTabBarHeight";
import { StoreChipBar } from "../../../components/StoreChipBar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useReceiptQueueStore, type QueueItem } from "../../../state/receiptQueueStore";
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
import { API_BASE_URL } from "../../../config/api";
import { getUserId } from "../../../config/user";
import { useTheme, type AppTheme } from "../../../constants/theme";
import { chainBrandName, chainBrandColor } from "../../../utils/chainBrandName";
import { SkeletonBox } from "../../../components/SkeletonBox";
import { PendingSwipesBanner } from "../../../components/PendingSwipesBanner";
import { DEV_MODE } from "../../../constants/flags";
import {
    clearReceiptDraft,
    loadReceiptDraft,
} from "../../../state/receiptDraft";
import { fetchWithTimeout, TIMEOUT_HEAVY_MS, TIMEOUT_STANDARD_MS } from "../../../utils/fetchWithTimeout";
import { formatDate } from "../../../utils/formatCurrency";
import { useNetworkStatus } from "../../../state/networkStatus";
import { useLevelStore } from "../../../state/levelStore";

interface Receipt {
  id: number;
  filePath: string;
  fileType: string;
  processingStatus: string;
  receiptDate: string | null;
  receiptNo: string | null;
  chainName: string | null;
  chainLogoUrl: string | null;
  chainMiniLogoUrl: string | null;
  storeName: string | null;
  storeAddress: string | null;
  mandatorySwipesRequired: number;
  mandatorySwipesCompleted: number;
  parsedData?: unknown;
}

/** Mixed-list discriminated union for FlatList rendering. */
type ListItem =
  | { kind: "queue"; data: QueueItem }
  | { kind: "section"; title: string; id: string }
  | { kind: "receipt"; data: Receipt };

const safeJsonParse = (raw: string): any => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

function queueStatusLabel(item: QueueItem, t: TFunction): string {
  if (item.status === "pending") return t('receipts.status.pending');
  if (item.status === "awaiting_network") return t('receipts.status.awaitingNetworkBadge');
  if (item.status === "error") {
    return item.error === "Kvitas jau įkeltas"
      ? t('receipts.status.duplicate')
      : t('receipts.status.failed');
  }
  const p = item.progress;
  if (!p) return t('receipts.status.processing');
  if (p.startsWith("Nusk")) return t('receipts.status.scanning');
  if (p.startsWith("Atpažįst") || p.includes("/")) return t('receipts.status.recognising');
  if (p.startsWith("Išsaug")) return t('receipts.status.saving');
  return t('receipts.status.processing');
}

function queueCardTitle(item: QueueItem, t: TFunction): string {
  if (item.name) return item.name;
  return t('receipts.status.defaultTitle');
}

function queueProgressFraction(item: QueueItem): number | null {
  if (item.status !== "processing") return null;
  if (item.progressTotal && item.progressTotal > 0 && item.progressDone != null) {
    return Math.min(1, item.progressDone / item.progressTotal);
  }
  if (item.progress?.startsWith("Išsaug")) return 0.95;
  if (item.progress?.startsWith("Atpažįst")) return 0.4;
  return null;
}

const hasPendingSwipes = (item: Receipt) =>
  item.processingStatus === "completed" &&
  (item.mandatorySwipesRequired ?? 0) > 0 &&
  (item.mandatorySwipesCompleted ?? 0) < (item.mandatorySwipesRequired ?? 0);

export default function ReceiptsScreen() {
  const colors = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const tabBarHeight = useSafeBottomTabBarHeight();
  const checkCandidate = useLevelStore(s => s.checkCandidate);
  useFocusEffect(useCallback(() => { checkCandidate(); }, [checkCandidate]));
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [selectedChain, setSelectedChain] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();
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
      router.push(`/receipt/capture?preview=true` as any);
    } else {
      router.push("/receipt/capture" as any);
    }
  };

  const onPickFile = async () => {
    setUploadMenuOpen(false);
    await new Promise(resolve => setTimeout(resolve, 300));
    const picked = await DocumentPicker.getDocumentAsync({
      type: ["image/*", "application/pdf"],
      copyToCacheDirectory: true,
      multiple: true,
    });
    if (picked.canceled || !picked.assets?.length) return;

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
      Alert.alert(t('receipts.uploadFail.title'), t('receipts.uploadFail.body'));
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
      setLoading((prev) => (prev ? false : prev));
    }
  };

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

  const lastCompletedAt = useReceiptQueueStore((s) => s.lastCompletedAt);
  useEffect(() => {
    if (!lastCompletedAt) return;
    fetchReceipts();
  }, [lastCompletedAt]);

  useEffect(() => {
    if (recentIds.length === 0) return;
    const anyStillPending = receipts.some(
      (r) => recentIds.includes(r.id) && hasPendingSwipes(r),
    );
    const anyKnownRecent = receipts.some((r) => recentIds.includes(r.id));
    if (!anyStillPending && anyKnownRecent) {
      pruneRecentIds([]);
    }
  }, [receipts, recentIds, pruneRecentIds]);

  useEffect(() => {
    let active = true;
    (async () => {
      const draft = await loadReceiptDraft();
      if (!active) return;
      if (!draft) return;
      Alert.alert(
        t('receipts.resume.title'),
        t('receipts.resume.body'),
        [
          {
            text: t('common.cancel'),
            style: "cancel",
            onPress: () => {
              clearReceiptDraft().catch(() => {});
            },
          },
          {
            text: t('common.continue'),
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
    if (hasPendingSwipes(item)) return t('receipts.status.helpRecognise');
    switch (item.processingStatus) {
      case "completed":
        return t('receipts.status.completed');
      case "processing":
        return t('receipts.status.processing');
      case "failed":
        return t('receipts.status.failed');
      default:
        return t('receipts.status.pending');
    }
  };

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

  const chainFilters = useMemo(() => {
    const acc = new Map<string, { name: string; logoUrl: string | null; count: number }>();
    for (const r of receipts) {
      if (!r.chainName) continue;
      const logo = r.chainMiniLogoUrl ?? r.chainLogoUrl ?? null;
      const existing = acc.get(r.chainName);
      if (existing) {
        existing.count += 1;
        if (!existing.logoUrl && logo) existing.logoUrl = logo;
      } else {
        acc.set(r.chainName, { name: r.chainName, logoUrl: logo, count: 1 });
      }
    }
    return Array.from(acc.values()).sort((a, b) => b.count - a.count);
  }, [receipts]);

  useEffect(() => {
    if (selectedChain === null) return;
    if (!chainFilters.some((c) => c.name === selectedChain)) {
      setSelectedChain(null);
    }
  }, [chainFilters, selectedChain]);

  const listData: ListItem[] = useMemo(() => {
    const out: ListItem[] = [];
    for (const q of queueItems) out.push({ kind: "queue", data: q });
    const filtered = selectedChain
      ? receipts.filter((r) => r.chainName === selectedChain)
      : receipts;
    const recent = filtered.filter((r) => recentIds.includes(r.id));
    const older = filtered.filter((r) => !recentIds.includes(r.id));
    if (recent.length > 0) {
      out.push({ kind: "section", title: t('receipts.sections.new'), id: "sec-nauji" });
      for (const r of recent) out.push({ kind: "receipt", data: r });
      if (older.length > 0) {
        out.push({ kind: "section", title: t('receipts.sections.earlier'), id: "sec-anksciau" });
      }
    }
    for (const r of older) out.push({ kind: "receipt", data: r });
    return out;
  }, [queueItems, receipts, recentIds, selectedChain]);

  if (loading) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: t('tabs.receipts') }} />
        <View style={{
          backgroundColor: colors.cardBackground,
          borderBottomWidth: 0.5, borderBottomColor: colors.border,
          flexDirection: 'row', gap: 8,
          paddingHorizontal: 12, paddingVertical: 10,
        }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonBox key={i} width={i === 0 ? 64 : 80} height={32} borderRadius={20} />
          ))}
        </View>
        <View style={[styles.list, { paddingTop: 16 }]}>
          {Array.from({ length: 5 }).map((_, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.cardBackground, borderRadius: 12, padding: 14, marginBottom: 10, gap: 12 }}>
              <SkeletonBox width={32} height={32} borderRadius={6} />
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
      </View>
    );
  }

  const renderQueueCard = (item: QueueItem) => {
    const statusLabel = queueStatusLabel(item, t);
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
      if (isAwaiting) return t('receipts.status.awaitingNetwork');
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
              {queueCardTitle(item, t)}
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
      item.storeName || item.chainName || t('receipts.status.unknownStore');
    const shopAddress = item.storeAddress || null;
    const parsedFooterDate = (() => {
      const pd = item.parsedData;
      if (!pd) return null;
      const obj = typeof pd === "string" ? safeJsonParse(pd) : pd;
      const raw = obj?.footer?.date ?? obj?.date ?? null;
      return typeof raw === "string" && raw.trim() ? raw : null;
    })();
    const dateSource = parsedFooterDate ?? item.receiptDate;
    const dateLabel = dateSource ? formatDate(dateSource) : "—";
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
          {item.chainLogoUrl || item.chainName ? (
            <View style={[styles.cardLogo, { backgroundColor: chainBrandColor(item.chainName ?? '') }]}>
              {item.chainMiniLogoUrl ?? item.chainLogoUrl ? (
                <Image
                  source={{ uri: (item.chainMiniLogoUrl ?? item.chainLogoUrl) as string }}
                  style={styles.cardLogoImage}
                  resizeMode="contain"
                />
              ) : (
                <Text style={styles.cardLogoFallback}>{(item.chainName ?? '?')[0]}</Text>
              )}
            </View>
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
      <Stack.Screen options={{ title: t('tabs.receipts') }} />
      {chainFilters.length > 1 && (
        <StoreChipBar
          chips={chainFilters.map(f => ({
            id: f.name,
            label: chainBrandName(f.name),
            logoUrl: f.logoUrl,
          }))}
          selectedId={selectedChain}
          onSelect={id => setSelectedChain(id as string | null)}
          allLabel={t('receipts.filterAll')}
        />
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
              disabledHint={bannerDisabled ? t('receipts.status.bannerDisabled') : undefined}
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
              <Text style={styles.emptyText}>{t('receipts.empty')}</Text>
              <Text style={styles.emptySubText}>{t('receipts.emptyBody')}</Text>
              <TouchableOpacity style={styles.emptyButton} onPress={() => setUploadMenuOpen(true)}>
                <Text style={styles.emptyButtonText}>{t('receipts.uploadCta')}</Text>
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
        style={[styles.fab, { bottom: tabBarHeight + 16 }, !isOnline && { opacity: 0.4 }]}
        onPress={() => {
          if (!isOnline) {
            Alert.alert(t('receipts.offline.title'), t('receipts.offline.body'));
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
            <Text style={styles.menuTitle}>{t('receipts.menu.pdfConverting')}</Text>
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
            <Text style={styles.menuTitle}>{t('receipts.menu.uploadTitle')}</Text>

            <TouchableOpacity style={styles.menuRow} onPress={onPickCamera}>
              <Ionicons name="camera-outline" size={22} color={colors.primary} />
              <Text style={styles.menuRowText}>{t('receipts.menu.uploadCamera')}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.menuRow} onPress={onPickFile}>
              <Ionicons name="cloud-upload-outline" size={22} color={colors.primary} />
              <Text style={styles.menuRowText}>{t('receipts.menu.uploadAction')}</Text>
            </TouchableOpacity>

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
                  <Text style={styles.previewToggleText}>{t('receipts.menu.previewToggle')}</Text>
                  <Text style={styles.previewToggleHint}>
                    {t('receipts.menu.previewHint')}
                  </Text>
                </View>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={styles.menuCancel}
              onPress={() => setUploadMenuOpen(false)}
            >
              <Text style={styles.menuCancelText}>{t('common.cancel')}</Text>
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
  cardLogo: {
    width: 32, height: 32, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  cardLogoImage: { width: 22, height: 22 },
  cardLogoFallback: { fontSize: 14, fontWeight: '700', color: '#FFFFFF' },
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
    right: 20,
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
