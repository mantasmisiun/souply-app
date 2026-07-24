import {
    Ionicons } from "@expo/vector-icons";
import { Stack } from "expo-router";
import { useEffect,
    useMemo,
    useRef,
    useState } from "react";
import {
  ActivityIndicator,
    Dimensions,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import {
  GestureHandlerRootView,
  Gesture,
  GestureDetector,
} from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import { ProductImage } from "../ProductImage";
import { ChainLogoChip } from "../ChainLogoChip";
import { ProgressGlow } from "../ProgressGlow";
import { ScreenNavBar } from "../ScreenNavBar";
import { API_BASE_URL } from "../../config/api";
import { fetchWithTimeout, TIMEOUT_STANDARD_MS, TIMEOUT_FAST_MS } from "../../utils/fetchWithTimeout";
import { getUserId } from "../../config/user";
import { useTheme, type AppTheme } from "../../constants/theme";
import { useLevelStore } from "../../state/levelStore";
import { capVoluntaryQueue, composeVoluntaryReceiptDeck } from "../../utils/swipeQueueCap";
import { RECOGNITION } from "@shared/recognitionConfig";
import { BandCropImage } from "../receipt/BandCropImage";
import { ProcessingLoader } from "../ProcessingLoader";
import { MergeArrowsIcon, ParallelArrowsIcon, DivergeArrowsIcon, type VoteIconProps } from "../VoteIcons";
import { buildReceiptPageMeta, type PageMeta } from "../../utils/receiptImage";
import { type BandQuadRegion } from "../../utils/bandQuad";

// ── Types ──────────────────────────────────────────────────────────────────

type Vote = "identical" | "similar" | "different";

interface SwipeCardSide {
  spId: number;
  productId: number;
  name: string;
  brandName: string | null;
  imageUrl: string | null;
  chainId: number;
  chainName: string;
  chainLogoUrl: string | null;
  categoryId: number;
  categoryName: string;
}

interface SwipeQueueCard {
  cardId: string;
  slot: 1 | 2 | 3;
  score: number;
  left: SwipeCardSide;
  right: SwipeCardSide;
  slot2Meta?: {
    sameChain: boolean;
    conflictDetected: boolean;
  };
  /** Tagged by `capVoluntaryQueue` for cards sourced from the global pool
   *  (after the receipt's own cards fill their per-slot share). The card
   *  renderer shows a small subline acknowledging the user is helping
   *  the community queue, not resolving this receipt. */
  fromGlobalFill?: boolean;
}

/**
 * Card B (receipt resolution): the line's matched product vs its OWN OCR text +
 * receipt crop. Same swipes as a pair card (identical/similar/different); the
 * verdict acts on the receipt line, not a global SP pair. See SWIPE_QUEUE_REDESIGN.md.
 */
interface ReceiptResolveCard {
  cardKind: "receipt";
  cardId: string;
  receiptLineIdx: number;
  ocr: { name: string; cropUrl: string };
  /** Band geometry (parsed/OCR space) for the client parallelogram crop — same as
   *  the receipt-detail "Items" tab. Null/absent on legacy receipts → flat fallback. */
  region?: BandQuadRegion | null;
  matched: { spId: number; name: string | null; imageUrl: string | null };
  needsHuman: number;
  /** PROPOSED card: the line is UNLINKED and `matched` shows the server's best
   *  candidate as a proposal. The vote body must echo `matched.spId` back as
   *  `proposedSpId` so identical links it / different blacklists the combo. */
  proposed?: boolean;
  /** CROSS-CHAIN rescue proposal: the candidate lives in this chain (badge shown
   *  so the user knowingly confirms "same product as this <chain> item"); an
   *  identical swipe mints a provisional SP in the receipt's chain server-side. */
  sourceChainId?: number;
}

/** Band-crop source for a receipt's OCR-side cards: the page images re-projected
 *  into OCR space. On a FRESH scan these are reused from the device's just-produced
 *  pageMetas (instant, no network); on a reopen they're downloaded + normalized once
 *  per receipt. Carries the FULL page array so multi-page (long) receipts crop the
 *  correct page. 'loading' until built, 'failed' → fall back to the flat server crop. */
type ReceiptCropState = { status: "loading" | "ready" | "failed"; pages: PageMeta[]; error?: string | null };

/**
 * Pending-alias card (Issue H vocabulary): "is this receipt TEXT the same product as
 * this SP?". Sourced from GET /alias-cards; votes go to POST /alias-votes (identical
 * confirms the learned print, reaching 'canonical' at K distinct users). No receipt
 * crop — the OCR string is shown as text (cross-receipt). See RECEIPT_VOCABULARY.md §6.
 */
interface PendingAliasCard {
  cardKind: "alias";
  cardId: string; // `alias:${aliasId}`
  aliasId: number;
  ocrText: string; // how the chain printed it (rawSample)
  sp: { spId: number; name: string; imageUrl: string | null };
}

type QueueCard = SwipeQueueCard | ReceiptResolveCard | PendingAliasCard;
const isReceiptCard = (c: QueueCard | undefined | null): c is ReceiptResolveCard =>
  !!c && (c as any).cardKind === "receipt";
const isAliasCard = (c: QueueCard | undefined | null): c is PendingAliasCard =>
  !!c && (c as any).cardKind === "alias";

interface SlotCounts {
  slot1: number;
  slot2: number;
  slot3: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const STAGE_H_PAD = 16;
const CARD_W = SCREEN_W - STAGE_H_PAD * 2;
const IMG_SIZE = Math.min(140, Math.floor((CARD_W - 24) / 2) - 8);
// Width passed to the OCR-side band crop = the card's inner content width
// (card padding is 14 each side), so the parallelogram crop spans the full side.
const CROP_CARD_WIDTH = CARD_W - 28;

const SWIPE_THRESHOLD_X = SCREEN_W * 0.26;
const SWIPE_THRESHOLD_Y = SCREEN_H * 0.16;
const UNDO_DELAY_MS = 3000;
const MIN_DWELL_MS = 700;

/**
 * Hard cap on how many receipts we'll let the user power through in a
 * single session. 5 × 3 cards = 15 mandatory swipes — past that the user
 * is doing too much in one go. The banner re-appears on return so they
 * can finish the rest at their pace.
 */
const MAX_RECEIPTS_PER_SESSION = 5;

// ── Sub-components ─────────────────────────────────────────────────────────

function CardSide({
  side,
  styles,
  onSettled,
}: {
  side: SwipeCardSide;
  styles: ReturnType<typeof makeStyles>;
  onSettled?: (ok: boolean) => void;
}) {
  return (
    <View style={styles.half}>
      <View style={styles.chainRow}>
        {side.chainLogoUrl ? (
          <Image
            source={{ uri: side.chainLogoUrl }}
            style={styles.chainLogo}
            contentFit="contain"
          />
        ) : null}
        <Text style={styles.chainName} numberOfLines={1}>
          {side.chainName}
        </Text>
      </View>

      <ProductImage
        uris={side.imageUrl ? [side.imageUrl] : []}
        imageStyle={styles.productImg}
        placeholderStyle={styles.productImgPlaceholder}
        emojiStyle={styles.productImgEmoji}
        resizeMode="contain"
        onSettled={onSettled}
      />

      <Text style={styles.productName} numberOfLines={5}>
        {side.name}
      </Text>
    </View>
  );
}

/** Card-B matched-product side (the candidate to confirm): image centred with the
 *  product name underneath. */
function MatchedProductSide({
  matched,
  label,
  styles,
  onSettled,
  sourceChainId,
}: {
  matched: ReceiptResolveCard["matched"];
  label: string;
  styles: ReturnType<typeof makeStyles>;
  onSettled?: (ok: boolean) => void;
  /** Cross-chain rescue: badge the source chain over the product image. */
  sourceChainId?: number;
}) {
  return (
    <View style={styles.sideBlock}>
      <Text style={styles.sideLabel} numberOfLines={1}>{label}</Text>
      <View>
        <ProductImage
          uris={matched.imageUrl ? [matched.imageUrl] : []}
          imageStyle={styles.productImg}
          placeholderStyle={styles.productImgPlaceholder}
          emojiStyle={styles.productImgEmoji}
          resizeMode="contain"
          onSettled={onSettled}
        />
        {sourceChainId != null && (
          <View style={{ position: 'absolute', top: 4, left: 4 }}>
            <ChainLogoChip chainId={sourceChainId} size={22} />
          </View>
        )}
      </View>
      <Text style={styles.productName} numberOfLines={3}>
        {matched.name ?? ""}
      </Text>
    </View>
  );
}

/** OCR-TEXT side for a pending-alias (vocabulary) card: how the chain PRINTED the
 *  product on a receipt (shown as text — there's no single receipt crop cross-receipt),
 *  vs the SP below. Settles the readiness gate immediately (text, no image to load). */
function AliasOcrSide({
  text,
  label,
  styles,
  onSettled,
}: {
  text: string;
  label: string;
  styles: ReturnType<typeof makeStyles>;
  onSettled?: () => void;
}) {
  const settledRef = useRef(false);
  useEffect(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    onSettled?.();
  }, [onSettled]);
  return (
    <View style={styles.sideBlock}>
      <Text style={styles.sideLabel} numberOfLines={1}>{label}</Text>
      <View style={[styles.cropBandWrap, styles.cropDiag]}>
        <Text style={styles.aliasOcrText} numberOfLines={4}>{text}</Text>
      </View>
    </View>
  );
}

/** Diagnostic placeholder shown on the OCR side when the client band crop can't render.
 *  Server-side cropping has been REMOVED, so instead of silently falling back to a flat
 *  rectangle we display WHY the parallelogram crop is unavailable — and still settle the
 *  readiness gate (the card stays actionable: the user reads the OCR text + matched side). */
function CropDiag({
  text,
  spinner,
  onSettled,
  styles,
  colors,
}: {
  text: string;
  spinner?: boolean;
  onSettled?: () => void;
  styles: ReturnType<typeof makeStyles>;
  colors: AppTheme;
}) {
  const settledRef = useRef(false);
  useEffect(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    onSettled?.();
  }, [onSettled]);
  return (
    <View style={[styles.cropBandWrap, styles.cropDiag]}>
      {spinner ? <ActivityIndicator color={colors.primary} /> : null}
      <Text style={styles.cropDiagText} numberOfLines={3}>{text}</Text>
    </View>
  );
}

function OcrReceiptSide({
  ocr,
  region,
  crop,
  label,
  styles,
  colors,
  onSettled,
}: {
  ocr: ReceiptResolveCard["ocr"];
  region?: BandQuadRegion | null;
  crop: ReceiptCropState;
  label: string;
  styles: ReturnType<typeof makeStyles>;
  colors: AppTheme;
  onSettled?: () => void;
}) {
  // SERVER-SIDE CROPPING REMOVED: the OCR side ALWAYS goes through the client BandCropImage
  // — the exact same path as the receipt-detail Items tab (ImageManipulator rect-crop +
  // react-native-svg parallelogram clip via the shared bandQuadPoints). When it can't
  // render we surface the REASON (CropDiag) instead of a flat crop, so the failure mode is
  // visible and patchable:
  //   • no region → the resolve-queue didn't send band geometry (server stale / legacy receipt)
  //   • loading   → the receipt photo is still downloading + re-projecting into OCR space
  //   • failed    → the photo download/normalize failed (see buildReceiptPageMeta)
  //   • crop error→ BandCropImage's own "crop failed: …" (ImageManipulator on the photo).
  const { t } = useTranslation();
  const pages = crop.pages;
  let body: React.ReactNode;
  if (!region) {
    body = <CropDiag styles={styles} colors={colors} onSettled={onSettled} text={t('swipe.cropNoGeometry')} />;
  } else if (crop.status === "loading") {
    body = <CropDiag styles={styles} colors={colors} onSettled={onSettled} spinner text={t('swipe.cropBuilding')} />;
  } else if (crop.status === "failed" || pages.length === 0) {
    body = <CropDiag styles={styles} colors={colors} onSettled={onSettled} text={crop.error ? t('swipe.cropFailed', { error: crop.error }) : t('swipe.cropUnavailable')} />;
  } else {
    body = (
      <View style={styles.cropBandWrap}>
        <BandCropImage
          pages={pages}
          region={region}
          cardWidth={CROP_CARD_WIDTH}
          onSettled={onSettled}
        />
      </View>
    );
  }
  return (
    <View style={styles.sideBlock}>
      <Text style={styles.sideLabel} numberOfLines={1}>{label}</Text>
      {body}
      <Text style={styles.ocrCaption} numberOfLines={2}>
        {ocr.name}
      </Text>
    </View>
  );
}

/** A Tinder-style action button: big colour icon + label underneath. */
function ActionButton({
  icon,
  Icon,
  color,
  label,
  onPress,
  styles,
}: {
  icon?: React.ComponentProps<typeof Ionicons>["name"];
  /** Custom vote icon (SVG). Takes precedence over the Ionicons `icon`. */
  Icon?: React.FC<VoteIconProps>;
  color: string;
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <TouchableOpacity style={styles.actionBtn} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.actionIconWrap, { borderColor: color }]}>
        {Icon ? <Icon size={30} color={color} /> : icon ? <Ionicons name={icon} size={30} color={color} /> : null}
      </View>
      <Text style={styles.actionLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────

/** The line a Card-B vote endpoint returns (demoted to OCR / re-pointed / confirmed). */
export interface ResolvedLine {
  storeProductId?: number | null;
  matchedName?: string | null;
  storeProductImageUrl?: string | null;
  matchConfidence?: number | null;
  matchConfirmed?: boolean;
  priceVerified?: boolean;
  itemConfidence?: any;
  // Line-level category of the new pick (so the receipt summary re-buckets live).
  categoryId?: number | null;
  categoryName?: string | null;
  categoryL2Name?: string | null;
}

export interface SwipeQueueProps {
  /** Receipts to resolve this session (already-parsed ids). [] = standalone global session. */
  receiptIds: string[];
  voluntary: boolean;
  returnTo?: string;
  /** Final session navigation — the HOST decides where to land (route: back / returnTo;
   *  receipt-process host: flip to the detail phase). Keeps all router logic out of here. */
  onAllDone: (ctx: { reason: "voluntary" | "mandatory" | "standalone"; lastReceiptId: string | null; returnTo?: string }) => void;
  /** Back / dismiss affordance (the error screen + the done-screen button). */
  onExit: () => void;
  /** Render the screen's own Stack.Screen header — true on the standalone route, false when hosted. */
  renderHeader?: boolean;
  /**
   * FRESH-SCAN FAST PATH: the device's just-produced, OCR-canonical page images for
   * a receipt it scanned this session — the SAME pixels being uploaded to MinIO.
   * When `receiptId` matches the receipt being resolved, the OCR-side band crop is
   * built from these directly, skipping the GET /image presign + download + retry
   * ladder entirely (the ~14s "spinner that never clears"). Absent on reopen / older
   * / multi-receipt sessions → falls through to buildReceiptPageMeta as before.
   * Guarded by receiptId so a stale image (warm reopen) can never crop the wrong
   * receipt.
   */
  localPages?: { receiptId: string; pages: PageMeta[] } | null;
  /**
   * In-flow LIVE patch: fired when a Card-B receipt-line vote resolves server-side,
   * carrying the line the vote endpoint returns (a 'different' demotes it to the OCR
   * name; identical/similar confirm it). The host (receipt-process) patches that
   * product row immediately so the detail reflects the vote without waiting for a
   * navigation-focus re-sync. No-op on the standalone route (no host to patch).
   */
  onLineResolved?: (receiptId: string, lineIdx: number, line: ResolvedLine | null) => void;
}

export function SwipeQueue({
  receiptIds,
  voluntary: isVoluntary,
  returnTo,
  onAllDone,
  onExit,
  renderHeader = true,
  localPages = null,
  onLineResolved,
}: SwipeQueueProps) {
  const { t } = useTranslation();

  const receiptIdList = useMemo<string[]>(() => {
    // Dedupe defensively + cap to the per-session limit (the caller may pass raw ids).
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of receiptIds.map((s) => String(s).trim()).filter(Boolean)) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= MAX_RECEIPTS_PER_SESSION) break;
    }
    return out;
  }, [receiptIds]);

  const isMulti = receiptIdList.length > 1;

  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const stashLevel = useLevelStore((s) => s.stashLevel);
  const triggerIfNewLevel = useLevelStore((s) => s.triggerIfNewLevel);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<QueueCard[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  /**
   * receiptId the currently-loaded `items` belong to (or null for standalone).
   * Drives the staleness gate in `doneWithCurrentReceipt` — without it,
   * advancing `receiptIdx` flips `done` to true *before* `loadQueue` runs,
   * which would falsely mark the next receipt complete on entry.
   */
  const [itemsReceiptId, setItemsReceiptId] = useState<string | null>(null);
  /**
   * Band-crop source for the current receipt's OCR-side cards. Built once per
   * receipt (download the stored photo + re-project into OCR space) so each Card-B
   * renders the SAME skewed-parallelogram crop as the receipt-detail "Items" tab,
   * instead of the flat server crop. 'failed'/no-region → flat server-crop fallback.
   */
  const [receiptCrop, setReceiptCrop] = useState<ReceiptCropState>({ status: "ready", pages: [] });
  const [slotCounts, setSlotCounts] = useState<SlotCounts>({
    slot1: 0,
    slot2: 0,
    slot3: 0,
  });
  const [idx, setIdx] = useState(0);
  const [sessionNum, setSessionNum] = useState(0);
  const [receiptIdx, setReceiptIdx] = useState(0);
  const [undoLabel, setUndoLabel] = useState<string | null>(null);
  /**
   * Guard against the final-receipt "done" effect navigating twice
   * (state flips can cause the dep array to re-trigger before unmount).
   */
  const finishedRef = useRef(false);

  const userIdRef = useRef<string | null>(null);
  const cardShownAtRef = useRef(Date.now());
  /** The receiptId whose band-crop page-meta build is current — guards a slow
   *  download from clobbering `receiptCrop` after the user advanced to another receipt. */
  const cropBuildIdRef = useRef<string | null>(null);
  /** parsed.image dims used for the current DOWNLOAD-path build, so the bounded
   *  re-arm (a crop that failed only because the upload hadn't landed) can rebuild
   *  with the right dims. Null on the local fast path (it never fails this way). */
  const cropDimsRef = useRef<{ receiptId: string; width: number; height: number; regionXBounds: { left: number; right: number } | null } | null>(null);
  /** receiptId we've already scheduled ONE bounded re-arm for — caps the recovery
   *  retry at one attempt per receipt. */
  const cropRearmedRef = useRef<string | null>(null);
  const pendingVoteRef = useRef<{
    item: QueueCard;
    vote: Vote;
    dwell: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  /**
   * Ask-once ledger (Gap 2): per-receiptId set of Card-B `receiptLineIdx`s that
   * were built into that receipt's mandatory deck — i.e. SERVED to the user.
   * Mandatory completion swipes the WHOLE deck (done requires idx >= length), so
   * "in the deck" == "shown, regardless of vote". On complete-swipes we echo these
   * back as `servedResolveLineIdxs` so the server can mark them asked even if its
   * save-time resolve snapshot was evicted. Keyed by receiptId because one queue
   * can span several receipts, each with its own /complete-swipes POST.
   */
  const servedResolveLineIdxsRef = useRef<Map<string, Set<number>>>(new Map());

  const currentReceiptId = receiptIdList[receiptIdx] ?? null;

  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  // Tinder-style entrance: the next card springs up from slightly small + faded
  // when it lands (set to 0 in `advance`, then animated back to 1).
  const enterProgress = useSharedValue(1);

  // ── Load queue ─────────────────────────────────────────────────────────

  const loadQueue = async () => {
    try {
      setLoading(true);
      setError(null);
      // parsed.image dims for the current receipt (from the resolve-queue response) —
      // captured below so the OCR-side band crop can re-project the stored photo.
      let resolveImage: { width: number; height: number } | null = null;
      const userId = userIdRef.current ?? (await getUserId());
      userIdRef.current = userId;

      // Fetch the receipt-anchored queue. The GLOBAL "community" pool is fetched in
      // parallel ONLY for the no-receipt community path (voluntary without a receipt) —
      // a RECEIPT-scoped voluntary session is RELEVANCE-ONLY: it must contain only THIS
      // receipt's own crops + 688 rescues + receipt-anchored identity cards, never
      // unrelated global fill (which was diluting the 10 slots and crowding out the
      // receipt's uncategorised items). We still pass `voluntary=1` so the server
      // triggers the background OSC refill for the user's missing orphans (fire-and-
      // forget; benefits the NEXT visit).
      // MANDATORY mode fetches nothing here — the one-shot /mandatory-queue endpoint
      // below replaces the old 4-request orchestration (receipt swipe-queue → relatedTo
      // top-up → resolve-queue → orphan-backfill), usually served from the save-time
      // snapshot.
      const isMandatory = !!currentReceiptId && !isVoluntary;
      // Receipt-scoped voluntary ⇒ no global pool; community voluntary (no receipt) keeps it.
      const wantsGlobalPool = isVoluntary && !currentReceiptId;
      const receiptParts: string[] = [];
      if (currentReceiptId) {
        receiptParts.push(`receiptId=${encodeURIComponent(currentReceiptId)}`);
        // Gate the receipt-anchored pool to receipt-RELATED cards: slot-3's global
        // same-chain fill (and slot-2's global orphan pool) otherwise surface UNRELATED
        // dedup pairs (e.g. "OB tamponai Normal vs Super") in a grocery receipt's queue.
        // The receipt's OWN cards stay in-scope; only the unrelated global fill is dropped.
        receiptParts.push(`relatedTo=${encodeURIComponent(currentReceiptId)}`);
      }
      if (isVoluntary) receiptParts.push("voluntary=1");
      const receiptQs = receiptParts.length > 0 ? `?${receiptParts.join("&")}` : "";
      const [receiptRes, globalRes] = isMandatory
        ? [null as Response | null, null as Response | null]
        : await Promise.all([
            fetch(`${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/swipe-queue${receiptQs}`),
            wantsGlobalPool
              ? // Community path (no receipt in focus): ungated global "help identify" pool.
                fetch(`${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/swipe-queue`)
              : Promise.resolve(null as Response | null),
          ]);
      if (receiptRes && !receiptRes.ok) throw new Error(`HTTP ${receiptRes.status}`);
      const receiptData = receiptRes ? await receiptRes.json() : null;
      const receiptItems: SwipeQueueCard[] = Array.isArray(receiptData?.items) ? receiptData.items : [];
      let counts: SlotCounts = receiptData?.slotCounts ?? { slot1: 0, slot2: 0, slot3: 0 };

      let globalItems: SwipeQueueCard[] = [];
      if (globalRes && globalRes.ok) {
        const globalData = await globalRes.json();
        globalItems = Array.isArray(globalData?.items) ? globalData.items : [];
      }

      // Voluntary: receipt-resolution Card-B CROPS (your own OCR lines — the highest-
      // value cards) fetched up front so the 'asked' marking happens once. Fetch up to
      // the comfort cap; they fill FIRST below, then the receipt's slot cards fill the
      // rest of the 10.
      const CROP_COMFORT_CAP = RECOGNITION.queue.voluntaryCropComfortCap;
      let voluntaryCardB: ReceiptResolveCard[] = [];
      if (isVoluntary && currentReceiptId) {
        try {
          const rq = await fetch(
            `${API_BASE_URL}/api/receipts/${encodeURIComponent(currentReceiptId)}/resolve-queue?max=${CROP_COMFORT_CAP}`,
          );
          if (rq.ok) {
            const rd = await rq.json();
            voluntaryCardB = Array.isArray(rd?.cards) ? rd.cards : [];
            if (rd?.image?.width > 0 && rd?.image?.height > 0) resolveImage = rd.image;
          }
        } catch (e) {
          console.warn("[SwipeQueue] voluntary resolve-queue failed:", e);
        }
      }

      let capped: QueueCard[];
      if (isVoluntary) {
        // Receipt-scoped voluntary (currentReceiptId set) is RELEVANCE-ONLY: pass
        // receiptScoped so capVoluntaryQueue fills all 10 slots from the receipt's own
        // cards (slot 2 → 1 → 3) with NO global fill. The community path (no receipt)
        // keeps the 9 receipt + ≥1 global behaviour. globalItems is [] when relevance-only.
        const cappedSlots = capVoluntaryQueue({ receiptItems, globalItems, receiptScoped: !!currentReceiptId }).items;
        if (voluntaryCardB.length > 0) {
          // Crops are highest value: fill FIRST up to the comfort cap, then the receipt's
          // slot cards (688 rescues first) take the remaining slots up to 10. Shared merge
          // so this deck and the badge count (getVoluntaryQueueCount) can never diverge.
          capped = composeVoluntaryReceiptDeck(voluntaryCardB, cappedSlots, CROP_COMFORT_CAP);
        } else {
          capped = cappedSlots;
        }
        // H3 pending-alias community cards: help confirm learned receipt-name aliases
        // ("is this receipt text the same product as this SP?"). Appended after the
        // receipt/community cards; no-op until aliases accumulate.
        try {
          const ac = await fetch(`${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/alias-cards?limit=3`);
          if (ac.ok) {
            const ad = await ac.json();
            const aliasCards: PendingAliasCard[] = (Array.isArray(ad?.cards) ? ad.cards : [])
              .map((c: any): PendingAliasCard => ({
                cardKind: "alias",
                cardId: `alias:${c.aliasId}`,
                aliasId: Number(c.aliasId),
                ocrText: c.rawSample || c.normalizedAlias || "",
                sp: { spId: Number(c.storeProductId), name: c.storeProductName ?? "", imageUrl: c.imageUrl ?? null },
              }))
              .filter((c: PendingAliasCard) => !!c.ocrText && !!c.sp.name && Number.isFinite(c.aliasId));
            if (aliasCards.length > 0) capped = [...capped, ...aliasCards];
          }
        } catch (e) {
          console.warn("[SwipeQueue] alias-cards failed:", e);
        }
      } else if (currentReceiptId) {
        // MANDATORY: one-shot server assembly (Card-B + receipt-anchored pairs +
        // relatedTo top-up + Slot-2c orphan backfill), usually served from the
        // save-time snapshot — one request instead of four sequential ones.
        const mq = await fetch(
          `${API_BASE_URL}/api/receipts/${encodeURIComponent(currentReceiptId)}/mandatory-queue`,
        );
        if (!mq.ok) throw new Error(`HTTP ${mq.status}`);
        const md = await mq.json();
        capped = Array.isArray(md?.cards) ? md.cards : [];
        if (md?.image?.width > 0 && md?.image?.height > 0) resolveImage = md.image;
        if (md?.slotCounts) counts = md.slotCounts;
        console.log(
          `[SwipeQueue] mandatory r${currentReceiptId}: ${capped.length} card(s) ` +
          `(target 3, fromSnapshot=${!!md?.fromSnapshot})`,
        );
      } else {
        // Defensive: voluntary + standalone are the documented modes.
        // Anything else (no receiptId, no voluntary) is treated as an
        // empty session rather than crashing the renderer.
        capped = [];
      }

      setItems(capped);
      setSlotCounts(counts);
      setIdx(0);
      setItemsReceiptId(currentReceiptId);
      cardShownAtRef.current = Date.now();

      // Ask-once ledger (Gap 2): record every Card-B line index BUILT INTO this
      // receipt's deck. Since mandatory completion swipes the whole deck, being in
      // the deck == being served to the user. Union (never overwrite) so a re-load
      // of the same receipt (sessionNum retry) keeps earlier-served indices. The
      // /complete-swipes POST below echoes these back as `servedResolveLineIdxs`.
      if (currentReceiptId) {
        const served =
          servedResolveLineIdxsRef.current.get(currentReceiptId) ?? new Set<number>();
        for (const c of capped) {
          if (isReceiptCard(c) && Number.isFinite(c.receiptLineIdx)) served.add(c.receiptLineIdx);
        }
        servedResolveLineIdxsRef.current.set(currentReceiptId, served);
      }

      // Build the OCR-side band-crop source ONCE for this receipt so each Card-B renders
      // the SAME skewed parallelogram crop as the receipt-detail Items tab — not the flat
      // server crop. Two sources, in priority:
      //   (1) FRESH-SCAN FAST PATH: the host already handed us the device's just-produced
      //       page images (localPages) — the SAME pixels uploading to MinIO. Reuse them
      //       in-memory: instant, no GET /image, no download retry ladder, multi-page safe.
      //       Guarded by receiptId so a stale (warm-reopen) image can't crop the wrong receipt.
      //   (2) FALLBACK (reopen / older / multi-receipt): download the stored photo + normalize.
      // Fire-and-forget: the readiness gate keeps a flat fallback + timeout so a slow or
      // failed download never hangs a card. cropBuildIdRef guards a late resolution from
      // clobbering a newer receipt's crop.
      if (capped.some(isReceiptCard) && currentReceiptId) {
        const rid = currentReceiptId;
        // Receipt-strip X extent = union of the cards' band regions (bands span
        // the printed strip). Trims the A4 whitespace on the DOWNLOAD path —
        // the local fast path's pages already carry OCR-derived bounds.
        const regionXs = capped.filter(isReceiptCard).map((c) => c.region).filter((r): r is NonNullable<typeof r> => r != null);
        const regionXBounds = regionXs.length > 0
          ? { left: Math.min(...regionXs.map((r) => r.xLeft)), right: Math.max(...regionXs.map((r) => r.xRight)) }
          : null;
        if (localPages && localPages.receiptId === rid && localPages.pages.length > 0) {
          // (1) Local fast path — already in OCR space, nothing to download.
          cropBuildIdRef.current = rid;
          cropDimsRef.current = null;
          setReceiptCrop({ status: "ready", pages: localPages.pages });
        } else if (resolveImage) {
          // (2) Download path — guarded build, dims retained for the bounded re-arm.
          const dims = resolveImage;
          cropBuildIdRef.current = rid;
          cropDimsRef.current = { receiptId: rid, width: dims.width, height: dims.height, regionXBounds };
          setReceiptCrop({ status: "loading", pages: [] });
          buildReceiptPageMeta(rid, dims.width, dims.height, regionXBounds)
            .then((res) => {
              if (cropBuildIdRef.current === rid) {
                setReceiptCrop({ status: res.pageMeta ? "ready" : "failed", pages: res.pageMeta ? [res.pageMeta] : [], error: res.error });
              }
            })
            .catch((e) => {
              if (cropBuildIdRef.current === rid) {
                setReceiptCrop({ status: "failed", pages: [], error: String(e?.message ?? e) });
              }
            });
        } else {
          // Receipt cards but no local image AND no server dims → can't build.
          cropBuildIdRef.current = null;
          cropDimsRef.current = null;
          setReceiptCrop({ status: "failed", pages: [], error: "server sent no image dims" });
        }
      } else {
        // No receipt cards → nothing to build.
        cropBuildIdRef.current = null;
        cropDimsRef.current = null;
        setReceiptCrop({ status: "ready", pages: [] });
      }
    } catch (e: any) {
      setError(e?.message ?? t('swipe.errorQueue'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      userIdRef.current = await getUserId();
    })();
  }, []);

  useEffect(() => {
    loadQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionNum, receiptIdx]);

  // ── Vote dispatch ──────────────────────────────────────────────────────

  const sendVote = async (vote: Vote, item: QueueCard, dwell: number) => {
    const userId = userIdRef.current!;
    try {
      // Pending-alias card (Issue H vocabulary): the verdict acts on the learned alias
      // (identical → confirms the print → 'canonical' at K distinct users).
      if (isAliasCard(item)) {
        if (dwell < MIN_DWELL_MS) return;
        await fetchWithTimeout(
          `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/alias-votes`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ aliasId: item.aliasId, vote }),
            timeoutMs: TIMEOUT_STANDARD_MS,
          },
        );
        return;
      }
      // Card B (receipt resolution): the verdict acts on the receipt line.
      // The line was already marked 'asked' when the resolve-queue served it,
      // so a fast (burst) swipe means "not interested" — keep the system's best
      // match and don't apply the vote (Decision 4: asked-but-unresolved).
      if (isReceiptCard(item)) {
        if (dwell < MIN_DWELL_MS) return;
        const rid = itemsReceiptId ?? currentReceiptId;
        if (!rid) return;
        const res = await fetchWithTimeout(
          `${API_BASE_URL}/api/receipts/${encodeURIComponent(rid)}/lines/${item.receiptLineIdx}/vote`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            timeoutMs: TIMEOUT_STANDARD_MS,
            // userId attributes the vote to a distinct user for vocabulary capture
            // (Issue H) — an 'identical' on a matcher-struggled line learns the alias.
            // proposedSpId (proposed cards only): echoes the card's candidate so an
            // identical LINKS it server-side / a different blacklists the combo.
            body: JSON.stringify({
              vote,
              userId,
              ...(item.proposed ? { proposedSpId: item.matched.spId } : {}),
            }),
          },
        );
        // The vote endpoint returns the resolved line ({ ok, line }). Hand it to the
        // host so the in-flow receipt detail patches that row live (a 'different'
        // demotes it to OCR) instead of waiting for a focus re-sync on reopen.
        if (res.ok && onLineResolved) {
          const data = await res.json().catch(() => null);
          if (data && "line" in data) onLineResolved(rid, item.receiptLineIdx, data.line ?? null);
        }
        return;
      }
      let res: Response;
      if (item.slot === 2) {
        res = await fetchWithTimeout(
          `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/swipe-vote/slot2`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            timeoutMs: TIMEOUT_STANDARD_MS,
            body: JSON.stringify({
              orphanSpId: item.left.spId,
              candidateSpId: item.right.spId,
              vote,
              dwellMs: dwell,
              conflictDetected: item.slot2Meta?.conflictDetected ?? false,
              sameChain: item.slot2Meta?.sameChain ?? false,
            }),
          }
        );
      } else {
        res = await fetchWithTimeout(
          `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/swipe-vote`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            timeoutMs: TIMEOUT_STANDARD_MS,
            body: JSON.stringify({
              spIdA: item.left.spId,
              spIdB: item.right.spId,
              vote,
              dwellMs: dwell,
              // When this card belongs to a receipt, let a 'different' vote demote
              // the rejected line back to its OCR name server-side.
              receiptId: currentReceiptId ? Number(currentReceiptId) : undefined,
            }),
          }
        );
      }
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.level) stashLevel(data.level).catch(() => {});
      }
    } catch (e) {
      console.warn("[SwipeQueue] vote POST failed:", e);
    }
  };

  // ── Advance / undo ─────────────────────────────────────────────────────

  const advance = (vote: Vote | null) => {
    const item = cappedItems[idx];
    if (!item) return;

    const dwell = Date.now() - cardShownAtRef.current;

    if (pendingVoteRef.current) {
      const prev = pendingVoteRef.current;
      clearTimeout(prev.timer);
      pendingVoteRef.current = null;
      sendVote(prev.vote, prev.item, prev.dwell).catch(() => {});
    }

    translateX.value = 0;
    translateY.value = 0;
    // Next card springs in (scale + fade) instead of snapping to center.
    enterProgress.value = 0;
    enterProgress.value = withSpring(1, { damping: 18, stiffness: 170, mass: 0.7 });
    setIdx((i) => i + 1);
    cardShownAtRef.current = Date.now();

    if (vote === null) {
      setUndoLabel(null);
      return;
    }

    if (dwell < MIN_DWELL_MS) {
      setUndoLabel(null);
      sendVote(vote, item, dwell).catch(() => {});
      return;
    }

    const label =
      vote === "identical" ? t('swipe.directionIdentical') : vote === "similar" ? t('swipe.directionSimilar') : t('swipe.directionDifferent');
    setUndoLabel(label);

    const timer = setTimeout(() => {
      pendingVoteRef.current = null;
      setUndoLabel(null);
      sendVote(vote, item, dwell).catch(() => {});
    }, UNDO_DELAY_MS);

    pendingVoteRef.current = { item, vote, dwell, timer };
  };

  const handleUndo = () => {
    if (!pendingVoteRef.current) return;
    clearTimeout(pendingVoteRef.current.timer);
    pendingVoteRef.current = null;
    setUndoLabel(null);
    setIdx((i) => Math.max(0, i - 1));
    cardShownAtRef.current = Date.now();
  };

  // Animate card off in the given direction then call advance.
  const advanceTap = (vote: Vote | null) => {
    if (vote === "different") {
      translateX.value = withTiming(-SCREEN_W, { duration: 200 }, () =>
        runOnJS(advance)(vote)
      );
    } else if (vote === "identical") {
      translateX.value = withTiming(SCREEN_W, { duration: 200 }, () =>
        runOnJS(advance)(vote)
      );
    } else if (vote === "similar") {
      translateY.value = withTiming(-SCREEN_H, { duration: 200 }, () =>
        runOnJS(advance)(vote)
      );
    } else {
      translateY.value = withTiming(SCREEN_H, { duration: 200 }, () =>
        runOnJS(advance)(null)
      );
    }
  };

  // ── Gesture ────────────────────────────────────────────────────────────

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      translateX.value = e.translationX;
      translateY.value = e.translationY;
    })
    .onEnd((e) => {
      const up = e.translationY < -SWIPE_THRESHOLD_Y;
      const down = e.translationY > SWIPE_THRESHOLD_Y;
      const right = e.translationX > SWIPE_THRESHOLD_X;
      const left = e.translationX < -SWIPE_THRESHOLD_X;

      if (up) {
        translateY.value = withTiming(-SCREEN_H, { duration: 220 }, () =>
          runOnJS(advance)("similar")
        );
      } else if (right) {
        translateX.value = withTiming(SCREEN_W, { duration: 220 }, () =>
          runOnJS(advance)("identical")
        );
      } else if (left) {
        translateX.value = withTiming(-SCREEN_W, { duration: 220 }, () =>
          runOnJS(advance)("different")
        );
      } else if (down) {
        translateY.value = withTiming(SCREEN_H, { duration: 220 }, () =>
          runOnJS(advance)(null)
        );
      } else {
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
      }
    });

  const cardStyle = useAnimatedStyle(() => {
    const rotate = interpolate(
      translateX.value,
      [-SCREEN_W, 0, SCREEN_W],
      [-10, 0, 10]
    );
    // Entrance: scale up from 0.92 + fade in as the new card lands.
    const enterScale = interpolate(enterProgress.value, [0, 1], [0.92, 1], Extrapolation.CLAMP);
    const enterOpacity = interpolate(enterProgress.value, [0, 1], [0.35, 1], Extrapolation.CLAMP);
    return {
      opacity: enterOpacity,
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value },
        { rotate: `${rotate}deg` },
        { scale: enterScale },
      ],
    };
  });

  const tintStyle = useAnimatedStyle(() => {
    const dxAbs = Math.min(1, Math.abs(translateX.value) / SWIPE_THRESHOLD_X);
    const upAbs =
      translateY.value < 0 ? Math.min(1, -translateY.value / SWIPE_THRESHOLD_Y) : 0;
    const downAbs =
      translateY.value > 0 ? Math.min(1, translateY.value / SWIPE_THRESHOLD_Y) : 0;
    const dominantY = Math.max(upAbs, downAbs);
    let bg = "transparent";
    let opacity = 0;
    if (dominantY > dxAbs) {
      if (upAbs >= downAbs) { bg = colors.info; opacity = upAbs * 0.35; }
      else { bg = colors.surfaceMuted; opacity = downAbs * 0.3; }
    } else if (translateX.value > 0) {
      bg = colors.primary; opacity = dxAbs * 0.35;
    } else if (translateX.value < 0) {
      bg = colors.error; opacity = dxAbs * 0.35;
    }
    return { backgroundColor: bg, opacity };
  });

  // ── Derived ────────────────────────────────────────────────────────────

  // `items` is now pre-capped by loadQueue (server mandatory-queue or
  // capVoluntaryQueue) so the renderer just iterates. Keeping the alias
  // local to avoid churn through the existing references below.
  const cappedItems = items;
  const currentItem = cappedItems[idx];

  // ── Card image readiness gate ──────────────────────────────────────────
  // The data fetch finishing does NOT mean the card is showable: the crop is a
  // server image whose MinIO object may still be uploading, and product images
  // load over the network. Keep the spinner until the current card's TWO image
  // slots (crop + product, or left + right) have each settled — loaded or given
  // up — so "spinner gone = card is fully actionable". A timeout backstops a
  // failed upload so it can never hang.
  // A card has exactly TWO image slots — receipt card: 'crop' + 'product';
  // pair card: 'left' + 'right'. We count DISTINCT settled slots in a Set (NOT a
  // bare counter): the OCR crop side swaps its inner element TYPE on loading→ready
  // (CropDiag spinner → BandCropImage) with no stable key, so its onSettled fires
  // MORE than once. A counter double-counted that single slot and could reach 2 from
  // the crop alone — flipping cardReady before the matched-product image settled. A
  // Set keyed by slot id is idempotent: the gate clears only when both slots report.
  const EXPECTED_CARD_SLOTS = 2;
  const [cardReady, setCardReady] = useState(false);
  const settledSlotsRef = useRef<Set<string>>(new Set());
  const cardKey = currentItem?.cardId ?? null;
  // Reset the gate in the RENDER phase when the active card changes — this runs
  // BEFORE the new card's image children mount, so their onSettled callbacks count
  // from 0. (A reset in a useEffect would run AFTER the child effects and drop an
  // image that settles immediately, e.g. a product with no URL → placeholder.)
  const prevCardKeyRef = useRef<string | null>(null);
  if (prevCardKeyRef.current !== cardKey) {
    prevCardKeyRef.current = cardKey;
    settledSlotsRef.current = new Set();
    // Gate ONLY the FIRST card (idx 0): its crop may still be building post-scan.
    // Cards reached AFTER a swipe show immediately (their crop reuses the per-receipt
    // pages already built), so the Tinder entrance animation isn't hidden by the spinner.
    setCardReady(idx !== 0);
  }
  const handleImageSettled = (slotId: string) => {
    settledSlotsRef.current.add(slotId);
    if (settledSlotsRef.current.size >= EXPECTED_CARD_SLOTS) setCardReady(true);
  };
  useEffect(() => {
    if (!currentItem) return;
    // Backstop so the spinner can never hang on a slow/failed crop build. With the
    // local fast path this almost never fires; sized above the download fallback's
    // ~14s budget so it doesn't clear the gate while a fallback crop is still building.
    const t = setTimeout(() => setCardReady(true), 16000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardKey, idx]);

  // ── Bounded crop re-arm ────────────────────────────────────────────────
  // A DOWNLOAD-path crop is otherwise terminal: once buildReceiptPageMeta exhausts
  // its retry budget (status:'failed') nothing re-invokes it, so a receipt whose
  // MinIO upload lands a few seconds after the budget shows 'cropFailed' for the
  // rest of the session. Schedule ONE delayed rebuild per receipt when the failure
  // looks upload-pending. The local fast path never reaches this (no dims retained).
  useEffect(() => {
    if (receiptCrop.status !== "failed") return;
    const rid = currentReceiptId;
    if (!rid) return;
    const dims = cropDimsRef.current;
    if (!dims || dims.receiptId !== rid) return; // no download dims → nothing to retry
    if (cropRearmedRef.current === rid) return; // already retried this receipt once
    const err = receiptCrop.error ?? "";
    if (!/pending|not ready|HTTP|download/i.test(err)) return; // only retry upload-pending failures
    cropRearmedRef.current = rid;
    const timer = setTimeout(() => {
      if (cropBuildIdRef.current !== rid && cropBuildIdRef.current !== null) return; // user advanced
      cropBuildIdRef.current = rid;
      setReceiptCrop({ status: "loading", pages: [] });
      buildReceiptPageMeta(rid, dims.width, dims.height, dims.regionXBounds)
        .then((res) => {
          if (cropBuildIdRef.current === rid) {
            setReceiptCrop({ status: res.pageMeta ? "ready" : "failed", pages: res.pageMeta ? [res.pageMeta] : [], error: res.error });
          }
        })
        .catch((e) => {
          if (cropBuildIdRef.current === rid) {
            setReceiptCrop({ status: "failed", pages: [], error: String(e?.message ?? e) });
          }
        });
    }, 8000);
    return () => clearTimeout(timer);
     
  }, [receiptCrop.status, receiptCrop.error, currentReceiptId]);
  // `itemsReceiptId === currentReceiptId` is the staleness gate. Until
  // loadQueue refreshes after a receiptIdx bump, `items` still holds the
  // previous receipt's cards — without this check, `done` would flip true
  // for the new receipt instantly and POST complete-swipes for cards the
  // user never saw.
  const itemsMatchReceipt = itemsReceiptId === currentReceiptId;
  const doneWithCurrentReceipt =
    !loading &&
    !error &&
    itemsMatchReceipt &&
    (cappedItems.length === 0 || idx >= cappedItems.length);

  // ── Flow control: per-receipt completion ─────────────────────────────
  //
  // When the current receipt's session ends, behaviour splits by mode:
  //   • Mandatory: POST /complete-swipes (clears banner count); advance
  //     receiptIdx if more receipts remain; else navigate to returnTo
  //     or the legacy /receipt-process flow.
  //   • Voluntary: never POST /complete-swipes (mandatory tracking is
  //     orthogonal). Single-receipt session only — navigate straight
  //     back to /receipt-process so the breakdown re-renders with any
  //     newly-resolved Nepriskirta lines.
  useEffect(() => {
    if (!doneWithCurrentReceipt) return;
    if (!currentReceiptId) return;
    if (finishedRef.current) return;
    // Voluntary mode with 0 cards returned: don't auto-navigate. Show
    // the empty state below so the user understands there's nothing to
    // rescue right now instead of being silently bounced back to the
    // receipt screen. Mandatory mode still auto-navigates because it
    // needs to mark the receipt complete server-side.
    if (isVoluntary && cappedItems.length === 0) return;

    let cancelled = false;
    (async () => {
      // Flush any deferred (undo-window) vote FIRST and AWAIT it, so anything downstream —
      // /complete-swipes and especially the host's post-swipe loadExistingReceipt — sees the
      // committed (e.g. demoted) line. The undo timer is UNDO_DELAY_MS (3000ms), far longer
      // than the 400ms grace below, so without this a slow receipt refetch could land stale
      // pre-vote data over the correct live onLineResolved patch.
      if (pendingVoteRef.current) {
        const p = pendingVoteRef.current;
        clearTimeout(p.timer);
        pendingVoteRef.current = null;
        setUndoLabel(null);
        try { await sendVote(p.vote, p.item, p.dwell); } catch {}
      }
      if (cancelled) return;
      if (!isVoluntary) {
        // Mandatory: always mark the current receipt complete — even
        // if cappedItems was 0 (no candidates available), the server
        // counter must be cleared so the banner count drops on return.
        // Bounded + non-blocking: the user's path to the receipt must not wait on
        // this counter write (the host trusts the client-side completion — every
        // card was swiped here). Fire it capped; a lost response self-heals via the
        // next queue-count refresh.
        // Echo the Card-B line indices actually SERVED for THIS receipt so the
        // server's ask-once ledger is bulletproof against snapshot eviction (Gap 2).
        // Empty set → [] (server treats empty as "mark nothing", which is correct).
        const servedResolveLineIdxs = Array.from(
          servedResolveLineIdxsRef.current.get(currentReceiptId) ?? [],
        ).sort((a, b) => a - b);
        fetchWithTimeout(`${API_BASE_URL}/api/receipts/${currentReceiptId}/complete-swipes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ servedResolveLineIdxs }),
          timeoutMs: TIMEOUT_STANDARD_MS,
        }).catch(() => {});
      }
      if (cancelled) return;

      const hasNext = !isVoluntary && receiptIdx + 1 < receiptIdList.length;
      if (hasNext) {
        // Move to next receipt; loadQueue fires via the receiptIdx effect.
        setReceiptIdx((i) => i + 1);
        return;
      }

      // Wrap the session.
      finishedRef.current = true;
      // If cards WERE shown, give the latest pending vote a chance to commit and fetch the
      // profile (used to decide the level-up modal). If cappedItems was 0 (all lines
      // auto-matched or unmatched → nothing to swipe, e.g. receipts 220/221), nothing was
      // voted and no level-up is possible, so skip the 400ms grace + profile fetch and hand
      // off immediately — otherwise the empty mandatory session shows a ~1s blank page.
      if (cappedItems.length > 0) {
        await new Promise((r) => setTimeout(r, 400));
        const userId = userIdRef.current;
        if (userId) {
          try {
            const r = await fetchWithTimeout(
              `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/profile`,
              { timeoutMs: TIMEOUT_FAST_MS },
            );
            const d = await r.json();
            if (d?.level) await stashLevel(d.level);
          } catch {}
        }
      }
      if (cancelled) return;
      // Hand the final navigation to the host. The standalone route pops back (voluntary)
      // or replaces returnTo; the receipt-process host flips straight to its detail phase.
      onAllDone({
        reason: isVoluntary ? "voluntary" : "mandatory",
        lastReceiptId: currentReceiptId,
        returnTo,
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneWithCurrentReceipt, currentReceiptId, receiptIdx]);

  // Standalone: trigger modal directly on the done screen.
  useEffect(() => {
    if (doneWithCurrentReceipt && !currentReceiptId && !loading) {
      (async () => {
        const userId = userIdRef.current;
        if (!userId) return;
        try {
          const r = await fetch(
            `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/profile`
          );
          const d = await r.json();
          if (d?.level) await triggerIfNewLevel(d.level);
        } catch {}
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneWithCurrentReceipt, currentReceiptId, loading]);

  // ── Render ─────────────────────────────────────────────────────────────

  // The done/empty SCREEN is shown only for the standalone session-complete state or a
  // voluntary receipt with nothing to rescue. Every OTHER "done" state — a mandatory in-place
  // session (including the 0-card case: receipts 220/221) or a voluntary all-seen session — is
  // a HAND-OFF: the completion effect above is navigating away (onAllDone → the host flips to
  // the receipt detail). During that brief window render the loader, NOT a blank page, so the
  // mandatory empty queue never shows the bare header the user reported.
  const showDoneScreen =
    doneWithCurrentReceipt && (!currentReceiptId || (isVoluntary && cappedItems.length === 0));
  const handOffPending = doneWithCurrentReceipt && !showDoneScreen;

  return (
    <GestureHandlerRootView
      style={{ flex: 1, backgroundColor: colors.pageBackground }}
    >
      {/* Back routes through onExit — mode-aware: the standalone route pops back, the
          in-place receipt-process host runs leaveSwipePhase (which fetches the comparison
          and flips to the detail). A raw router.back() here would pop the whole host screen
          and strand the just-saved receipt. The native header is hidden in favour of the
          app's in-screen chrome pattern (pink chevron + left title, own top inset). */}
      {renderHeader && (
        <>
          <Stack.Screen options={{ headerShown: false }} />
          <ScreenNavBar
            title={t('swipe.header')}
            subtitle={isMulti ? t('swipe.headerProgress', { current: receiptIdx + 1, total: receiptIdList.length }) : undefined}
            onBack={() => onExit()}
          />
        </>
      )}

      {/* ── Loading ──
          Covers the screen while the queue data loads, while the active card's images are
          still settling (rendered as an overlay so the card mounts underneath and its images
          can load), AND during a mandatory/voluntary hand-off while the completion effect
          navigates away. "Spinner gone = card actionable." */}
      {(loading ||
        handOffPending ||
        (!error && !doneWithCurrentReceipt && !!currentItem && !cardReady)) && (
        <View
          style={[
            StyleSheet.absoluteFill,
            styles.centered,
            { backgroundColor: colors.pageBackground, zIndex: 20, elevation: 20 },
          ]}
        >
          <ProcessingLoader stage="loadingCards" />
        </View>
      )}

      {/* ── Error ── */}
      {!loading && error && (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.btn} onPress={onExit}>
            <Text style={styles.btnText}>{t('swipe.back')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Done / empty ──
          Standalone (no receiptId) always renders here. Voluntary mode
          with 0 cards stays here too — the auto-navigate effect skips
          it so the user sees an honest "nothing to rescue right now"
          message instead of being silently bounced back to the receipt. */}
      {!loading && !error && showDoneScreen && (
        <View style={styles.centered}>
          <Ionicons
            name={cappedItems.length === 0 && isVoluntary ? "leaf-outline" : "checkmark-circle"}
            size={72}
            color={cappedItems.length === 0 && isVoluntary ? colors.textMuted : colors.primary}
          />
          <Text style={styles.doneTitle}>
            {cappedItems.length === 0 && isVoluntary ? t('swipe.doneEmpty') : t('swipe.doneAck')}
          </Text>
          <Text style={styles.doneSubtitle}>
            {cappedItems.length === 0 && isVoluntary
              ? t('swipe.emptyVoluntaryReceipt')
              : cappedItems.length === 0
              ? t('swipe.emptyNothing')
              : t('swipe.doneAllSeen')}
          </Text>
          <View style={styles.btnRow}>
            {cappedItems.length > 0 && !isVoluntary && (
              <TouchableOpacity
                style={styles.btnOutline}
                onPress={() => setSessionNum((n) => n + 1)}
              >
                <Text style={styles.btnOutlineText}>{t('swipe.moreCta')}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.btn} onPress={onExit}>
              <Text style={styles.btnText}>{t('swipe.back')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Progress glow — a thin fill pinned over the very top of the screen
          (same treatment as the shopping list's top-edge glow). Fills as the
          deck advances: a mandatory 3-card session steps in thirds, voluntary
          over its full deck length. */}
      {!loading && !error && !doneWithCurrentReceipt && currentItem && (
        <ProgressGlow fraction={cappedItems.length ? idx / cappedItems.length : 0} />
      )}

      {/* ── Active card ── */}
      {!loading && !error && !doneWithCurrentReceipt && currentItem && (
        <View style={styles.activeWrap}>
          {/* Help button (top) — opens the "how to swipe" explainer. */}
          <TouchableOpacity
            style={styles.helpBtn}
            onPress={() => setShowHelp(true)}
            activeOpacity={0.7}
          >
            <Ionicons name="help-circle-outline" size={18} color={colors.primary} />
            <Text style={styles.helpBtnText}>{t('swipe.helpButton')}</Text>
          </TouchableOpacity>

          <View style={styles.stage}>
            {!isReceiptCard(currentItem) && !isAliasCard(currentItem) && currentItem.fromGlobalFill && (
              <Text style={styles.fromGlobalSubline} numberOfLines={2}>
                {t('swipe.fromGlobalFill')}
              </Text>
            )}
            {(isReceiptCard(currentItem) || isAliasCard(currentItem)) && (
              <Text style={styles.questionHeader}>{t('swipe.cardQuestion')}</Text>
            )}
            <GestureDetector gesture={pan}>
              <Animated.View style={[styles.card, cardStyle]}>
                <Animated.View
                  style={[StyleSheet.absoluteFill, styles.cardTint, tintStyle]}
                />
                {/* Vertical layout: your receipt item on TOP, the match below. */}
                <View style={styles.cardInner} key={cardKey ?? undefined}>
                  {isReceiptCard(currentItem) ? (
                    <>
                      <OcrReceiptSide key={currentItem.cardId} ocr={currentItem.ocr} region={currentItem.region} crop={receiptCrop} label={t('swipe.cardReceiptLabel')} styles={styles} colors={colors} onSettled={() => handleImageSettled('crop')} />
                      <View style={styles.horizontalDivider} />
                      <MatchedProductSide matched={currentItem.matched} sourceChainId={currentItem.sourceChainId} label={t('swipe.cardMatchLabel')} styles={styles} onSettled={() => handleImageSettled('product')} />
                    </>
                  ) : isAliasCard(currentItem) ? (
                    <>
                      <AliasOcrSide text={currentItem.ocrText} label={t('swipe.cardReceiptLabel')} styles={styles} onSettled={() => handleImageSettled('aliasText')} />
                      <View style={styles.horizontalDivider} />
                      <MatchedProductSide matched={{ spId: currentItem.sp.spId, name: currentItem.sp.name, imageUrl: currentItem.sp.imageUrl }} label={t('swipe.cardMatchLabel')} styles={styles} onSettled={() => handleImageSettled('product')} />
                    </>
                  ) : (
                    <>
                      <CardSide side={currentItem.left} styles={styles} onSettled={() => handleImageSettled('left')} />
                      <View style={styles.horizontalDivider} />
                      <CardSide side={currentItem.right} styles={styles} onSettled={() => handleImageSettled('right')} />
                    </>
                  )}
                </View>
              </Animated.View>
            </GestureDetector>
          </View>

          {/* Tinder-style action buttons (bottom of the screen). */}
          <View style={styles.bottomBar}>
            <ActionButton Icon={DivergeArrowsIcon} color={colors.error} label={t('swipe.cardActionDifferent')} onPress={() => advanceTap("different")} styles={styles} />
            <ActionButton icon="play-skip-forward" color={colors.textMuted} label={t('swipe.cardActionSkip')} onPress={() => advanceTap(null)} styles={styles} />
            <ActionButton Icon={ParallelArrowsIcon} color={colors.warning} label={t('swipe.cardActionSimilar')} onPress={() => advanceTap("similar")} styles={styles} />
            <ActionButton Icon={MergeArrowsIcon} color={colors.success} label={t('swipe.cardActionIdentical')} onPress={() => advanceTap("identical")} styles={styles} />
          </View>
        </View>
      )}

      {/* ── "How to swipe" help modal ── */}
      <Modal visible={showHelp} transparent animationType="fade" onRequestClose={() => setShowHelp(false)}>
        <Pressable style={styles.helpBackdrop} onPress={() => setShowHelp(false)}>
          <Pressable style={styles.helpCard} onPress={() => {}}>
            <Text style={styles.helpTitle}>{t('swipe.helpTitle')}</Text>
            <Text style={styles.helpIntro}>{t('swipe.helpIntro')}</Text>

            <View style={styles.helpAction}>
              <MergeArrowsIcon size={24} color={colors.success} />
              <Text style={styles.helpActionText}>{t('swipe.helpIdentical')}</Text>
            </View>
            <View style={styles.helpAction}>
              <ParallelArrowsIcon size={24} color={colors.warning} />
              <Text style={styles.helpActionText}>{t('swipe.helpSimilar')}</Text>
            </View>
            <View style={styles.helpAction}>
              <DivergeArrowsIcon size={24} color={colors.error} />
              <Text style={styles.helpActionText}>{t('swipe.helpDifferent')}</Text>
            </View>
            <View style={styles.helpAction}>
              <Ionicons name="play-skip-forward" size={24} color={colors.textMuted} />
              <Text style={styles.helpActionText}>{t('swipe.helpSkip')}</Text>
            </View>

            <Text style={styles.helpNote}>{t('swipe.helpUnreadable')}</Text>
            <Text style={styles.helpNote}>{t('swipe.helpMatters')}</Text>
            <Text style={styles.helpNote}>{t('swipe.helpDoesntMatter')}</Text>
            <Text style={styles.helpHint}>{t('swipe.helpHint')}</Text>

            <TouchableOpacity style={styles.helpClose} onPress={() => setShowHelp(false)}>
              <Text style={styles.helpCloseText}>{t('swipe.helpClose')}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── Undo toast ── */}
      {undoLabel !== null && (
        <View style={styles.undoToast}>
          <Text style={styles.undoText}>{undoLabel}</Text>
          <TouchableOpacity onPress={handleUndo} style={styles.undoBtn}>
            <Text style={styles.undoBtnText}>{t('swipe.undoCancel')}</Text>
          </TouchableOpacity>
        </View>
      )}
    </GestureHandlerRootView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const makeStyles = (c: AppTheme) =>
  StyleSheet.create({
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },

    // ── Done state ──
    doneTitle: {
      fontSize: 24,
      fontWeight: "700",
      color: c.textPrimary,
      marginTop: 12,
    },
    doneSubtitle: {
      color: c.textSecondary,
      textAlign: "center",
      marginTop: 8,
      marginBottom: 20,
      fontSize: 14,
    },
    btnRow: { flexDirection: "row", gap: 12 },
    btn: {
      backgroundColor: c.primary,
      paddingVertical: 12,
      paddingHorizontal: 24,
      borderRadius: 12,
    },
    btnText: { color: c.onPrimary, fontWeight: "600", fontSize: 15 },
    btnOutline: {
      backgroundColor: c.cardBackground,
      borderWidth: 1,
      borderColor: c.primary,
      paddingVertical: 12,
      paddingHorizontal: 24,
      borderRadius: 12,
    },
    btnOutlineText: { color: c.primary, fontWeight: "600", fontSize: 15 },
    errorText: {
      color: c.error,
      textAlign: "center",
      marginBottom: 16,
      fontSize: 16,
    },

    // ── Stage ──
    stage: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: STAGE_H_PAD,
      paddingBottom: 8,
    },

    // ── Card ──
    card: {
      width: CARD_W,
      backgroundColor: c.cardBackground,
      borderRadius: 20,
      overflow: "hidden",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.12,
      shadowRadius: 10,
      elevation: 6,
    },
    cardTint: { borderRadius: 20 },
    cardInner: {
      flexDirection: "column",
      paddingHorizontal: 14,
      paddingVertical: 14,
    },
    horizontalDivider: {
      height: 1,
      backgroundColor: c.border,
      width: "100%",
      marginVertical: 10,
    },
    // ── Card-B sides (vertical) ──
    sideBlock: {
      width: "100%",
      alignItems: "center",
    },
    sideLabel: {
      fontSize: 10,
      fontWeight: "700",
      color: c.textMuted,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      marginBottom: 8,
      alignSelf: "flex-start",
    },
    // The band crop renders at its OWN (band) aspect, so the wrap just centres it
    // full-width; a min height keeps thin single-line bands and the diagnostic box
    // from collapsing the card.
    cropBandWrap: {
      width: "100%",
      minHeight: 56,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 8,
      overflow: "hidden",
      backgroundColor: c.surfaceMuted,
    },
    cropDiag: {
      height: 84,
      gap: 6,
      paddingHorizontal: 10,
    },
    cropDiagText: {
      fontSize: 11,
      color: c.textMuted,
      textAlign: "center",
    },
    // Pending-alias card: the receipt's printed OCR text (shown in place of a crop).
    aliasOcrText: {
      fontSize: 17,
      fontWeight: "600",
      color: c.textPrimary,
      textAlign: "center",
      paddingHorizontal: 8,
    },
    ocrCaption: {
      fontSize: 11,
      fontStyle: "italic",
      color: c.textMuted,
      textAlign: "center",
      marginTop: 6,
    },
    matchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      width: "100%",
    },
    matchImg: { width: 72, height: 72 },
    matchImgPlaceholder: {
      width: 72,
      height: 72,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surfaceMuted,
      borderRadius: 8,
    },
    matchName: {
      flex: 1,
      fontSize: 15,
      fontWeight: "700",
      color: c.textPrimary,
      lineHeight: 20,
    },
    // ── Active layout ──
    activeWrap: { flex: 1 },
    questionHeader: {
      fontSize: 16,
      fontWeight: "800",
      color: c.textPrimary,
      textAlign: "center",
      marginBottom: 12,
    },
    helpBtn: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "center",
      gap: 6,
      marginTop: 8,
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 999,
      backgroundColor: c.surfaceMuted,
    },
    helpBtnText: { fontSize: 13, fontWeight: "700", color: c.primary },
    // ── Tinder-style action buttons ──
    bottomBar: {
      flexDirection: "row",
      justifyContent: "space-around",
      alignItems: "flex-start",
      paddingHorizontal: 12,
      paddingTop: 10,
      paddingBottom: 24,
    },
    actionBtn: { alignItems: "center", gap: 6, flex: 1 },
    actionIconWrap: {
      width: 56,
      height: 56,
      borderRadius: 28,
      borderWidth: 2,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.cardBackground,
    },
    actionLabel: { fontSize: 11, fontWeight: "700", color: c.textSecondary, textAlign: "center" },
    // ── Help modal ──
    helpBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.45)",
      justifyContent: "center",
      paddingHorizontal: 24,
    },
    helpCard: {
      backgroundColor: c.cardBackground,
      borderRadius: 18,
      padding: 20,
      gap: 10,
    },
    helpTitle: { fontSize: 18, fontWeight: "800", color: c.textPrimary },
    helpIntro: { fontSize: 14, color: c.textSecondary, marginBottom: 4 },
    helpAction: { flexDirection: "row", alignItems: "center", gap: 10 },
    helpActionText: { flex: 1, fontSize: 13, color: c.textPrimary, lineHeight: 18 },
    helpBold: { fontWeight: "800" },
    helpNote: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    helpHint: { fontSize: 12, fontStyle: "italic", color: c.textMuted, marginTop: 4 },
    helpClose: {
      marginTop: 10,
      alignSelf: "stretch",
      backgroundColor: c.primary,
      borderRadius: 12,
      paddingVertical: 12,
      alignItems: "center",
    },
    helpCloseText: { color: "#fff", fontWeight: "800", fontSize: 15 },
    // Voluntary-mode subline above the card. Italic, muted colour,
    // small font — communicates "you're now helping the community"
    // without competing with the active card content.
    fromGlobalSubline: {
      fontSize: 12,
      fontStyle: "italic",
      color: c.textMuted,
      textAlign: "center",
      paddingHorizontal: 16,
      marginBottom: 8,
    },
    verticalDivider: {
      width: 1,
      backgroundColor: c.border,
      marginHorizontal: 6,
      alignSelf: "stretch",
    },

    // ── Card half (vertical layout — content-sized, NOT flex:1 which collapses
    //    to a thin strip in a column with no fixed card height) ──
    half: {
      width: "100%",
      alignItems: "center",
      paddingVertical: 4,
    },
    chainRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginBottom: 6,
      width: "100%",
      justifyContent: "center",
    },
    chainLogo: {
      width: 16,
      height: 16,
    },
    chainName: {
      fontSize: 10,
      fontWeight: "700",
      color: c.textMuted,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      flexShrink: 1,
    },
    productImg: {
      width: IMG_SIZE,
      height: IMG_SIZE,
    },
    productImgPlaceholder: {
      width: IMG_SIZE,
      height: IMG_SIZE,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surfaceMuted,
      borderRadius: 8,
    },
    productImgEmoji: {
      fontSize: IMG_SIZE * 0.55,
      opacity: 0.4,
    },
    productName: {
      fontSize: 12,
      fontWeight: "600",
      color: c.textPrimary,
      textAlign: "center",
      marginTop: 8,
      lineHeight: 17,
    },

    // ── Tap buttons ──
    tapRow: {
      flexDirection: "row",
      marginTop: 14,
      gap: 8,
      width: "100%",
      justifyContent: "space-between",
    },
    tapBtn: {
      flex: 1,
      alignItems: "center",
      paddingVertical: 10,
      borderRadius: 12,
      backgroundColor: c.cardBackground,
      borderWidth: 1,
      borderColor: c.border,
      gap: 2,
    },
    tapBtnArrow: {
      fontSize: 16,
      color: c.textSecondary,
    },
    tapBtnLabel: {
      fontSize: 9,
      fontWeight: "600",
      color: c.textMuted,
      textAlign: "center",
    },

    // ── Undo toast ──
    undoToast: {
      position: "absolute",
      bottom: 100,
      left: 20,
      right: 20,
      backgroundColor: c.cardBackground,
      borderRadius: 14,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 12,
      paddingHorizontal: 16,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.12,
      shadowRadius: 8,
      elevation: 5,
    },
    undoText: {
      fontSize: 14,
      color: c.textSecondary,
    },
    undoBtn: {
      backgroundColor: c.primaryMuted,
      paddingVertical: 6,
      paddingHorizontal: 14,
      borderRadius: 8,
    },
    undoBtnText: {
      fontSize: 13,
      fontWeight: "700",
      color: c.primary,
    },
  });
