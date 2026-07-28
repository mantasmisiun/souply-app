import {
    Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { useFocusEffect,
    useRouter } from "expo-router";
import { StoreFilterButton } from "../../components/StoreFilterButton";
import { DateFilterButton } from "../../components/DateFilterButton";
import type { FilterOption } from "../../components/FilterDropdownModal";
import { useCallback,
    useEffect,
    useMemo,
    useRef,
    useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useReceiptQueueStore,
    type QueueItem } from "../../state/receiptQueueStore";
import {
    ActivityIndicator,
    Alert,
    SectionList,
    Modal,
    Platform,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { API_BASE_URL } from "../../config/api";
import { getUserId } from "../../config/user";
import { useTheme, spacing, radius, elevation, iconSize, typography, type AppTheme } from "../../constants/theme";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenHeading } from "../../components/ScreenHeading";
import { useCollapsingHeader, CollapsingHeader } from "../../components/CollapsingHeader";
import { chainBrandName, chainIdByName } from "../../utils/chainBrandName";
import { launchDocumentScanner } from "../../utils/launchDocumentScanner";
import { looksLikePdf } from "../../utils/pdfToImages";
import { buildReceiptDotMap, parseLooseDate, sameDay } from "../../utils/receiptDots";
import { receiptFooterDateStr } from "../../utils/receiptFooterDate";
import { ChainLogoChip } from "../../components/ChainLogoChip";
import { SkeletonBox } from "../../components/SkeletonBox";
import { PendingSwipesBanner } from "../../components/PendingSwipesBanner";
import { DEV_MODE } from "../../constants/flags";
import {
    clearReceiptDraft,
    loadReceiptDraft,
    claimResumePrompt,
    unclaimResumePrompt,
} from "../../state/receiptDraft";
import { useScanSession, isSessionLive, consumeSession } from "../../state/scanSession";
import { fetchWithTimeout, TIMEOUT_STANDARD_MS } from "../../utils/fetchWithTimeout";
import { formatDate } from "../../utils/formatCurrency";
import { useNetworkStatus } from "../../state/networkStatus";
import { useLevelStore } from "../../state/levelStore";
import { useSettingsStore } from "../../state/settingsStore";

// The resume-prompt one-shot now lives in state/receiptDraft.ts (claim/unclaim/
// arm) so saving a NEW draft re-arms it — the old module flag was claimed once
// at app launch (when there was no draft yet) and never fired again, so a scan
// started mid-session could never be resumed from this tab. A module-level
// in-flight guard still protects against a remount stacking a second Alert.
let resumeCheckInFlight = false;

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
  /** Explicit footer date from the slimmed endpoint (JSON_EXTRACT server-side). */
  receiptFooterDate?: string | null;
  /** Legacy blob — only present on an un-updated server; used as fallback. */
  parsedData?: unknown;
}

/** Mixed-list discriminated union for FlatList rendering. */
type ListItem =
  | { kind: "queue"; data: QueueItem }
  | { kind: "section"; title: string; id: string }
  | { kind: "receipt"; data: Receipt };

// ── Receipt DATE (the date printed on the receipt, not the upload time) ──
// The receipt's own footer date — the explicit `receiptFooterDate` field from
// the slimmed endpoint, falling back to the legacy parsedData blob — takes
// priority over the stored receiptDate column. Same source the card shows.
const receiptDateObj = (r: Receipt): Date | null =>
  parseLooseDate(receiptFooterDateStr(r) ?? r.receiptDate);

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

// SectionList gives a native sticky section header for the filter chips while
// the large title scrolls away above it (reanimated has no prebuilt one).
const AnimatedSectionList = Animated.createAnimatedComponent(SectionList as typeof SectionList<ListItem>);

export default function ReceiptsScreen() {
  const colors = useTheme();
  const header = useCollapsingHeader();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // Pushed route (Souply 2.0): no tab bar below — clear only the system inset.
  const tabBarHeight = insets.bottom;
  const checkCandidate = useLevelStore(s => s.checkCandidate);
  useFocusEffect(useCallback(() => { checkCandidate(); }, [checkCandidate]));
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  // Store filter: null = all stores; otherwise the explicit checked chainId set.
  const [selectedChainIds, setSelectedChainIds] = useState<Set<number> | null>(null);
  // Date filter: null = no filter; otherwise show only that exact day.
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();
  const isOnline = useNetworkStatus((s) => s.isOnline);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [previewOnly, setPreviewOnly] = useState(false);
  // DEV-ONLY: long-press a receipt for a small action menu (Re-OCR + hard-delete).
  const [deleteTarget, setDeleteTarget] = useState<Receipt | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reocring, setReocring] = useState(false);
  const queueItems = useReceiptQueueStore((s) => s.items);
  const removeQueueItem = useReceiptQueueStore((s) => s.removeItem);
  // Live scan session (interactive Analyze scan running in the background —
  // the user navigated away mid-processing). Rendered as a card above the
  // list; tapping re-attaches by re-opening /receipt-process with the
  // session's original entry params.
  const scanPhase = useScanSession((s) => s.phase);
  const scanConsumed = useScanSession((s) => s.consumed);
  const scanMatchProgress = useScanSession((s) => s.matchProgress);
  const scanEntryParams = useScanSession((s) => s.opts?.entryParams);
  const scanSessionId = useScanSession((s) => s.sessionId);
  const scanFailMessage = useScanSession((s) => s.failMessage);
  // A FAILED scan card is informational, exactly like a duplicate queue card:
  // no navigation target exists any more (the session bailed), so it offers
  // only ✕ and auto-dismisses on the same 4 s the duplicate card uses.
  useEffect(() => {
    if (scanPhase !== "failed" || scanConsumed || scanSessionId === 0) return;
    const t = setTimeout(() => consumeSession(scanSessionId), 4000);
    return () => clearTimeout(t);
  }, [scanPhase, scanConsumed, scanSessionId]);
  const liveScanVisible =
    scanPhase === "processing" || scanPhase === "input" || scanPhase === "saving" ||
    ((scanPhase === "done" || scanPhase === "failed") && !scanConsumed);
  const recentIds = useReceiptQueueStore((s) => s.recentIds);
  const pruneRecentIds = useReceiptQueueStore((s) => s.pruneRecentIds);
  const addItems = useReceiptQueueStore((s) => s.addItems);

  // Default scan: the OS document scanner (native edge-detect + auto-capture +
  // de-skew). Covers normal-length receipts.
  const onPickCamera = () => {
    setUploadMenuOpen(false);
    if (!isOnline) {
      // The interactive scan needs the server (matching + save) — the offline
      // story for camera captures is the next-round queue routing.
      setTimeout(() => Alert.alert(t('receipts.offline.title'), t('receipts.offline.body')), 350);
      return;
    }
    // The dismiss-before-present delay now lives inside launchDocumentScanner,
    // so every scan entry point (here, shopping list, fail-gate retry) is guarded.
    launchDocumentScanner(router, { preview: previewOnly });
  };

  // iOS: presenting the document picker while the upload-menu Modal is still
  // animating out fails SILENTLY (UIKit refuses a present-during-dismiss) —
  // the reported "tap upload, nothing happens". Defer the action to the
  // Modal's onDismiss (fires when the animation completes; iOS-only event).
  // Android keeps the straight 300ms delay — onDismiss doesn't fire there.
  const pendingMenuActionRef = useRef<(() => void) | null>(null);
  const closeUploadMenuThen = (action: () => void) => {
    if (Platform.OS === 'ios') {
      pendingMenuActionRef.current = action;
      setUploadMenuOpen(false);
    } else {
      setUploadMenuOpen(false);
      setTimeout(action, 300);
    }
  };

  const onPickFile = () => closeUploadMenuThen(pickFiles);
  const pickFiles = async () => {
    const picked = await DocumentPicker.getDocumentAsync({
      type: ["image/*", "application/pdf"],
      copyToCacheDirectory: true,
      multiple: true,
    });
    if (picked.canceled || !picked.assets?.length) return;

    // PDFs enqueue AS-IS — page conversion runs as the queue item's first
    // processing stage (its card shows "Converting PDF…"), no blocking modal.
    const entries = picked.assets.map((asset) => ({
      uris: [asset.uri],
      name: asset.name ?? undefined,
      isPdf: looksLikePdf(asset.uri, asset.mimeType, asset.name),
    }));
    if (entries.length === 0) {
      Alert.alert(t('receipts.uploadFail.title'), t('receipts.uploadFail.body'));
      return;
    }
    addItems(entries);
  };

  // Change fingerprint over the fields the list actually renders — a focus
  // refetch (or a 3s pending-processing tick) whose payload is unchanged
  // commits NO state, so it can't re-render the whole list (the silent
  // refetch treatment; cf. app/(tabs)/basket/index.tsx's focus fetch).
  const receiptsFingerprintRef = useRef<string | null>(null);
  const fetchReceipts = async () => {
    try {
      const userId = await getUserId();
      const response = await fetchWithTimeout(
        `${API_BASE_URL}/api/users/${userId}/receipts`,
        { timeoutMs: TIMEOUT_STANDARD_MS },
      );
      const data = await response.json();
      const rows: Receipt[] = Array.isArray(data) ? data : [];
      const fp = rows
        .map((r) =>
          `${r.id}|${r.processingStatus}|${r.receiptDate ?? ""}|${r.receiptFooterDate ?? ""}|` +
          `${r.receiptNo ?? ""}|${r.chainName ?? ""}|${r.storeName ?? ""}|${r.storeAddress ?? ""}|` +
          `${r.mandatorySwipesRequired ?? 0}|${r.mandatorySwipesCompleted ?? 0}`)
        .join("§");
      if (fp !== receiptsFingerprintRef.current) {
        receiptsFingerprintRef.current = fp;
        setReceipts(rows);
      }
    } catch (error) {
      console.error("Failed to fetch receipts:", error);
    } finally {
      setLoading((prev) => (prev ? false : prev));
    }
  };

  // DEV-ONLY: hard delete a receipt + all spawned data (prices, orphan SPs,
  // MinIO image). Server refuses outside dev.
  const confirmDeleteReceipt = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/receipts/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReceipts((prev) => prev.filter((r) => r.id !== deleteTarget.id));
      setDeleteTarget(null);
      await fetchReceipts();
    } catch (e) {
      Alert.alert("Delete failed", String(e));
    } finally {
      setDeleting(false);
    }
  };

  // DEV-ONLY: re-run the FULL pipeline (OCR → parse → match → save) on the receipt's
  // STORED photo, so a parser fix can be re-tested against the SAME image without a
  // retake (a retake gives slightly different OCR every time). Downloads the photo, then
  // hands it to the fresh-scan flow; the OLD receipt (same receiptNo) is deleted just
  // before the new one is created (in receipt-process), so a re-parse that bails to
  // "retake" doesn't destroy the receipt. Caveat: the stored photo is the downscaled/
  // redacted upload, so the OCR won't be byte-identical to the original camera scan — but
  // it IS deterministic across runs, which is the point.
  const confirmReOcr = async () => {
    if (!deleteTarget || reocring || deleting) return;
    const target = deleteTarget;
    setReocring(true);
    try {
      const imgRes = await fetch(`${API_BASE_URL}/api/receipts/${target.id}/image`);
      const imgData = await imgRes.json().catch(() => null);
      if (!imgRes.ok || !imgData?.url) throw new Error(`photo url HTTP ${imgRes.status}`);
      const dest = `${FileSystem.cacheDirectory}reocr_${target.id}_${Date.now()}.jpg`;
      const dl = await FileSystem.downloadAsync(imgData.url, dest);
      if (dl.status !== 200) throw new Error(`photo download HTTP ${dl.status}`);
      setDeleteTarget(null);
      router.push(
        `/receipt-process?uris=${encodeURIComponent(dl.uri)}&reocrReceiptId=${target.id}` as any,
      );
    } catch (e) {
      Alert.alert(t('receipts.devReocr.failed'), String(e));
    } finally {
      setReocring(false);
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

  // Gate the resume prompt on settings hydration: Alert.alert captures its strings
  // IMPERATIVELY at call time, so firing it before settingsStore has run
  // i18n.changeLanguage(deviceLanguage) freezes the modal to the hardcoded init
  // language (lt) even on an English device — the "not language aware" report. A
  // reactively-rendered <Modal> wouldn't have this, but a native Alert would; so
  // wait for `hydrated`, by which point i18next is on the resolved language.
  const settingsHydrated = useSettingsStore((s) => s.hydrated);
  useFocusEffect(useCallback(() => {
    if (!settingsHydrated) return;
    // A LIVE scan session owns the current draft — the live card above the
    // list is the affordance; a "resume?" prompt over a running scan would
    // restart it from scratch. Don't claim the arm: if the app is killed
    // mid-scan the next launch still prompts.
    if (isSessionLive()) return;
    // Claim SYNCHRONOUSLY, before the await, at MODULE level so a remount
    // can't stack a second Alert. claimResumePrompt() is one-shot until a
    // new draft re-arms it (saveReceiptDraft).
    if (resumeCheckInFlight || !claimResumePrompt()) return;
    resumeCheckInFlight = true;
    let active = true;
    (async () => {
      const draft = await loadReceiptDraft();
      resumeCheckInFlight = false;
      console.log(`[RESUME] draft loaded — hasDraft=${!!draft} active=${active} uris=${draft?.imageUris?.length ?? 0}`);
      if (!active || !draft) {
        // Nothing to prompt for — give the arm back so a draft saved later
        // this session (a new scan) can prompt after an interruption.
        unclaimResumePrompt();
        return;
      }
      console.log('[RESUME] SHOWING ALERT');
      Alert.alert(
        t('receipts.resume.title'),
        t('receipts.resume.body'),
        [
          {
            text: t('common.cancel'),
            style: "cancel",
            onPress: () => {
              console.log('[RESUME] CANCEL tapped');
              clearReceiptDraft().catch(() => {});
            },
          },
          {
            text: t('common.continue'),
            onPress: () => {
              console.log('[RESUME] CONTINUE tapped -> navigate');
              const params = new URLSearchParams();
              if (draft.imageUris.length > 1) {
                params.set("uris", draft.imageUris.join(","));
              } else {
                params.set("uri", draft.imageUris[0]);
              }
              router.navigate(`/receipt-process?${params.toString()}` as any);
            },
          },
        ],
      );
    })();
    return () => {
      active = false;
    };
    // `t` intentionally omitted — see the sync-claim comment above; re-running on a
    // language change would risk a second prompt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsHydrated]));

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
        returnTo: "/receipt",
      },
    } as any);
  };

  // Store filter options (multi-select), keyed by chainId — derived from the
  // receipts present, most-frequent chain first. `logoUrlById` feeds the
  // selected-logos trigger in StoreFilterButton.
  const { storeOptions, logoUrlById } = useMemo(() => {
    const acc = new Map<number, { label: string; logo: string | null; count: number }>();
    const logos = new Map<number, string | null>();
    for (const r of receipts) {
      if (!r.chainName) continue;
      const id = chainIdByName(r.chainName);
      if (!id) continue;
      const logo = r.chainMiniLogoUrl ?? r.chainLogoUrl ?? null;
      const existing = acc.get(id);
      if (existing) {
        existing.count += 1;
        if (!existing.logo && logo) existing.logo = logo;
      } else {
        acc.set(id, { label: chainBrandName(r.chainName), logo, count: 1 });
      }
      if (logo && !logos.has(id)) logos.set(id, logo);
    }
    const opts: FilterOption[] = Array.from(acc.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([id, v]) => ({
        id,
        label: v.label,
        leading: <ChainLogoChip chainId={id} name={v.label} logoUrl={v.logo} size={24} />,
      }));
    return { storeOptions: opts, logoUrlById: logos };
  }, [receipts]);

  const toggleStore = useCallback((id: number) => {
    setSelectedChainIds((prev) => {
      if (prev == null) return new Set([id]); // from "all" → narrow to just this one
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      // Empty or full selection both collapse back to "all stores".
      if (next.size === 0 || next.size >= storeOptions.length) return null;
      return next;
    });
  }, [storeOptions.length]);

  const selectAllStores = useCallback(() => setSelectedChainIds(null), []);

  // Calendar marks: "YYYY-MM-DD" → chain dot colours (deduped per chain, so a
  // day with two Rimi receipts shows one red dot; Rimi + IKI shows red + green).
  const receiptDots = useMemo(
    () => buildReceiptDotMap(receipts.map((r) => ({ date: receiptDateObj(r), chainName: r.chainName }))),
    [receipts],
  );

  // Drop any selected chains that vanish from the loaded receipts.
  useEffect(() => {
    if (selectedChainIds == null) return;
    const valid = new Set(storeOptions.map((o) => o.id));
    const kept = new Set([...selectedChainIds].filter((id) => valid.has(id)));
    if (kept.size !== selectedChainIds.size) {
      setSelectedChainIds(kept.size === 0 ? null : kept);
    }
  }, [storeOptions, selectedChainIds]);

  const listData: ListItem[] = useMemo(() => {
    const out: ListItem[] = [];
    for (const q of queueItems) out.push({ kind: "queue", data: q });
    let filtered = receipts;
    // STORE (multi): skipped when all stores are selected so unknown-chain
    // receipts survive; otherwise keep only the checked chains.
    if (selectedChainIds && selectedChainIds.size < storeOptions.length) {
      filtered = filtered.filter((r) => {
        const id = r.chainName ? chainIdByName(r.chainName) : 0;
        return id ? selectedChainIds.has(id) : false;
      });
    }
    // DATE (exact day) — against the receipt's own date.
    if (selectedDate) {
      filtered = filtered.filter((r) => {
        const d = receiptDateObj(r);
        return d ? sameDay(d, selectedDate) : false;
      });
    }
    // Sort by the receipt date (newest first); undated receipts sink to the end.
    const byReceiptDateDesc = (a: Receipt, b: Receipt) =>
      (receiptDateObj(b)?.getTime() ?? -Infinity) - (receiptDateObj(a)?.getTime() ?? -Infinity);
    const recent = filtered.filter((r) => recentIds.includes(r.id)).sort(byReceiptDateDesc);
    const older = filtered.filter((r) => !recentIds.includes(r.id)).sort(byReceiptDateDesc);
    if (recent.length > 0) {
      out.push({ kind: "section", title: t('receipts.sections.new'), id: "sec-nauji" });
      for (const r of recent) out.push({ kind: "receipt", data: r });
      if (older.length > 0) {
        out.push({ kind: "section", title: t('receipts.sections.earlier'), id: "sec-anksciau" });
      }
    }
    for (const r of older) out.push({ kind: "receipt", data: r });
    return out;
  }, [queueItems, receipts, recentIds, selectedChainIds, selectedDate, storeOptions.length]);

  if (loading) {
    return (
      <View style={styles.container}>
        <CollapsingHeader controller={header} back smallTitle={t('tabs.receipts')} />
        <ScreenHeading title={t('tabs.receipts')} />
        <View style={{
          backgroundColor: colors.cardBackground,
          borderBottomWidth: 0.5, borderBottomColor: colors.border,
          flexDirection: 'row', gap: 8,
          paddingHorizontal: 12, paddingVertical: 10,
        }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonBox key={i} width={i === 0 ? 64 : 80} height={32} borderRadius={radius.lg} />
          ))}
        </View>
        <View style={[styles.list, { paddingTop: 16 }]}>
          {Array.from({ length: 5 }).map((_, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.cardBackground, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md, gap: spacing.md }}>
              <SkeletonBox width={32} height={32} borderRadius={radius.sm} />
              <View style={{ flex: 1, gap: 8 }}>
                <SkeletonBox width='70%' height={13} borderRadius={radius.sm} />
                <SkeletonBox width='45%' height={11} borderRadius={radius.sm} />
              </View>
              <View style={{ alignItems: 'flex-end', gap: spacing.sm }}>
                <SkeletonBox width={48} height={11} borderRadius={radius.sm} />
                <SkeletonBox width={56} height={18} borderRadius={radius.sm} />
              </View>
            </View>
          ))}
        </View>
        {/* The FAB must exist even while loading — offline the fetch waits out
            its timeout and this skeleton is all the user sees; without the FAB
            there was no way to enqueue an upload at all. The upload-menu Modal
            only renders in the main branch, so this FAB opens the FILE picker
            directly (no modal → no dismiss race; camera is offline-blocked
            anyway and the skeleton is brief when online). */}
        <TouchableOpacity
          style={[styles.fab, { bottom: tabBarHeight + 16 }]}
          onPress={() => { void pickFiles(); }}
        >
          <Ionicons name="add" size={iconSize.xl} color={colors.onPrimary} />
        </TouchableOpacity>
      </View>
    );
  }

  // Card for the LIVE interactive scan session (distinct from the list-upload
  // queue cards below — this one is a single foreground scan the user left).
  const renderLiveScanCard = () => {
    const needsInput = scanPhase === "input";
    const isDone = scanPhase === "done";
    const isFailed = scanPhase === "failed";
    const statusColor = isFailed ? colors.error : needsInput ? colors.warning : isDone ? colors.success : colors.primary;
    const statusLabel = isFailed
      ? t('receipts.liveScan.failed')
      : needsInput
      ? t('receipts.liveScan.needsInput')
      : isDone
      ? t('receipts.liveScan.done')
      : t('receipts.liveScan.processing');
    const subline = isFailed
      ? (scanFailMessage ?? null)
      : isDone || needsInput
      ? t('receipts.liveScan.tapToOpen')
      : scanMatchProgress
      ? t('receipts.liveScan.matching', { done: scanMatchProgress.done, total: scanMatchProgress.total })
      : t('receipts.liveScan.tapToOpen');
    const leftIcon = isFailed
      ? <Ionicons name="alert-circle-outline" size={iconSize.xl} color={statusColor} />
      : needsInput
      ? <Ionicons name="help-circle-outline" size={iconSize.xl} color={statusColor} />
      : isDone
      ? <Ionicons name="checkmark-circle-outline" size={iconSize.xl} color={statusColor} />
      : <MaterialProgress size="small" color={colors.primary} />;
    const openSession = () => {
      const params = new URLSearchParams(scanEntryParams ?? {});
      router.navigate(`/receipt-process?${params.toString()}` as any);
    };
    return (
      <TouchableOpacity
        style={[
          styles.card,
          styles.queueCard,
          isFailed && { borderLeftColor: colors.error },
          needsInput && { borderLeftColor: colors.warning },
        ]}
        activeOpacity={isFailed ? 1 : 0.8}
        onPress={isFailed ? undefined : openSession}
        disabled={isFailed}
      >
        <View style={{ marginRight: spacing.md }}>{leftIcon}</View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}>
            <Text style={styles.queueTitle} numberOfLines={1}>
              {t('receipts.liveScan.title')}
            </Text>
            <View style={[styles.statusBadge, { backgroundColor: statusColor }]}>
              <Text style={styles.statusText}>{statusLabel}</Text>
            </View>
          </View>
          {subline ? <Text style={styles.queueSubline} numberOfLines={1}>{subline}</Text> : null}
        </View>
        {isFailed ? (
          <TouchableOpacity onPress={() => consumeSession(scanSessionId)} style={{ paddingLeft: spacing.sm }} hitSlop={8}>
            <Ionicons name="close" size={iconSize.md} color={colors.textMuted} />
          </TouchableOpacity>
        ) : (
          <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textMuted} />
        )}
      </TouchableOpacity>
    );
  };

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
        <Ionicons name={isDuplicate ? "copy-outline" : "alert-circle-outline"} size={iconSize.xl} color={statusColor} />
      );
      if (isAwaiting) return <Ionicons name="cloud-offline-outline" size={iconSize.xl} color={colors.warning} />;
      if (isPending) return <Ionicons name="time-outline" size={iconSize.xl} color={colors.textMuted} />;
      return <MaterialProgress size="small" color={colors.primary} />;
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
        <View style={{ marginRight: spacing.md }}>{leftIcon}</View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}>
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
          <TouchableOpacity onPress={() => removeQueueItem(item.id)} style={{ paddingLeft: spacing.sm }} hitSlop={8}>
            <Ionicons name="close" size={iconSize.md} color={colors.textMuted} />
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
    const dateSource = receiptFooterDateStr(item) ?? item.receiptDate;
    const dateLabel = dateSource ? formatDate(dateSource) : "—";
    return (
      <TouchableOpacity
        style={[styles.card, hasPendingSwipes(item) && styles.cardPending]}
        onLongPress={__DEV__ ? () => setDeleteTarget(item) : undefined}
        delayLongPress={500}
        onPress={() => {
          // navigate, not push: a quick double-tap dispatches twice, and push
          // stacks a second copy of the screen — navigate no-ops when the same
          // route+params is already focused.
          if (hasPendingSwipes(item)) {
            router.navigate({
              pathname: "/swipe/queue",
              params: {
                receiptIds: String(item.id),
                returnTo: "/receipt",
              },
            } as any);
          } else {
            router.navigate(`/receipt-process?receiptId=${item.id}`);
          }
        }}
      >
        <View style={styles.cardLeft}>
          {item.chainLogoUrl || item.chainName ? (
            <ChainLogoChip
              chainId={chainIdByName(item.chainName ?? '') ?? 0}
              name={item.chainName ?? '?'}
              logoUrl={item.chainMiniLogoUrl ?? item.chainLogoUrl}
              size={32}
            />
          ) : (
            <Ionicons name="receipt-outline" size={iconSize.xl} color={colors.primary} />
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
      <CollapsingHeader controller={header} back smallTitle={t('tabs.receipts')} />
      {/* Always-pinned filter row: Fabric mis-hit-tests transformed sticky
          headers (touches fall through to the list). */}
      {(storeOptions.length > 1 || receipts.length > 0) ? (

          <View onLayout={header.onPinnedLayout} style={{ backgroundColor: colors.pageBackground, marginHorizontal: -spacing.lg }}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.filterRow}
            >
              {storeOptions.length > 1 && (
                <StoreFilterButton
                  storeOptions={storeOptions}
                  selectedIds={selectedChainIds}
                  onToggle={toggleStore}
                  onAll={selectAllStores}
                  logoUrlById={logoUrlById}
                  label={t('receipts.filterStores')}
                  allLabel={t('receipts.filterAllStores')}
                  title={t('receipts.filterStores')}
                />
              )}
              <DateFilterButton
                value={selectedDate}
                onChange={setSelectedDate}
                label={t('receipts.filterDate')}
                markedDates={receiptDots}
              />
            </ScrollView>
          </View>
        ) : null}
      <AnimatedSectionList
        {...header.scroll}
        sections={[{ data: listData }]}
        keyExtractor={(it: any) =>
          it.kind === "queue" ? `q-${it.data.id}` :
          it.kind === "section" ? it.id :
          `r-${it.data.id}`
        }
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={[styles.list, { paddingTop: 0, paddingBottom: tabBarHeight + 24 }]}
        ListHeaderComponent={
          <>
            <ScreenHeading title={t('tabs.receipts')} onLayout={header.onTitleLayout} />
            {liveScanVisible ? renderLiveScanCard() : null}
            {showBanner ? (
              <PendingSwipesBanner
                pendingCount={pendingSwipesCount}
                disabled={bannerDisabled}
                disabledHint={bannerDisabled ? t('receipts.status.bannerDisabled') : undefined}
                onPress={onStartBanner}
              />
            ) : null}
          </>
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
        style={[styles.fab, { bottom: tabBarHeight + 16 }]}
        // Offline is NOT a blocker: file uploads enqueue into the persistent
        // queue and sync when connectivity returns (awaiting-network state).
        // Only the CAMERA path warns offline — see onPickCamera.
        onPress={() => setUploadMenuOpen(true)}
      >
        <Ionicons name="add" size={iconSize.xl} color={colors.onPrimary} />
      </TouchableOpacity>


      {/* DEV-ONLY: long-press delete confirmation. Gated on __DEV__ so it only
          exists in dev/Metro bundles and is absent from release/prod builds. */}
      {__DEV__ && (
        <Modal
          visible={deleteTarget !== null}
          transparent
          animationType="fade"
          onRequestClose={() => !deleting && !reocring && setDeleteTarget(null)}
        >
          <Pressable style={styles.menuBackdrop} onPress={() => !deleting && !reocring && setDeleteTarget(null)}>
            <Pressable style={styles.menuCard} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.menuTitle}>{t('receipts.devReocr.menuTitle')}</Text>
              <Text style={[styles.cardAddress, { marginBottom: spacing.sm }]}>
                {deleteTarget?.storeName || deleteTarget?.chainName || `#${deleteTarget?.id ?? ''}`}
              </Text>
              {/* Re-OCR: re-run the whole pipeline on the STORED photo (same image, fresh parse). */}
              <TouchableOpacity
                style={[styles.menuRow, { justifyContent: 'center' }, (deleting || reocring) && { opacity: 0.5 }]}
                disabled={deleting || reocring}
                onPress={confirmReOcr}
              >
                {reocring ? (
                  <MaterialProgress size="small" color={colors.primary} />
                ) : (
                  <>
                    <Ionicons name="refresh-outline" size={iconSize.lg} color={colors.primary} />
                    <Text style={styles.menuRowText}>{t('receipts.devReocr.action')}</Text>
                  </>
                )}
              </TouchableOpacity>
              {/* Delete: hard-delete the receipt + everything it spawned. */}
              <TouchableOpacity
                style={[styles.menuRow, { justifyContent: 'center' }, (deleting || reocring) && { opacity: 0.5 }]}
                disabled={deleting || reocring}
                onPress={confirmDeleteReceipt}
              >
                {deleting ? (
                  <MaterialProgress size="small" color={colors.error} />
                ) : (
                  <>
                    <Ionicons name="trash-outline" size={iconSize.lg} color={colors.error} />
                    <Text style={[styles.menuRowText, { color: colors.error }]}>
                      {t('receipts.devDelete.confirm')}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.menuRow, { justifyContent: 'center' }]}
                disabled={deleting || reocring}
                onPress={() => setDeleteTarget(null)}
              >
                <Text style={styles.menuRowText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>
      )}

      <Modal
        visible={uploadMenuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setUploadMenuOpen(false)}
        onDismiss={() => {
          const action = pendingMenuActionRef.current;
          pendingMenuActionRef.current = null;
          action?.();
        }}
      >
        <Pressable style={styles.menuBackdrop} onPress={() => setUploadMenuOpen(false)}>
          <Pressable style={styles.menuCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.menuTitle}>{t('receipts.menu.uploadTitle')}</Text>

            <TouchableOpacity style={styles.menuRow} onPress={onPickCamera}>
              <Ionicons name="camera-outline" size={iconSize.lg} color={colors.primary} />
              <Text style={styles.menuRowText}>{t('receipts.menu.uploadCamera')}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.menuRow} onPress={onPickFile}>
              <Ionicons name="cloud-upload-outline" size={iconSize.lg} color={colors.primary} />
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
  list: { padding: spacing.lg },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },

  card: {
    backgroundColor: c.cardBackground,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    ...elevation.level1,
    // Uniform (transparent) border + coloured left edge. A single-sided
    // borderLeftWidth makes Android render SQUARE corners despite borderRadius;
    // a uniform borderWidth rounds correctly while only the left shows.
    borderWidth: 3,
    borderColor: "transparent",
    borderLeftColor: c.softAccent,
  },
  queueCard: {
    paddingBottom: spacing.lg,
    overflow: "hidden",
    position: "relative",
    borderLeftColor: c.primary,
  },
  queueTitle: {
    ...typography.bodySmallStrong,
    color: c.textPrimary,
    flex: 1,
    minWidth: 0,
  },
  queueSubline: {
    ...typography.labelSmall,
    fontWeight: "400",
    color: c.textMuted,
    marginTop: spacing.xs,
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
  cardLeft: { marginRight: spacing.md, width: 36, alignItems: "center", justifyContent: "center" },
  cardContent: { flex: 1, minWidth: 0 },
  cardTitle: { ...typography.bodyStrong, color: c.textPrimary },
  cardAddress: { ...typography.labelSmall, fontWeight: "400", color: c.textSecondary, marginTop: 2 },
  cardRight: { alignItems: "flex-end", marginLeft: spacing.sm },
  cardDate: { ...typography.labelSmall, fontWeight: "400", color: c.textSecondary, marginBottom: 6 },
  statusBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
  },
  statusText: { ...typography.caption, fontWeight: "600", color: c.textInverse },
  sectionHeader: {
    ...typography.caption,
    fontWeight: "700",
    color: c.textMuted,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
    paddingHorizontal: 2,
  },
  emptyText: { ...typography.bodyStrong, color: c.textSecondary, marginTop: spacing.lg, textAlign: 'center' },
  emptySubText: { ...typography.label, fontWeight: '400', color: c.textMuted, marginTop: 6, textAlign: 'center' },
  emptyButton: { marginTop: spacing.xl, backgroundColor: c.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: radius.pill },
  emptyButtonText: { ...typography.bodySmallStrong, fontWeight: '700', color: c.onPrimary },
  fab: {
    position: "absolute",
    bottom: spacing.xl,
    right: spacing.xl,
    backgroundColor: c.primary,
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    // Brand-coloured glow — bespoke, not a neutral elevation tier.
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
    padding: spacing.xl,
  },
  menuCard: {
    backgroundColor: c.cardBackground,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: 6,
  },
  menuTitle: {
    ...typography.bodyStrong,
    fontWeight: "700",
    color: c.textPrimary,
    marginBottom: spacing.xs,
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  menuRowText: {
    ...typography.bodyStrong,
    fontWeight: "500",
    color: c.textPrimary,
  },
  previewToggle: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    marginTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: c.borderSubtle,
  },
  previewToggleText: {
    ...typography.bodySmallStrong,
    color: c.textPrimary,
  },
  previewToggleHint: {
    ...typography.caption,
    color: c.textMuted,
    marginTop: 2,
  },
  menuCancel: {
    alignItems: "center",
    paddingVertical: spacing.md,
    marginTop: spacing.xs,
  },
  menuCancelText: {
    ...typography.bodySmallStrong,
    color: c.textSecondary,
  },
});
