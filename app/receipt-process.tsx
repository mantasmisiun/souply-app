import {
    Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import { usePreventRemove,
    useNavigation,
    useFocusEffect } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import {
    useLocalSearchParams,
    useRouter } from "expo-router";
import Animated from "react-native-reanimated";
import { useCallback,
    useEffect,
    useMemo,
    useRef,
    useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Dimensions,
    Image,
    Modal,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { GlassIconButton } from "../components/GlassIconButton";
import { useCollapsingHeader, CollapsingHeader } from "../components/CollapsingHeader";
import { ScreenHeading } from "../components/ScreenHeading";
import ReceiptComparisonSection from "../components/receipt/ReceiptComparisonSection";
import ReceiptCategoryBreakdown from "../components/receipt/ReceiptCategoryBreakdown";
import ReceiptPhotoView from "../components/receipt/ReceiptPhotoView";
import { SkeletonBox } from "../components/SkeletonBox";
import { formatEuro, formatDate } from "../utils/formatCurrency";
import { devLog } from "../utils/devLog";
import { BandCropImage } from "../components/receipt/BandCropImage";
import { ProcessingLoader, type LoadingStage } from "../components/ProcessingLoader";
import { SwipeQueue } from "../components/swipe/SwipeQueue";
import {
    type PageMeta,
    ensurePortraitOrientation,
    normalizeLoadedImage,
    deriveImageDimsFromGeometry,
} from "../utils/receiptImage";
import { API_BASE_URL } from "../config/api";
import { IS_PROD } from "../config/env";
import { getUserId } from "../config/user";
import { useReceiptComparison } from "../hooks/useReceiptComparison";
import {
    computeRehydratedRegions,
    persistRehydratedRegions,
    markRegionsVersionCurrent,
    REGIONS_VERSION,
} from "../services/regionsRehydrationService";
import { DEV_MODE, CONFIDENCE_BAND_DISPLAY, PRODUCT_REOCR_ENABLED } from "../constants/flags";
import { useTheme, type AppTheme } from "../constants/theme";
import {
    useReceiptCreateContext,
    useReceiptPickerState,
} from "../state/basketState";
import {
    clearReceiptDraft,
    saveReceiptDraft,
} from "../state/receiptDraft";
import { useNetworkStatus } from "../state/networkStatus";
import { useReceiptQueueStore } from "../state/receiptQueueStore";
import { recordStoreVisit } from "../utils/locationStorage";
import { useLevelStore } from "../state/levelStore";
import {
    fetchWithTimeout,
    TIMEOUT_FAST_MS,
    TIMEOUT_HEAVY_MS,
    TIMEOUT_STANDARD_MS,
} from "../utils/fetchWithTimeout";
import {
    isIkiReceipt,
    parseIkiHeaderOnly,
    parseIkiReceipt,
    type IkiFooter,
    type IkiHeader,
    type IkiProduct,
} from "@shared/parsers/ikiParser";
import { RECOGNITION, type ItemConfidence } from "@shared/recognitionConfig";
import ConfidenceBadge from "../components/ConfidenceBadge";
import {
    isMaximaReceipt,
    parseMaximaHeaderOnly,
    parseMaximaReceipt,
    type MaximaFooter,
    type MaximaHeader,
    type MaximaProduct,
} from "@shared/parsers/maximaParser";
import {
    isLidlReceipt,
    parseLidlHeaderOnly,
    parseLidlReceipt,
    type LidlFooter,
    type LidlHeader,
    type LidlProduct,
} from "@shared/parsers/lidlParser";
import {
    isNorfaReceipt,
    parseNorfaHeaderOnly,
    parseNorfaReceipt,
    type NorfaFooter,
    type NorfaHeader,
    type NorfaProduct,
} from "@shared/parsers/norfaParser";
import {
    isRimiReceipt,
    parseRimiHeaderOnly,
    parseRimiReceipt,
    LabeledRegion,
    Region,
    RimiFooter,
    RimiHeader,
    RimiProduct
} from "@shared/parsers/rimiParser";
import { parseProductName } from "@shared/parsers/productNameParser";
import { detectChainByVatCode } from "@shared/parsers/chainVatFallback";
import { redactReceiptText, detectCardMaskBands, clampMaskBandsToProtected, wordCentreInMaskBand, looksLikePiiText, type MaskBand } from "@shared/parsers/cardMaskDetection";
import { buildRedactedUploadUri } from "../components/MaskRedactionHost";
import { requestStoreResolution, completeStoreResolution, pickAddressFromRawText } from "../utils/storeResolution";
import { StoreResolutionOverlay } from "../components/receipt/StoreResolutionOverlay";
import { ocrImageEnhanced } from "../utils/mlkitOcr";
import { refineFooterBands } from "../utils/footerBandRefine";
import { maybeReocrProducts, maybeReocrFooter, maybeReocrHeader, type ReocrOutcome } from "../utils/productReocr";
import { makeProductStripReocr, reportReocrOutcome } from "../utils/productReocrDevice";
import { launchDocumentScanner } from "../utils/launchDocumentScanner";
import { MaterialProgress } from "../components/MaterialProgress";
import { useProfileStore } from '../state/profileStore';

// Toggle for the iOS-only row-fragment merger in the Maxima + Lidl
// parsers. iOS MLKit splits each receipt row into multiple boxes at
// near-same y-coords; the merger glues them back into one Android-
// shaped line. Android emits one OCR line per row already, so the
// option stays off and the existing pipeline is bit-for-bit identical.
const PARSER_OPTS = { iosOcr: Platform.OS === 'ios' };

/**
 * DEV: paste-friendly dump of what a chain parser produced from the OCR text.
 * Pair with the "DEDUPED RAW TEXT" block above it to review parser accuracy —
 * copy both blocks out of the Metro log when a scanned receipt parses wrong.
 * Defensive field access (`?? '-'`) so it never throws on a partial parse.
 */
function logParsedReview(chain: string, parsed: any): void {
  try {
    const h = parsed?.header ?? {};
    const f = parsed?.footer ?? {};
    const products: any[] = Array.isArray(parsed?.products) ? parsed.products : [];
    const rows = products.map((p, i) =>
      `  ${String(i + 1).padStart(2, ' ')}. ${p?.name ?? '?'}` +
      ` | price=${p?.price ?? '-'} qty=${p?.quantity ?? '-'} promo=${p?.promoPrice ?? '-'}` +
      `${p?.brandName ? ` brand=${p.brandName}` : ''}` +
      `${p?.isWeighable ? ' [kg]' : ''}` +
      `${p?.categoryId != null ? ` cat=${p.categoryId}` : ''}`,
    );
    console.log(
      `=== PARSED REVIEW [${chain}] (${products.length} products) ===\n` +
      `header: store=${h.storeName ?? '-'} | code=${h.storeCode ?? '-'} | addr=${h.storeAddress ?? '-'} | chainId=${h.chainId ?? '-'}\n` +
      `footer: total=${f.total ?? '-'} | date=${f.date ?? '-'} | receiptNo=${f.receiptNo ?? '-'} | savings=${f.totalSavings ?? '-'}\n` +
      `${rows.join('\n')}\n` +
      `=== END PARSED [${chain}] ===`,
    );
  } catch (e) {
    console.log(`[PARSED REVIEW ${chain}] log failed`, e);
  }
}

// chainId → display name, for the chain-match gate copy.
const CHAIN_NAMES: Record<number, string> = { 1: 'Maxima', 2: 'Rimi', 3: 'Iki', 4: 'Norfa', 5: 'Lidl' };

interface ProductMatchOption {
  storeProductId: number;
  productId: number;
  categoryId: number;
  /** Server-joined category label (Phase 0d JOIN Category, server-side).
   *  Optional because pre-redesign receipts may not have it until the
   *  lazy-hydration GET handler backfills them. */
  categoryName?: string | null;
  /** L2 ancestor of categoryName — what the breakdown buckets on. Server
   *  CASE returns null for L1 categories. */
  categoryL2Name?: string | null;
  name: string;
  imageUrl: string | null;
  amount: number | null;
  unit: string | null;
  confidence: number;
  price?: number | null;
  promoPrice?: number | null;
}

interface ProductLine {
  name: string;
  matchedName: string | null;
  storeProductId: number | null;
  storeProductImageUrl: string | null;
  matchConfidence: number | null;
  matchConfirmed: boolean;
  priceVerified?: boolean;
  /** Set when the USER manually re-matched this line (name-edit rematch flow). The
   *  server's autosave merge honors match fields only for marked lines — see
   *  applyReceiptAutosave — so stale client state can't undo server-side votes. */
  manualMatch?: boolean;
  /** Server-set (read overlay): this line's match contradicts one of the user's old
   *  'different' votes and that vote is queued for a re-verification swipe. The match
   *  renders normally with a small "reconfirm" chip until the re-swipe settles it. */
  pendingReverification?: boolean;
  altMatches: ProductMatchOption[];
  price: number;
  promoPrice: number | null;
  quantity: number;
  /** Receipt quantity unit: "vnt" for pieces, "kg" for weighable. Used for calculation labels. */
  unit: string | null;
  /** Product package size amount (e.g. 165 for CHEETOS 165g). Stored on the SP. */
  amount: number | null;
  /** Product package size unit (e.g. "g", "ml", "rit"). Stored on the SP; separate from `unit`. */
  sizeUnit: string | null;
  pricePerUnit: number | null;
  rawLines: string[];
  region: Region;
  /**
   * Server-computed per-line confidence (DISPLAY-ONLY). Present on receipts
   * saved after the score shipped; null on live-scan lines (the score is
   * computed during save) and on older receipts. Drives the band-based display
   * behind {@link CONFIDENCE_BAND_DISPLAY} and the always-on `__DEV__` badge.
   */
  itemConfidence?: ItemConfidence | null;
  /**
   * Line-level category of the CURRENT primary match — set by the server at save +
   * on every demotion (runner-up → its category; orphan/OCR → null). The summary
   * breakdown prefers these over altMatches[0] (which is a borrowed candidate, not
   * necessarily the linked SP) so a swipe-'different' moves the line to the right
   * bucket. Absent on legacy receipts → breakdown falls back to altMatches[0].
   */
  categoryId?: number | null;
  categoryName?: string | null;
  categoryL2Name?: string | null;
}

/**
 * Map a product line's top match candidate to its stored display/link fields.
 *
 * A WEAK cross-chain fallback match — the candidate came from the cross-chain
 * catalog (`data.crossChain`) AND scored below the auto-apply bar — is too
 * speculative to advertise as "this product": it's another chain's catalog with a
 * sub-autoApply name hit (the slyvos / "IKI mince → another chain's mince" trap).
 * We ORPHAN it here: null matchedName/image/confidence so the receipt row shows
 * the OCR name from the start, while the candidates stay in `altMatches` for
 * orphan-rescue voting. The server then mints a fresh same-chain SP and the line
 * routes to orphan rescue instead of a confident "is this right?" Card-B.
 *
 * Strong (≥ autoApply) cross-chain matches still apply; same-chain matches are
 * untouched (a weak same-chain hit shares the catalog and IS the intended Card-B
 * confirm case).
 */
function topMatchDisplayFields(
  top: ProductMatchOption | null,
  isCrossChain: boolean,
  autoApply: boolean,
): Pick<
  ProductLine,
  | "matchedName"
  | "storeProductId"
  | "storeProductImageUrl"
  | "matchConfidence"
  | "matchConfirmed"
  | "priceVerified"
> {
  const weakCrossChain = isCrossChain && top !== null && !autoApply;
  return {
    matchedName: weakCrossChain ? null : top?.name ?? null,
    storeProductId: autoApply ? top!.storeProductId : null,
    storeProductImageUrl: weakCrossChain ? null : top?.imageUrl ?? null,
    matchConfidence: weakCrossChain ? null : top?.confidence ?? null,
    matchConfirmed: autoApply,
    priceVerified: autoApply,
  };
}

interface HeaderData {
  chainName: string;
  chainId: number | null;
  storeCode: string;
  storeAddress: string;
  storeId: number | null;
  storeName: string | null;
  storeAddressMatched: string | null;
  matchConfidence: number | null;
  matchLoading: boolean;
  rawText: string;
  region: Region;
  /** Per-field source-line bboxes (emitted by every chain parser
   *  post-Phase-6 refactor). Optional because pre-refactor receipts in
   *  the DB carry only the block `region`; the photo view falls back
   *  to that single bbox when this array is absent or empty. Each entry
   *  carries a `kind` so the renderer can colour + label per field. */
  lineRegions?: LabeledRegion[];
  /** Parser-output version. Stamped at upload time and updated by
   *  rehydration. Mobile compares against the current `REGIONS_VERSION`
   *  to decide whether to re-OCR a receipt whose persisted bands came
   *  from an earlier parser revision (e.g. before the Rimi anchored
   *  receiptNo fix or the Norfa fallback band fix). */
  regionsVersion?: string;
}

interface FooterData {
  total: number | null;
  date: string;
  time: string;
  receiptNo: string;
  totalSavings: number | null;
  /** Receipt-level combo/set-deal discount (IKI bare "RINKINYS -1,90") — POSITIVE
   *  magnitude off the paid total, owned by no single product. Rendered as an
   *  adjustment row on the Prekės tab; rides parsedData.footer to the server
   *  (savings + store comparison subtract it from the visited basket). */
  comboDiscount: number | null;
  rawText: string;
  region: Region;
  lineRegions?: LabeledRegion[];
}

type AsyncStatus = "idle" | "pending" | "done" | "error";

const CARD_WIDTH = Dimensions.get("window").width - 32 - 32;

/** Spec C2 — receipt-process screen tabs. */
type ReceiptTab = "suvestine" | "prekes" | "kvitas";

/**
 * C2 — Segmented control pinned below the navbar. Three tabs split the
 * detail screen into a focused-purpose surface each: comparison +
 * breakdown on Suvestinė, item list on Prekės, footer metadata on Kvitas.
 *
 * Default tab is Suvestinė; switching tabs resets that tab's scroll to
 * top (no per-tab scroll preservation in v1).
 */
function SegmentedControl({
  active,
  onChange,
  productCount,
  styles,
  colors,
}: {
  active: ReceiptTab;
  onChange: (t: ReceiptTab) => void;
  productCount: number;
  styles: ReturnType<typeof makeStyles>;
  colors: AppTheme;
}) {
  const { t } = useTranslation();
  const tabs: { key: ReceiptTab; label: string }[] = [
    { key: "suvestine", label: t('receiptProcess.tabSummary') },
    { key: "prekes", label: t('receiptProcess.tabProducts', { count: productCount }) },
    { key: "kvitas", label: t('receiptProcess.tabReceipt') },
  ];
  return (
    <View style={styles.segmentedWrap}>
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <TouchableOpacity
            key={tab.key}
            style={[styles.segmentTab, isActive && styles.segmentTabActive]}
            activeOpacity={0.7}
            onPress={() => {
              if (tab.key === active) return;
              Haptics.selectionAsync().catch(() => {});
              onChange(tab.key);
            }}
          >
            <Text style={[styles.segmentTabLabel, isActive && styles.segmentTabLabelActive]} numberOfLines={1}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/**
 * 3-up stat grid for the "Kvito duomenys" footer card (B4).
 *
 * Renders Suma · Laikas · Kvito № as equal columns, value on top
 * (semibold 18 pt), uppercase label below (muted 11 pt). Visually echoes
 * the per-category breakdown's stat-strip pattern so the cards read as
 * a family.
 *
 * Date is intentionally NOT included — the navbar subtitle already shows
 * it ("address · date"). Duplicating data on the same screen is noise.
 */
function FooterStatGrid({
  footer,
  comparison,
  styles,
}: {
  footer: FooterData | null;
  comparison: { currentChain?: { total?: number | null } } | null;
  styles: ReturnType<typeof makeStyles>;
}) {
  const { t } = useTranslation();
  // Sum: prefer parser footer total, fall back to comparison currentChain
  // total with a tilde prefix when only the chain agg is available.
  let sumDisplay: string;
  if (typeof footer?.total === "number") {
    sumDisplay = formatEuro(footer.total);
  } else if (typeof comparison?.currentChain?.total === "number") {
    sumDisplay = `~${formatEuro(comparison.currentChain.total)}`;
  } else {
    sumDisplay = "—";
  }

  // Time: drop seconds (noise) and degrade to "—" if missing.
  const timeDisplay = (() => {
    const raw = footer?.time?.trim();
    if (!raw) return "—";
    const m = raw.match(/^(\d{1,2}):(\d{2})/);
    return m ? `${m[1].padStart(2, "0")}:${m[2]}` : raw;
  })();

  // Receipt №: truncate to first 12 chars + ellipsis to keep the cell
  // legible when IKI synthesizes long compound IDs.
  const receiptDisplay = (() => {
    const raw = footer?.receiptNo?.trim();
    if (!raw) return "—";
    return raw.length > 12 ? `${raw.slice(0, 12)}…` : raw;
  })();

  return (
    <View style={styles.footerStatGrid}>
      <View style={styles.footerStatCell}>
        <Text style={styles.footerStatValue} numberOfLines={1}>{sumDisplay}</Text>
        <Text style={styles.footerStatLabel}>{t('summary.footerStatSum')}</Text>
      </View>
      <View style={styles.footerStatDivider} />
      <View style={styles.footerStatCell}>
        <Text style={styles.footerStatValue} numberOfLines={1}>{timeDisplay}</Text>
        <Text style={styles.footerStatLabel}>{t('summary.footerStatTime')}</Text>
      </View>
      <View style={styles.footerStatDivider} />
      <View style={styles.footerStatCell}>
        <Text style={styles.footerStatValue} numberOfLines={1}>{receiptDisplay}</Text>
        <Text style={styles.footerStatLabel}>{t('summary.footerStatReceiptNo')}</Text>
      </View>
    </View>
  );
}

interface RegionPreviewProps {
  pages: PageMeta[];
  region: Region;
  cardWidth: number;
}

function RegionPreview({ pages, region, cardWidth }: RegionPreviewProps) {
  if (region.yBottom <= region.yTop) return null;
  if (pages.length === 0) return null;

  // Pick the page that contains region.yTop; fall back to last page if beyond range.
  let pageIdx = 0;
  let page: PageMeta = pages[0];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (
      region.yTop >= p.yOffsetScaled &&
      region.yTop < p.yOffsetScaled + p.pageMaxYScaled + 50
    ) {
      page = p;
      pageIdx = i;
      break;
    }
    page = p;
    pageIdx = i;
  }

  // region.yTop and page.receiptXLeftScaled are ALREADY in image-pixel space
  // (scaleY was applied at OCR time), so no further division by frameScale.
  const localYPixelTop = region.yTop - page.yOffsetScaled;
  const localYPixelBottom = Math.min(
    region.yBottom - page.yOffsetScaled,
    page.pageMaxYScaled,
  );

  console.log(
    `[RegionPreview] region yTop=${Math.round(region.yTop)} yBot=${Math.round(region.yBottom)} -> page ${pageIdx + 1}/${pages.length} (yOffset=${Math.round(page.yOffsetScaled)}, maxY=${Math.round(page.pageMaxYScaled)}, pxH=${page.pixelHeight}), localY=[${Math.round(localYPixelTop)}..${Math.round(localYPixelBottom)}]`,
  );

  // Horizontal viewport = receipt text bounds (skips A4 whitespace on PDF receipts).
  const pad = 20;
  const receiptLeftPx = Math.max(0, page.receiptXLeftScaled - pad);
  const receiptRightPx = Math.min(
    page.pixelWidth,
    page.receiptXRightScaled + pad,
  );
  const viewWidthPx = Math.max(1, receiptRightPx - receiptLeftPx);
  const scale = cardWidth / viewWidthPx;
  const regionHeightPx = Math.max(1, localYPixelBottom - localYPixelTop);

  return (
    <View
      style={{
        width: cardWidth,
        height: regionHeightPx * scale,
        overflow: "hidden",
        borderRadius: 6,
      }}
    >
      <Image
        source={{ uri: page.uri }}
        style={{
          width: page.pixelWidth * scale,
          height: page.pixelHeight * scale,
          marginLeft: -receiptLeftPx * scale,
          marginTop: -localYPixelTop * scale,
        }}
        resizeMode="cover"
      />
    </View>
  );
}

/**
 * Build the parsedData payload sent to the backend.
 * Mirrors the shape agreed on in receiptSaveService.ts on the API side.
 */
/**
 * Render a per-line quantity label that covers the three cases:
 *  - Weighable (unit=kg): `0,236 kg × 12,94 €/kg`
 *  - Multi-buy (quantity > 1, unit=vnt): `2 vnt. × 1,09 €`
 *  - Single unit with a known SP amount: `300 g`
 *  - Single unit otherwise: `1 vnt.`
 *
 * Uses European decimal comma for consistency with the rest of the UI.
 */
function anyIssueChecked(flags: {
  name: boolean;
  price: boolean;
  amount: boolean;
  discount: boolean;
  image: boolean;
}): boolean {
  return flags.name || flags.price || flags.amount || flags.discount || flags.image;
}

function formatAmountLabel(p: ProductLine): string {
  const fmt = (n: number, digits: number) => n.toFixed(digits).replace(".", ",");
  const unit = (p.unit ?? "vnt").toLowerCase();
  const perUnit = p.pricePerUnit ?? p.price;

  if (unit === "kg") {
    return `${fmt(p.quantity, 3)} kg × ${fmt(perUnit, 2)} €/kg`;
  }
  if (p.quantity > 1) {
    return `${p.quantity} ${unit}. × ${fmt(perUnit, 2)} €`;
  }
  // quantity === 1 — try to show the matched SP's own amount label.
  const matchedSp = p.altMatches?.find(
    (a) => a.storeProductId === p.storeProductId,
  );
  if (matchedSp?.amount && matchedSp.unit) {
    return `${fmt(Number(matchedSp.amount), Number(matchedSp.amount) >= 10 ? 0 : 2)} ${matchedSp.unit}`;
  }
  return "1 vnt.";
}

function buildParsedData(
  header: HeaderData,
  products: ProductLine[],
  footer: FooterData,
  imageMeta: { uri: string | null; width: number; height: number } | null,
  imageFilePath: string | null,
  maskBands: MaskBand[] = [],
  wordsDump?: unknown,
): object {
  // Strip bank/loyalty card numbers + cashier name from everything that gets
  // persisted, so the DB never holds them (the image is redacted separately
  // before upload). Only the free-text carriers need it — structured fields
  // (receiptNo/date/total/storeAddress) are never sensitive.
  // SLIM the persisted blob (see receipt rawData slimming): drop transient/duplicate
  // fields + big image URLs. matchLoading = transient UI state; footer.rawText/region =
  // byte-identical duplicates of header.*; image URLs are re-fetchable by storeProductId.
  // Old receipts keep the fat shape — every reader stays backward-compatible.
  const { matchLoading: _matchLoading, ...slimHeader } = header;
  const { rawText: _footerRawText, region: _footerRegion, ...slimFooter } = footer;
  // Never persist image:null when we have geometry. Losing the OCR coordinate-
  // space dims forces the reopen path into a decoder-sampled re-measure that
  // drifts every band + mask; fall back to the region/word extents so the space
  // is always recoverable.
  const imgDims = imageMeta ?? deriveImageDimsFromGeometry({ header, products, footer, maskBands, wordsDump });
  return {
    version: 1,
    image: imgDims
      ? {
          filePath: imageFilePath,
          width: imgDims.width,
          height: imgDims.height,
        }
      : null,
    header: { ...slimHeader, rawText: redactReceiptText(header.rawText) },
    products: products.map((p) => ({
      ...p,
      rawLines: Array.isArray(p.rawLines) ? p.rawLines.map(redactReceiptText) : p.rawLines,
      // Drop the big image URLs from altMatches (never rendered — only altMatches[0]'s
      // category is read; the displayed thumbnail uses storeProductImageUrl, kept). This
      // is the bulk of the per-receipt bytes: ~3 dup/alt URLs × every product.
      altMatches: Array.isArray(p.altMatches)
        ? p.altMatches.map(({ imageUrl: _ai, ...am }) => am)
        : p.altMatches,
    })),
    footer: slimFooter, // rawText + region dropped (header is the single source of truth)
    // Geometry-only redaction boxes (no card digits) so the Kvitas-tab
    // overlay can re-draw the black "private info" bands on reload.
    maskBands: maskBands.map((b) => ({
      yTop: b.yTop, yBottom: b.yBottom, xLeft: b.xLeft, xRight: b.xRight, kind: b.kind,
      // Keep the per-corner Y (skew) so the reload overlay can bend the black band
      // along the tilted PII row instead of drawing a flat rectangle.
      yLeftTop: b.yLeftTop, yRightTop: b.yRightTop,
      yLeftBottom: b.yLeftBottom, yRightBottom: b.yRightBottom,
      // PII text extent — so a re-clamp on reload still can't trim the band into the card number.
      piiTop: b.piiTop, piiBottom: b.piiBottom,
    })),
    // Per-word OCR capture (staging+prod now, PII redacted at the build site). Top-level
    // so it survives the header-state round-trip. Repro a bad scan with wordsToFixture.mjs.
    ...(wordsDump ? { wordsDump } : {}),
  };
}

export default function ProcessReceiptScreen() {
  const { t } = useTranslation();
  const { uri, uris: urisParam, receiptId: receiptIdParam, preview: previewParam, shoppingListId: shoppingListIdParam, expectedChainId: expectedChainIdParam, listMap: listMapParam, reocrReceiptId: reocrReceiptIdParam } = useLocalSearchParams<{
    uri?: string;
    uris?: string;
    receiptId?: string;
    preview?: string;
    /** DEV re-OCR: this is a fresh-scan run of an EXISTING receipt's stored photo.
     *  The old receipt is deleted just before the new one is POSTed (so a re-parse
     *  that bails to retake doesn't destroy it, and the create isn't a dedup 409). */
    reocrReceiptId?: string;
    /** Single-store list upload: the list row to link the Receipt to. */
    shoppingListId?: string;
    /** Single-store: the list's chain — gate the scan against it. */
    expectedChainId?: string;
    /** Multi-store GROUP upload: `chainId:listId,chainId:listId` for the
     *  group's awaiting stores. The receipt's detected chain auto-selects
     *  which store row to link — no store-selection prompt. */
    listMap?: string;
  }>();
  const expectedChainIdNum = expectedChainIdParam ? Number(expectedChainIdParam) : null;
  // Unified chainId→listId map for the list-upload flow: from the group
  // `listMap`, else the single shoppingListId+expectedChainId pair.
  const linkMap = useMemo<Record<number, number>>(() => {
    if (listMapParam) {
      const m: Record<number, number> = {};
      for (const pair of listMapParam.split(',')) {
        const [c, l] = pair.split(':').map(Number);
        if (Number.isFinite(c) && Number.isFinite(l)) m[c] = l;
      }
      return m;
    }
    if (shoppingListIdParam && expectedChainIdNum != null) {
      return { [expectedChainIdNum]: Number(shoppingListIdParam) };
    }
    return {};
  }, [listMapParam, shoppingListIdParam, expectedChainIdNum]);
  // Single-store with no known chain → nothing to gate; link unconditionally.
  const fallbackLinkId = (!listMapParam && shoppingListIdParam && expectedChainIdNum == null)
    ? Number(shoppingListIdParam) : null;
  const existingReceiptId = receiptIdParam ? Number(receiptIdParam) : null;
  const isExistingMode = Number.isFinite(existingReceiptId);
  // DEV re-OCR: fresh-scan run over an existing receipt's stored photo. Not "existing
  // mode" (we WANT the full scan+POST pipeline) — just the id to retire on save.
  const reocrReceiptId = reocrReceiptIdParam ? Number(reocrReceiptIdParam) : null;

  // `uris` (comma-separated) is used for multi-page PDF receipts where each
  // page is OCR'd separately; `uri` stays for the single-image cases.
  const imageUriList = useMemo<string[]>(() => {
    if (urisParam) {
      return urisParam
        .split(",")
        .map((u) => decodeURIComponent(u.trim()))
        .filter((u) => u.length > 0);
    }
    if (uri) return [decodeURIComponent(uri)];
    return [];
  }, [uri, urisParam]);
  // Preview mode: OCR + parsing populate the UI, but nothing is POSTed to
  // the API. No receiptId ever set, no MinIO upload, no comparison fetch.
  // Used for iterating on parser accuracy without cluttering the database.
  const isPreviewMode = previewParam === "true";
  const router = useRouter();
  const navigation = useNavigation();
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [loading, setLoading] = useState(true);
  // Honest OCR/processing sub-step shown under the silly ProcessingLoader headline.
  // Empty initially (the rotating headline carries the load); the OCR pipeline sets it.
  const [loadingMessage, setLoadingMessage] = useState("");
  // Chain-match gate (list-upload flow): when the scanned receipt's chain
  // doesn't match the list's store, processReceipt parks here and awaits the
  // user's decision via chainGateResolveRef (proceed = "different store", or
  // back out). null when no mismatch.
  const [chainGate, setChainGate] = useState<{ detectedChainId: number; expectedChainIds: number[] } | null>(null);
  const chainGateResolveRef = useRef<((proceed: boolean) => void) | null>(null);
  // Manual date-entry gate: shown only when the receipt is otherwise readable
  // (has receiptNo + time) but its DATE was unreadable (e.g. an ink stain). The
  // user picks the date printed on the receipt; capped at today so it can never
  // land a future-dated price (which would pin a wrong "latest" price).
  const [dateGate, setDateGate] = useState(false);
  // Store-resolution shown as an on-top modal (was the separate /receipt/store-resolution
  // route). The OCR pipeline awaits the storeResolution handoff promise; this just toggles
  // the modal's visibility.
  const [storeGate, setStoreGate] = useState(false);
  // Resolves once the store-resolution map's dismiss animation finishes (Modal.onDismiss,
  // iOS), so a following modal never presents on top of the still-animating map.
  const storeGateDismissRef = useRef<(() => void) | null>(null);
  // Mandatory swipes are hosted IN-PLACE as a phase of this screen (was the
  // /swipe/queue route bounce + swipeDone round-trip). `swiping` flips the whole
  // screen to <SwipeQueue>; `postSwipeActionRef` holds the continuation to run
  // when the session completes (fetch comparison for a fresh scan, or re-load the
  // receipt in existing mode). No route, no swipeDone param, no redirect guard.
  const [swiping, setSwiping] = useState(false);
  const [swipingReceiptId, setSwipingReceiptId] = useState<number | null>(null);
  const postSwipeActionRef = useRef<(() => void) | null>(null);
  const dateGateResolveRef = useRef<((picked: Date | null) => void) | null>(null);
  const [dateGateTemp, setDateGateTemp] = useState<Date | null>(null); // null = empty field (no prefill)
  const [dateGateShowPicker, setDateGateShowPicker] = useState(false);
  // Souply-styled failure modal (replaces the stock OS Alert). Holds the
  // user-facing message; buttons Try-again (re-open scanner) / Close.
  const [failGate, setFailGate] = useState<string | null>(null);
  // Resolved list row to link the receipt to (auto-selected by detected
  // chain for groups; the single list for single-store). Set in processReceipt.
  const linkListIdRef = useRef<number | null>(null);
  // Per-product match progress. When non-null, loading overlay shows
  // an "N / M" counter alongside the message so the user sees the
  // phone is actively working through the product list. Reset to null
  // once matching completes (or on bail).
  const [matchProgress, setMatchProgress] = useState<
    { done: number; total: number } | null
  >(null);
  const isHydratingRef = useRef(false);
  // NOTE: product-match fetches deliberately carry NO component-scoped abort signal.
  // A previous `mountAbortRef` aborted them on unmount to spare the server ~30 in-flight
  // fetches when the user backed out — but a spurious/transient abort of that signal
  // (dev Fast Refresh, a remount race) emptied every line's altMatches, so the receipt
  // POSTed with zero matches and the server (which does no fuzzy matching of its own)
  // persisted it as genuinely unmatched with 0 swipe candidates (receipt 222). The per-call
  // `timeoutMs` already bounds a stuck fetch; on a genuine back-out the receipt is never
  // POSTed anyway (the POST effect is gated on `footer`, which never gets set). So we let
  // the match fetches run to completion rather than risk stranding a matchable receipt.
  const [header, setHeader] = useState<HeaderData | null>(null);
  const [products, setProducts] = useState<ProductLine[]>([]);
  const [footer, setFooter] = useState<FooterData | null>(null);
  // Coupon/bag/points bands (IKI photographed) — shown grey in the photo view,
  // never counted as products. Reset per scan; only the IKI path populates it.
  const [skippedRegions, setSkippedRegions] = useState<LabeledRegion[]>([]);
  const [editingSection, setEditingSection] = useState<
    "header" | "footer" | number | null
  >(null);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageDims, setImageDims] = useState<{
    width: number;
    height: number;
  } | null>(null);
  // The OCR-space dims LOADED from the persisted blob, stashed SYNCHRONOUSLY at parse
  // time (before any effect can run). buildParsedData uses this as the fallback when
  // `imageDims` state is momentarily null — the ROOT CAUSE of the band-drift class:
  // a focus-return autosave firing inside loadExistingReceipt's null-dims window used
  // to fall through to deriveImageDimsFromGeometry (maxGeometry+24, a systematic
  // UNDERESTIMATE) and PERSIST those fabricated dims; the next open then squashed the
  // image to fit them while every band stayed in true OCR space → the progressive
  // downward drift (receipt-230: stored 914x3402 vs real 925x3699 = ×1.087 in y).
  // deriveImageDimsFromGeometry must only ever apply to TRUE legacy image:null blobs.
  const loadedImageDimsRef = useRef<{ width: number; height: number } | null>(null);
  // True while a SAVED receipt's photo is being fetched from MinIO (download +
  // re-project into OCR space) in loadExistingReceipt's background block. Lets the
  // Kvitas-tab photo view show a skeleton instead of flashing the "photo not
  // available" fallback — which renders whenever imageUri/imageDims are null,
  // indistinguishable from "still loading". Fresh scans never set it (their image
  // is local + ready before the detail renders).
  const [imageLoading, setImageLoading] = useState(false);
  // Per-page metadata for RegionPreview (multi-page PDFs + horizontal
  // receipt-area crop to skip A4 whitespace).
  const [pageMetas, setPageMetas] = useState<PageMeta[]>([]);
  // Bank/loyalty/cashier redaction boxes (image-pixel space) for the
  // pre-upload image masking (P3b). Computed in processReceipt. The actual
  // compositing is delegated to the global <MaskRedactionHost> (runUpload),
  // so this screen no longer hosts its own ViewShot.
  const [maskBands, setMaskBands] = useState<MaskBand[]>([]);
  // Privacy masks, clamped so they never cover a recognised data band (product /
  // header / footer line) — e.g. the cashier mask creeping over "Kvito Nr.".
  // Used everywhere masks are consumed (render, burn-into-image, persist) so the
  // stored image and the dev overlay agree.
  const maskBandsClamped = useMemo(() => {
    const protectedRegions = [
      ...(header?.lineRegions ?? []),
      ...(footer?.lineRegions ?? []),
      ...products.map((p) => p.region).filter(Boolean),
    ];
    return clampMaskBandsToProtected(maskBands, protectedRegions as any);
  }, [maskBands, header, footer, products]);
  const { pendingPick, clearPendingPick } = useReceiptPickerState();
  const setCreateContext = useReceiptCreateContext((s) => s.setContext);
  // productsExpanded removed — Prekės is now its own tab (C2 absorbed
  // the chevron expand/collapse UI). Tab navigation does what the
  // toggle used to.
  // Save state
  const [receiptId, setReceiptId] = useState<number | null>(null);
  const [imageFilePath, setImageFilePath] = useState<string | null>(null);
  // How many swipe cards are currently waiting for this user on this receipt.
  // Fetched on mount and whenever the screen refocuses (so it updates after
  // the user returns from the swipe screen). `swipeQueueFetched` toggles
  // true after the first successful read, so the swipe-entry card can
  // render optimistically before the (2 s-delayed) fetch lands without
  // flashing empty in the meantime — see the card render block.
  const [swipeQueueCount, setSwipeQueueCount] = useState<number>(0);
  const [swipeQueueFetched, setSwipeQueueFetched] = useState<boolean>(false);
  // Per-row three-dots menu state. null = closed.
  const [menuOpenForIndex, setMenuOpenForIndex] = useState<number | null>(null);
  // Issue-report modal (opened from the three-dots menu).
  const [issueModalForIndex, setIssueModalForIndex] = useState<number | null>(null);
  const [issueFlags, setIssueFlags] = useState({
    name: false,
    price: false,
    amount: false,
    discount: false,
    image: false,
  });
  const [postStatus, setPostStatus] = useState<AsyncStatus>("idle");
  const [postErr, setPostErr] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<AsyncStatus>("idle");
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [comparisonStatus, setComparisonStatus] = useState<AsyncStatus>("idle");
  const [firstCompleteReached, setFirstCompleteReached] = useState(false);
  const { comparison, comparisonLoading, comparisonError, fetchComparison, setComparison } =
    useReceiptComparison();

  // Derive comparisonStatus from the hook
  useEffect(() => {
    if (comparisonLoading) setComparisonStatus("pending");
    else if (comparisonError) setComparisonStatus("error");
    else if (comparison) setComparisonStatus("done");
  }, [comparisonLoading, comparisonError, comparison]);

  // Flip to true once the comparison has loaded for the first time after a
  // fresh scan / receipt open. Subsequent refetches (on edits) won't re-block.
  useEffect(() => {
    if (comparison && !firstCompleteReached) {
      setFirstCompleteReached(true);
    }
  }, [comparison, firstCompleteReached]);
  const rematchSpinnerTimersRef = useRef<
    Record<number, ReturnType<typeof setTimeout> | null>
  >({});
  const rematchRunTimersRef = useRef<
    Record<number, ReturnType<typeof setTimeout> | null>
  >({});
  const rematchRequestSeqRef = useRef<Record<number, number>>({});
  const [rematchLoadingByIndex, setRematchLoadingByIndex] = useState<
    Record<number, boolean>
  >({});
  const comparisonKeyRef = useRef("");
  const shouldRefreshComparisonRef = useRef(false);
  const isFullyRecognized = (p: ProductLine) => p.matchConfirmed;
  // In production, product rows are flat — there's nothing useful to show
  // in the expanded drawer. The three-dots menu handles issue reporting and
  // photo upload; the swipe flow handles OCR-name correction. Expand is
  // only live under DEV_MODE so we can still inspect region previews.
  const canExpandProduct = (_p: ProductLine) => DEV_MODE;

  const buildComparisonKey = (h: HeaderData | null, items: ProductLine[]) =>
    JSON.stringify({
      chainId: h?.chainId ?? null,
      storeId: h?.storeId ?? null,
      items: items.map((p) => ({
        storeProductId: p.storeProductId ?? null,
        price: Number(p.price ?? 0),
        promoPrice: p.promoPrice ?? null,
        quantity: Number(p.quantity ?? 1),
      })),
    });
  const isCompletelyUnrecognized = (p: ProductLine) =>
    !p.matchConfirmed && !p.storeProductId && p.altMatches.length === 0;

  // "Messed up" = the parser missed a HARD field: the NAME (a stray "?" phantom — no
  // letters at all) or the PRICE (anything that would render "0,00 EUR" — price <= 0).
  // Only these two genuinely-broken cases are hidden from the Items list on PRODUCTION
  // — NOT a merely-uncertain match. A clean line whose match is only moderate (low
  // confidence band) is still a real, useful product row and stays visible. Weighable
  // (kg) items are NOT exempt: an unrecoverable €/kg shows "0,00" and is dropped on prod
  // like any other priceless line (the "never write price" server guard is separate and
  // unaffected). On dev/staging the dropped lines still render with a "would be hidden on
  // production" marker.
  const isMessedUp = (p: ProductLine) => {
    const noName = !/[a-ząčęėįšųūž]/i.test(p.name ?? "");
    const noPrice = !(p.price != null && p.price > 0);
    return noName || noPrice;
  };

  const clearRematchTimers = (index: number) => {
    const spinnerTimer = rematchSpinnerTimersRef.current[index];
    if (spinnerTimer) clearTimeout(spinnerTimer);
    rematchSpinnerTimersRef.current[index] = null;

    const runTimer = rematchRunTimersRef.current[index];
    if (runTimer) clearTimeout(runTimer);
    rematchRunTimersRef.current[index] = null;
  };
  useEffect(() => {
    if (typeof editingSection !== "number") return;
    const p = products[editingSection];
    if (!p) return;
    if (!canExpandProduct(p)) {
      setEditingSection(null);
    }
  }, [products, editingSection]);
  const rematchProductByName = async (
    index: number,
    newName: string,
    seq: number,
  ) => {
    const chainId = header?.chainId ?? 2;
    if (!newName.trim() || !chainId) return;

    try {
      const params = new URLSearchParams({
        chainId: String(chainId),
        name: newName.trim(),
      });
      const res = await fetchWithTimeout(
        `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
        { timeoutMs: TIMEOUT_FAST_MS },
      );
      const data = await res.json();
      const matches: ProductMatchOption[] = Array.isArray(data?.matches)
        ? data.matches
        : [];
      const top = matches[0] || null;

      if (rematchRequestSeqRef.current[index] !== seq) return;

      setProducts((prev) => {
        if (index < 0 || index >= prev.length) return prev;
        const updated = [...prev];
        updated[index] = {
          ...updated[index],
          matchedName: top?.name ?? null,
          storeProductId: top?.storeProductId ?? null,
          storeProductImageUrl: top?.imageUrl ?? null,
          matchConfidence: top?.confidence ?? null,
          matchConfirmed: false,
          altMatches: matches,
          // Explicit-manual-match marker: the server's autosave merge applies match
          // fields ONLY for lines carrying this, so a stale (un-edited) line can
          // never re-adjudicate a match the server changed (votes, rejects, Round-2).
          manualMatch: true,
        };
        return updated;
      });
    } catch (e) {
      console.warn("Manual rematch failed:", e);
    } finally {
      if (rematchRequestSeqRef.current[index] === seq) {
        setRematchLoadingByIndex((prev) => ({ ...prev, [index]: false }));
      }
    }
  };

  const scheduleManualRematch = (index: number, value: string) => {
    clearRematchTimers(index);
    setRematchLoadingByIndex((prev) => ({ ...prev, [index]: false }));

    const trimmed = value.trim();
    if (!trimmed) return;

    const seq = (rematchRequestSeqRef.current[index] ?? 0) + 1;
    rematchRequestSeqRef.current[index] = seq;

    // 1s after user stops typing -> show spinner
    rematchSpinnerTimersRef.current[index] = setTimeout(() => {
      if (rematchRequestSeqRef.current[index] !== seq) return;
      setRematchLoadingByIndex((prev) => ({ ...prev, [index]: true }));
    }, 1000);

    // +2s more (total 3s from last keypress) -> run current matching flow
    rematchRunTimersRef.current[index] = setTimeout(() => {
      if (rematchRequestSeqRef.current[index] !== seq) return;
      setRematchLoadingByIndex((prev) => ({ ...prev, [index]: true }));
      rematchProductByName(index, value, seq);
    }, 3000);
  };

  useEffect(() => {
    return () => {
      Object.values(rematchSpinnerTimersRef.current).forEach(
        (t) => t && clearTimeout(t),
      );
      Object.values(rematchRunTimersRef.current).forEach(
        (t) => t && clearTimeout(t),
      );
    };
  }, []);

  // Enter the in-place mandatory-swipe phase. `after` is the continuation to run
  // when the session finishes (or the user backs out) — typically fetch the price
  // comparison (fresh scan) or re-load the receipt detail (existing mode).
  const enterSwipePhase = (id: number, after: () => void) => {
    postSwipeActionRef.current = after;
    setSwipingReceiptId(id);
    setSwiping(true);
  };

  // Leave the swipe phase and run whatever continuation was queued. Used by both
  // <SwipeQueue>'s onAllDone (session complete) and onExit (user bailed).
  const leaveSwipePhase = () => {
    const after = postSwipeActionRef.current;
    postSwipeActionRef.current = null;
    setSwiping(false);
    after?.();
  };

  const loadExistingReceipt = async (id: number) => {
    try {
      setLoading(true);
      isHydratingRef.current = true;
      setLoadingMessage(t('receiptProcess.loading'));
      // WARM reopen: this screen instance can be reused with imageDims/imageUri still
      // holding a PREVIOUS image (after a fresh scan, or a cached nav stack). The mask
      // overlay scales by imageDims, but setImageDims only fires later in the async
      // block below — so a stale imageDims would project THIS receipt's masks at the
      // wrong scale for ~100-300 ms (the stray black band mid-receipt the user saw).
      // Null the image state up-front so ReceiptPhotoView gates to its fallback until
      // the async sets the correct, current dims — i.e. behave like a cold start.
      setImageDims(null);
      loadedImageDimsRef.current = null; // previous receipt's dims must never leak into a save
      setImageUri(null);
      setPageMetas([]);
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/receipts/${id}`, {
        timeoutMs: TIMEOUT_STANDARD_MS,
      });
      const receipt = await res.json();

      // If the receipt still has pending mandatory swipes, host the swipe phase
      // in-place. When the session finishes we re-load THIS receipt — now with the
      // swipes completed server-side, so pendingSwipes is false and we fall through
      // to render the detail + comparison.
      const pendingSwipes =
        (receipt.mandatorySwipesRequired ?? 0) > 0 &&
        (receipt.mandatorySwipesCompleted ?? 0) < (receipt.mandatorySwipesRequired ?? 0);
      if (pendingSwipes) {
        setLoading(false);
        enterSwipePhase(id, () => loadExistingReceipt(id));
        return;
      }

      const parsed =
        typeof receipt.parsedData === "string"
          ? JSON.parse(receipt.parsedData)
          : receipt.parsedData;

      // Graceful bail: old receipts may have null/partial parsedData
      // (rows created before parsedData was consistently populated,
      // or orphans from mid-save crashes). Don't throw — return the
      // user to the Analize tab so the app stays usable, and leave a
      // console breadcrumb pointing at the bad row for manual cleanup.
      if (
        !parsed?.header ||
        !parsed?.footer ||
        !Array.isArray(parsed?.products)
      ) {
        console.warn(
          `[loadExistingReceipt] receipt id=${id} has malformed parsedData — bailing`,
          {
            hasHeader: !!parsed?.header,
            hasFooter: !!parsed?.footer,
            productsType: Array.isArray(parsed?.products)
              ? "array"
              : typeof parsed?.products,
          },
        );
        setLoading(false);
        isHydratingRef.current = false;
        useProfileStore.getState().invalidate();
        router.replace("/(tabs)/receipts");
        setTimeout(() => {
          Alert.alert(
            t('receiptProcess.savedFailTitle'),
            t('receiptProcess.savedFail'),
          );
        }, 100);
        return;
      }

      // Restore the per-word capture from the loaded blob so a re-save on THIS mount
      // (where processReceipt never ran) preserves it instead of clobbering with -1.
      wordsDumpRef.current = (parsed as any).wordsDump;
      wordsSrcRef.current = "load";

      // Restore the OCR coordinate-space dims SYNCHRONOUSLY — same tick as setProducts,
      // BEFORE any focus/autosave effect can build a save snapshot. The async image
      // block below re-applies the identical values later (applyDims); this early set
      // exists so the null-dims window can never fabricate geometry-derived dims into
      // a persisted blob again (the band-drift root cause). Correct-by-construction for
      // the stale-mask concern: these are THIS receipt's own dims, and the photo overlay
      // stays gated on imageUri until the download lands.
      {
        const w = Number(parsed?.image?.width);
        const h = Number(parsed?.image?.height);
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
          loadedImageDimsRef.current = { width: w, height: h };
          setImageDims({ width: w, height: h });
        } else {
          loadedImageDimsRef.current = null; // true legacy blob — derive stays allowed
        }
      }

      setHeader({
        chainName:
          parsed.header.chainName ?? receipt.chainName ?? t('receiptProcess.fallbackChain'),
        chainId: parsed.header.chainId ?? null,
        storeCode: parsed.header.storeCode ?? "",
        storeAddress: parsed.header.storeAddress ?? "",
        storeId: parsed.header.storeId ?? receipt.storeId ?? null,
        storeName: parsed.header.storeName ?? null,
        storeAddressMatched: parsed.header.storeAddressMatched ?? null,
        matchConfidence: parsed.header.matchConfidence ?? null,
        matchLoading: false,
        rawText: parsed.header.rawText ?? "",
        region: parsed.header.region ?? {
          yTop: 0,
          yBottom: 0,
          xLeft: 0,
          xRight: 0,
        },
        lineRegions: Array.isArray(parsed.header.lineRegions)
          ? parsed.header.lineRegions
          : undefined,
        regionsVersion:
          typeof parsed.header.regionsVersion === "string"
            ? parsed.header.regionsVersion
            : undefined,
      });

      setProducts(
        parsed.products.map((p: any) => ({
          name: p.name ?? "",
          matchedName: p.matchedName ?? null,
          storeProductId: p.storeProductId ?? null,
          storeProductImageUrl: p.storeProductImageUrl ?? null,
          matchConfidence:
            typeof p.matchConfidence === "number" ? p.matchConfidence : null,
          matchConfirmed: !!p.matchConfirmed,
          priceVerified: !!p.priceVerified,
          pendingReverification: !!p.pendingReverification,
          altMatches: Array.isArray(p.altMatches) ? p.altMatches : [],
          price: Number(p.price ?? 0),
          promoPrice: p.promoPrice == null ? null : Number(p.promoPrice),
          quantity: Number(p.quantity ?? 1),
          unit: p.unit ?? "",
          amount: p.amount != null ? Number(p.amount) : null,
          sizeUnit: p.sizeUnit ?? null,
          pricePerUnit: p.pricePerUnit == null ? null : Number(p.pricePerUnit),
          rawLines: Array.isArray(p.rawLines) ? p.rawLines : [],
          region: p.region ?? { yTop: 0, yBottom: 0, xLeft: 0, xRight: 0 },
          itemConfidence:
            p.itemConfidence && typeof p.itemConfidence.band === "string"
              ? (p.itemConfidence as ItemConfidence)
              : null,
          categoryId: p.categoryId ?? null,
          categoryName: p.categoryName ?? null,
          categoryL2Name: p.categoryL2Name ?? null,
        })),
      );

      setFooter({
        total: parsed.footer.total ?? null,
        date: parsed.footer.date ?? "",
        time: parsed.footer.time ?? "",
        receiptNo: parsed.footer.receiptNo ?? receipt.receiptNo ?? "",
        totalSavings: parsed.footer.totalSavings ?? null,
        comboDiscount: parsed.footer.comboDiscount ?? null,
        // footer.rawText/region were deduped out of new blobs → fall back to header's copy.
        rawText: parsed.footer.rawText ?? parsed.header?.rawText ?? "",
        region: parsed.footer.region ?? parsed.header?.region ?? {
          yTop: 0,
          yBottom: 0,
          xLeft: 0,
          xRight: 0,
        },
        lineRegions: Array.isArray(parsed.footer.lineRegions)
          ? parsed.footer.lineRegions
          : undefined,
      });

      // Reload persisted redaction boxes (geometry only) so the Kvitas-tab
      // overlay re-draws the black "private info" bands on an existing receipt.
      const loadedMasks: MaskBand[] = Array.isArray(parsed.maskBands)
        ? parsed.maskBands.map((b: any) => ({
            yTop: Number(b.yTop) || 0,
            yBottom: Number(b.yBottom) || 0,
            xLeft: Number(b.xLeft) || 0,
            xRight: Number(b.xRight) || 0,
            // Restore per-corner skew (older receipts without it fall back to flat).
            yLeftTop: b.yLeftTop != null ? Number(b.yLeftTop) : undefined,
            yRightTop: b.yRightTop != null ? Number(b.yRightTop) : undefined,
            yLeftBottom: b.yLeftBottom != null ? Number(b.yLeftBottom) : undefined,
            yRightBottom: b.yRightBottom != null ? Number(b.yRightBottom) : undefined,
            piiTop: b.piiTop != null ? Number(b.piiTop) : undefined,
            piiBottom: b.piiBottom != null ? Number(b.piiBottom) : undefined,
            kind: b.kind,
            label: '',
            reasons: [],
            text: '',
          }))
        : [];
      setMaskBands(loadedMasks);

      setReceiptId(id);
      hasPostedRef.current = true;

      if (parsed?.image?.filePath) {
        setImageFilePath(parsed.image.filePath);
      } else if (parsed?.image && parsed.image.filePath === "") {
        // Orphan case: Receipt row was POSTed but the MinIO PUT or
        // follow-up PATCH failed. filePath saved as empty string
        // (vs null for "intentionally no image"). The original local
        // file is gone (different app session), so there's nothing
        // to silently retry — surface an error badge and let the
        // user know the image is missing.
        setUploadStatus("error");
        setUploadErr(t('receiptProcess.imageMissing'));
      }
      // Image URL and comparison are independent of the receipt data already
      // loaded above — fire both in the background so the loading spinner
      // drops as soon as the receipt content is ready (~300 ms instead of
      // waiting for the full comparison round-trip).
      // Gate the photo view on imageLoading until this whole fetch→download→
      // re-project settles, so it shows a skeleton instead of the "not available"
      // fallback (cleared in finally for every exit: success, no-image, or error).
      setImageLoading(true);
      void (async () => {
        try {
          const imageRes = await fetch(
            `${API_BASE_URL}/api/receipts/${id}/image`,
          );
          const imageData = await imageRes.json();

          if (imageData?.url) {
            setImageUri(imageData.url);

            // `<Image>` is happy with the remote URL, but
            // ImageManipulator.manipulateAsync (used by BandCropImage)
            // requires a LOCAL file URI per its docs — passing the
            // HTTPS MinIO URL trips a native crash with the cryptic
            // "calling the 'renderAsync' function has failed". Cache
            // the image to the local FS once, then point pageMetas
            // at the local path so every band crop runs against a
            // file:// URI.
            let localUri = imageData.url as string;
            try {
              const cacheDir = FileSystem.cacheDirectory ?? '';
              const dest = `${cacheDir}receipt-${id}.jpg`;
              devLog('loadExistingReceipt.downloadStart', { id, src: imageData.url, dest });
              const dl = await FileSystem.downloadAsync(imageData.url, dest);
              const dlSummary = {
                id,
                uri: dl?.uri,
                status: dl?.status,
                size: dl?.headers?.['Content-Length'] ?? dl?.headers?.['content-length'],
              };
              devLog('loadExistingReceipt.downloadResult', dlSummary);
              if (dl?.uri && dl?.status === 200) {
                localUri = dl.uri;
                try {
                  const info = await FileSystem.getInfoAsync(dl.uri);
                  devLog('loadExistingReceipt.fileInfo', { id, exists: info.exists, size: (info as any).size, uri: info.uri });
                } catch (infoErr: any) {
                  devLog('loadExistingReceipt.fileInfoError', { id, err: infoErr?.message ?? String(infoErr) });
                }
              } else {
                devLog('loadExistingReceipt.downloadNon200', dlSummary);
              }
            } catch (e: any) {
              devLog('loadExistingReceipt.downloadThrew', { id, err: e?.message ?? String(e) });
            }
            devLog('loadExistingReceipt.localUri', { id, localUri });

            let parsedWidth = Number(parsed?.image?.width);
            let parsedHeight = Number(parsed?.image?.height);
            let hasParsedDims =
              Number.isFinite(parsedWidth) && Number.isFinite(parsedHeight) &&
              parsedWidth > 0 && parsedHeight > 0;
            if (!hasParsedDims) {
              // Legacy receipt saved with image:null — the OCR coordinate space
              // wasn't persisted. Reconstruct it from the stored region/word
              // extents so every band scales by a STABLE factor, instead of the
              // decoder-sampled re-measure below (which drifts and shifts on each
              // reopen).
              const derived = deriveImageDimsFromGeometry(parsed);
              if (derived) {
                parsedWidth = derived.width;
                parsedHeight = derived.height;
                hasParsedDims = true;
                devLog('loadExistingReceipt.derivedDims', { id, derived });
              }
            }

            // Re-project the stored image into the parsed (portrait/OCR) coordinate
            // space so bands and per-band crops line up. ROTATE the stored landscape
            // to portrait (the space ALL regions live in); a portrait stored image
            // is returned unchanged.
            const norm = await normalizeLoadedImage(
              localUri,
              hasParsedDims ? parsedWidth : 0,
              hasParsedDims ? parsedHeight : 0,
            );
            localUri = norm.uri;
            setImageUri(localUri); // overlay must render the SAME normalised image
            devLog('loadExistingReceipt.normalized', {
              id, parsed: `${parsedWidth}x${parsedHeight}`, measured: `${norm.width}x${norm.height}`,
            });

            const applyDims = (w: number, h: number) => {
              setImageDims({ width: w, height: h });
              setPageMetas([
                {
                  uri: localUri,
                  pixelWidth: w,
                  pixelHeight: h,
                  frameScale: 1,
                  yOffsetScaled: 0,
                  pageMaxYScaled: h,
                  receiptXLeftScaled: 0,
                  receiptXRightScaled: w,
                },
              ]);
            };

            // CRITICAL: imageDims MUST be parsed.image dims — the coordinate space
            // EVERY region (products + masks + header + footer) was emitted in
            // (ocrImageTiled's trueWidth/trueHeight). NOT a re-measure: Image.getSize
            // can report a decoder-SAMPLED size for big images, and resizing to it
            // squished the image so lower bands drifted. With the image rotated to
            // portrait, parsed dims line every band up 1:1.
            if (hasParsedDims) {
              applyDims(parsedWidth, parsedHeight);
            } else {
              try {
                const info = await ImageManipulator.manipulateAsync(localUri, []);
                applyDims(info.width, info.height);
              } catch {
                Image.getSize(localUri, (width, height) => applyDims(width, height), () => {});
              }
            }
          }
        } catch (e) {
          console.warn("Failed to load receipt image for region preview:", e);
        } finally {
          setImageLoading(false);
        }
      })();

      // Mark the session complete before firing the background comparison so
      // the "Kvitas apdorojamas" overlay (gated on !firstCompleteReached) never
      // triggers in existing-receipt mode. The overlay is only meaningful for
      // fresh OCR flows where post → upload → comparison are all in-flight.
      setFirstCompleteReached(true);
      void fetchComparison(id);
    } catch (e) {
      console.warn("[loadExistingReceipt] failed:", e);
      router.replace("/(tabs)/receipts");
    } finally {
      setLoading(false);
      setTimeout(() => {
        isHydratingRef.current = false;
      }, 0);
    }
  };
  // Refs for debounced save machinery (no re-renders, live values for unmount cleanup)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<object | null>(null);
  // Serialize autosave PUTs: at most one in flight; a save requested while one is running
  // is queued (newest wins) and flushed on completion. Without this, two debounced PUTs
  // could be in flight at once and the OLDER snapshot could land last, silently reverting
  // the user's latest edit (the server serializes but does not order concurrent requests).
  const saveInFlightRef = useRef(false);
  const queuedSaveDataRef = useRef<object | null>(null);
  const receiptIdRef = useRef<number | null>(null);
  const userIdRef = useRef<string | null>(null);
  const hasPostedRef = useRef(false); // guard against double POST from re-renders
  // DEV-only: per-word OCR capture for the last IKI parse, persisted top-level in
  // the blob (NOT via header state, which propagates unreliably). See buildParsedData.
  // `wordsSrcRef` records which path populated it ('scan'|'load'|'none') — a probe to
  // diagnose why it sometimes saves empty.
  const wordsDumpRef = useRef<unknown>(undefined);
  const wordsSrcRef = useRef<string>("none");
  const hasProcessedRef = useRef(false); // guard against double OCR in StrictMode dev builds
  // Mirrors hasProcessedRef but for the existing-receipt path. Without
  // this, StrictMode's dev double-mount issues two parallel GETs for the
  // same receipt id (and runs hydration twice, which racing against the
  // setTimeout(0) that clears isHydratingRef can slip a stray save through).
  const hasLoadedExistingRef = useRef<number | null>(null);

  // Keep refs in sync with state
  useEffect(() => {
    receiptIdRef.current = receiptId;
  }, [receiptId]);

  // Cache userId on mount so unmount flush can use it synchronously
  useEffect(() => {
    (async () => {
      const id = await getUserId();
      userIdRef.current = id;
    })();
  }, []);

  // Reset state when a new scan uri arrives, so a second scan on the same
  // screen instance doesn't inherit the previous receipt's receiptId /
  // imageFilePath / status flags.
  useEffect(() => {
    if (isExistingMode) return;
    if (!uri) return;
    setReceiptId(null);
    setImageFilePath(null);
    setImageDims(null);
    loadedImageDimsRef.current = null;
    setMaskBands([]);
    setHeader(null);
    setFooter(null);
    setProducts([]);
    setPostStatus("idle");
    setPostErr(null);
    setUploadStatus("idle");
    setUploadErr(null);
    setComparisonStatus("idle");
    setFirstCompleteReached(false);
    setComparison(null);
    hasPostedRef.current = false;
    hasProcessedRef.current = false;
    comparisonKeyRef.current = "";
    shouldRefreshComparisonRef.current = false;
  }, [uri, isExistingMode, setComparison]);

  // Kick off OCR when uri is provided
  useEffect(() => {
    if (isExistingMode && existingReceiptId) {
      // Per-id guard: block only a StrictMode dev double-mount of the SAME receipt.
      // The boolean version never reset, so navigating receipt A→B in a reused screen
      // instance never reloaded B — it kept A's stale data/masks/imageDims.
      if (hasLoadedExistingRef.current === existingReceiptId) return;
      hasLoadedExistingRef.current = existingReceiptId;
      loadExistingReceipt(existingReceiptId);
      return;
    }

    if (imageUriList.length > 0) {
      if (hasProcessedRef.current) return; // StrictMode mounts effects twice in dev
      hasProcessedRef.current = true;
      setImageUri(imageUriList[0]); // first page used for region previews
      // Persist a draft to AsyncStorage so that if the OS kills the
      // app before the Receipt POST completes, the user can resume
      // from the Analize tab without re-picking the image. Preview
      // mode is out-of-scope for this — those scans never save
      // anything server-side anyway.
      if (!isPreviewMode) {
        saveReceiptDraft(imageUriList).catch(() => {});
      }
      processReceipt(imageUriList);
    }
  }, [imageUriList, isExistingMode, existingReceiptId, isPreviewMode]);

  // Re-pull receipt categories on focus so the Suvestinė breakdown
  // reflects any personal rescues from a voluntary swipe session. The
  // live resolver overlays the user's "same" votes on top of the global
  // Product.categoryId, but the products state was loaded once on
  // mount — without this refresh the Neatpažinta number stays frozen
  // until the user leaves the screen and returns.
  //
  // Matches altMatches by storeProductId (not array index) so concurrent
  // edits to the receipt don't get clobbered. Only the three category
  // fields are touched; everything else on each line is preserved.
  useFocusEffect(
    useCallback(() => {
      if (!receiptId) return;
      let cancelled = false;
      // Skip initial mount — loadExistingReceipt already populates the
      // categories from the same endpoint. This effect is for refreshes
      // AFTER the user returns from /swipe/queue. The hydrate ref is
      // true while loadExistingReceipt is running.
      if (isHydratingRef.current) return;
      (async () => {
        try {
          const res = await fetchWithTimeout(
            `${API_BASE_URL}/api/receipts/${receiptId}`,
            { timeoutMs: 5000 },
          );
          if (cancelled || !res.ok) return;
          const data = await res.json();
          const parsed = typeof data.parsedData === 'string'
            ? JSON.parse(data.parsedData)
            : data.parsedData;
          const liveProducts: any[] = Array.isArray(parsed?.products) ? parsed.products : [];
          if (cancelled || liveProducts.length === 0) return;
          // Build a {storeProductId → {category fields}} map from the
          // fresh response. Multiple lines may reference the same SP;
          // last write wins which is fine because the resolver returns
          // identical category data for the same SP.
          const liveBySpId = new Map<number, { categoryId: number | null; categoryName: string | null; categoryL2Name: string | null }>();
          for (const lp of liveProducts) {
            if (!Array.isArray(lp?.altMatches)) continue;
            for (const lam of lp.altMatches) {
              const sp = Number(lam?.storeProductId);
              if (!Number.isFinite(sp) || sp <= 0) continue;
              liveBySpId.set(sp, {
                categoryId: lam.categoryId ?? null,
                categoryName: lam.categoryName ?? null,
                categoryL2Name: lam.categoryL2Name ?? null,
              });
            }
          }
          if (cancelled) return;
          // IDENTITY GUARD: return `prev` UNCHANGED when no line was actually modified.
          // A bare prev.map(...) mints a new array reference on every focus regain, which
          // fires the autosave effect (deps include `products`) → a gratuitous full-blob
          // PUT — the exact "navigate away and come back" firing pin of the band-drift
          // class (it used to catch the null-imageDims window and persist fabricated dims).
          setProducts(prev => {
            let anyChanged = false;
            const next = prev.map((p, i) => {
            // (1) Patch category fields onto altMatches by spId (existing).
            let nextAm: ProductMatchOption[] = p.altMatches;
            if (Array.isArray(p.altMatches) && p.altMatches.length > 0) {
              let touched = false;
              const mapped: ProductMatchOption[] = p.altMatches.map(am => {
                const sp = Number(am?.storeProductId);
                if (!Number.isFinite(sp) || sp <= 0) return am;
                const live = liveBySpId.get(sp);
                if (!live || live.categoryId === null) return am;
                if (
                  am.categoryId === live.categoryId
                  && am.categoryName === live.categoryName
                  && am.categoryL2Name === live.categoryL2Name
                ) return am;
                touched = true;
                return { ...am, categoryId: live.categoryId, categoryName: live.categoryName, categoryL2Name: live.categoryL2Name };
              });
              if (touched) nextAm = mapped;
            }
            // (2) Re-sync the PRIMARY match fields when the server changed them
            // out from under us — a swipe "different" demotion re-points the line
            // to a runner-up or clears it to OCR. Keyed by INDEX (a demoted line
            // has storeProductId=null, so an spId key can't find it).
            const lp = liveProducts[i];
            const liveSpId = lp && Number.isFinite(Number(lp.storeProductId)) ? Number(lp.storeProductId) : null;
            const demoted = !!lp && (
              liveSpId !== (p.storeProductId ?? null)
              || !!lp.matchConfirmed !== !!p.matchConfirmed
            );
            if (nextAm === p.altMatches && !demoted) return p;
            anyChanged = true;
            return {
              ...p,
              altMatches: nextAm,
              ...(demoted ? {
                storeProductId: liveSpId,
                matchedName: lp.matchedName ?? null,
                storeProductImageUrl: lp.storeProductImageUrl ?? null,
                matchConfidence: typeof lp.matchConfidence === 'number' ? lp.matchConfidence : null,
                matchConfirmed: !!lp.matchConfirmed,
                priceVerified: !!lp.priceVerified,
                itemConfidence: lp.itemConfidence && typeof lp.itemConfidence.band === 'string'
                  ? (lp.itemConfidence as ItemConfidence)
                  : null,
                categoryId: lp.categoryId ?? null,
                categoryName: lp.categoryName ?? null,
                categoryL2Name: lp.categoryL2Name ?? null,
              } : {}),
            };
            });
            return anyChanged ? next : prev;
          });
        } catch {
          /* swallow — best-effort refresh */
        }
      })();
      return () => { cancelled = true; };
    }, [receiptId])
  );

  // Refresh the swipe-queue count every time the receipt screen regains
  // focus (initial mount + returning from /receipt/swipe/[id]). Backend's
  // filter already excludes votes this user has cast, so the count we get
  // back IS exactly "cards remaining for this user".
  // Delayed 2 s so the comparison fetch (which drives the main loading state)
  // gets a head start and doesn't compete with this advisory query for DB
  // pool connections.
  useFocusEffect(
    useMemo(
      () => () => {
        if (!receiptId) return;
        let cancelled = false;
        let delayTimer: ReturnType<typeof setTimeout> | null = null;
        delayTimer = setTimeout(() => {
          const controller = new AbortController();
          const abortTimer = setTimeout(() => controller.abort(), 5000);
          (async () => {
            try {
              const userId = await getUserId();
              // SINGLE SOURCE OF TRUTH: the server runs the EXACT served-queue
              // assembly (relatedTo-gated receipt + global pools through
              // capVoluntaryQueue, plus ≤5 prepended Card-B resolve cards) and
              // returns the count — so the badge equals what the swipe screen
              // actually opens. The old client-side count omitted the relatedTo
              // gate AND the resolve cards, hence "advertises N → opens empty".
              const res = await fetch(
                `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/voluntary-queue-count?receiptId=${encodeURIComponent(receiptId)}`,
                { signal: controller.signal }
              );
              clearTimeout(abortTimer);
              if (!res.ok || cancelled) return;
              const data = await res.json();
              const count = Number.isFinite(data?.count) ? Number(data.count) : 0;
              if (!cancelled) {
                setSwipeQueueCount(count);
                setSwipeQueueFetched(true);
              }
            } catch {
              /* swallow — it's advisory UI */
            }
          })();
        }, 2000);
        return () => {
          cancelled = true;
          if (delayTimer) clearTimeout(delayTimer);
        };
      },
      [receiptId]
    )
  );

  // Apply user's manual pick from the category browser
  useEffect(() => {
    if (!pendingPick) return;
    const {
      productIndex,
      storeProductId,
      storeProductName,
      imageUrl,
      priceVerified,
    } =
      pendingPick;

    setProducts((prev) => {
      if (productIndex < 0 || productIndex >= prev.length) return prev;
      const updated = [...prev];
      updated[productIndex] = {
        ...updated[productIndex],
        matchedName: storeProductName,
        storeProductId,
        storeProductImageUrl: imageUrl,
        matchConfidence: 1,
        matchConfirmed: true,
        priceVerified: !!priceVerified,
      };
      return updated;
    });

    clearPendingPick();
  }, [pendingPick, clearPendingPick]);

  // Step 1: POST receipt once OCR + store match + product match have all completed
  const runPost = async () => {
    if (!header || !footer) return;
    if (header.matchLoading) return;
    setPostStatus("pending");
    setPostErr(null);
    try {
      const userId = userIdRef.current ?? (await getUserId());
      userIdRef.current = userId;

      const parsedData = buildParsedData(
        header,
        products,
        footer,
        // Fallback-of-first-resort: the dims LOADED from the blob. Geometry-derived
        // dims (inside buildParsedData) are reserved for true legacy image:null
        // receipts — never for one that already has persisted dims (band-drift class).
        imageDims
          ? { uri: imageUri, ...imageDims }
          : loadedImageDimsRef.current
            ? { uri: imageUri, ...loadedImageDimsRef.current }
            : null,
        imageFilePath,
        maskBandsClamped,
        wordsDumpRef.current,
      );

      // DEV re-OCR: retire the OLD receipt right before creating the fresh one — done
      // HERE (not on entry) so a bail-to-retake earlier in the pipeline leaves the
      // original intact, and so the create below isn't rejected as a duplicate (same
      // receiptNo). Best-effort: a delete hiccup would only surface as a 409 next.
      if (reocrReceiptId != null && Number.isFinite(reocrReceiptId)) {
        try {
          await fetch(`${API_BASE_URL}/api/receipts/${reocrReceiptId}`, { method: "DELETE" });
        } catch (e) {
          console.warn("[reocr] old-receipt delete failed (continuing):", e);
        }
      }

      const res = await fetchWithTimeout(`${API_BASE_URL}/api/receipts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, filePath: "", parsedData }),
        timeoutMs: TIMEOUT_HEAVY_MS,
      });
      const data = await res.json();
      // Duplicate detection. Backend returns 409 for BOTH same-user
      // (caught upfront) and cross-user (caught by the UNIQUE
      // constraint safety net) duplicates. Either way, bail out to
      // the Analize tab with a clear message — no half-state on this
      // screen, no sneaky nav to another receipt's view.
      if (res.status === 409) {
        // SAME-ACCOUNT duplicate on a FRESH SCAN with the photo still in hand: this is
        // almost always the abort-then-retry case (receipt-238 — the first POST exceeded
        // the client timeout, the server committed anyway, and the retry collided here).
        // RESUME the pipeline against the existing row instead of bailing: setting
        // receiptId lets the upload effect below recover the MISSING PHOTO (the abort
        // killed the flow before the image step — the "photo not ready 404" crops), and
        // pending mandatory swipes continue in-place exactly like a fresh create.
        const existingId = Number(data?.existingReceiptId);
        if (!data?.crossAccount && Number.isFinite(existingId) && existingId > 0 && imageUri) {
          console.log(`[post] duplicate of r${existingId} — resuming pipeline against it (photo recovery + swipes)`);
          setReceiptId(existingId);
          setPostStatus("done");
          useReceiptQueueStore.getState().noteReceiptCreated(existingId);
          if (linkListIdRef.current) {
            fetch(`${API_BASE_URL}/api/shopping-lists/${linkListIdRef.current}/link-receipt`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ receiptId: existingId }),
            }).catch(() => {});
          }
          clearReceiptDraft().catch(() => {});
          const pending = Number(data?.mandatorySwipesPending ?? 0);
          if (pending > 0) {
            enterSwipePhase(existingId, () => {
              setComparisonStatus("pending");
              fetchComparison(existingId);
            });
          } else {
            setComparisonStatus("pending");
            fetchComparison(existingId);
          }
          return;
        }
        setPostStatus("done");
        // Receipt already exists server-side and there's nothing to resume with
        // (cross-account, or no photo in hand). Drop the local draft — the data
        // lives in someone's receipt list.
        clearReceiptDraft().catch(() => {});
        useProfileStore.getState().invalidate();
        // Same-ACCOUNT duplicate while uploading for a list: the user already
        // has this receipt — silently link the EXISTING row to the list
        // instead of bailing, so the card still flips to "Kvitas pridėtas".
        if (linkListIdRef.current && data?.existingReceiptId) {
          fetch(`${API_BASE_URL}/api/shopping-lists/${linkListIdRef.current}/link-receipt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ receiptId: data.existingReceiptId }),
          }).catch(() => {});
          router.replace("/(tabs)/shoppingList");
          setTimeout(() => {
            Alert.alert(t('receiptProcess.duplicateTitle'), t('receiptProcess.duplicateLinkedBody'));
          }, 100);
          return;
        }
        // Cross-ACCOUNT duplicate: a different account uploaded this receipt.
        // Don't claim the current user uploaded it; can't link it either.
        const crossAccount = data?.crossAccount === true;
        router.replace("/(tabs)/receipts");
        setTimeout(() => {
          Alert.alert(
            crossAccount ? t('receiptProcess.dupOtherAccountTitle') : t('receiptProcess.duplicateTitle'),
            crossAccount ? t('receiptProcess.dupOtherAccountBody') : t('receiptProcess.duplicateBody'),
          );
        }, 100);
        return;
      }
      if (!res.ok || !data?.id) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setReceiptId(data.id);
      setPostStatus("done");
      // Tell the shared queue store the receipt now exists so the Analyze list refetches
      // immediately (even while its tab is blurred) and the receipt lands in "Nauji" —
      // parity with the batch-upload path. Placed on the success branch only (after the
      // 409-duplicate and !ok early-returns), never before data.id exists.
      useReceiptQueueStore.getState().noteReceiptCreated(data.id);
      // Link this receipt to the resolved list row (auto-selected by the
      // detected chain for groups). Fire-and-forget — the List-tab card
      // flips to "Kvitas pridėtas" on next refresh.
      if (linkListIdRef.current) {
        fetch(`${API_BASE_URL}/api/shopping-lists/${linkListIdRef.current}/link-receipt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ receiptId: data.id }),
        }).catch(() => {});
      }
      clearReceiptDraft().catch(() => {});
      // Record store visit for location intelligence (fire-and-forget)
      if (header.storeId && header.chainId) {
        fetch(`${API_BASE_URL}/api/stores/${header.storeId}`)
          .then(r => r.ok ? r.json() : null)
          .then(store => {
            if (store?.latitude && store?.longitude) {
              recordStoreVisit(
                header.storeId!,
                store.latitude,
                store.longitude,
                header.chainId!,
                header.chainName,
              ).catch(() => {});
            }
          })
          .catch(() => {});
      }
      if (data.mandatorySwipesRequired > 0) {
        // User must swipe before seeing the price comparison — host the swipe
        // phase in-place. When the session finishes we fetch the comparison and
        // flip straight to the detail (no route bounce, no new screen instance).
        enterSwipePhase(data.id, () => {
          setComparisonStatus("pending");
          fetchComparison(data.id);
        });
      } else {
        setComparisonStatus("pending");
        fetchComparison(data.id);
      }
    } catch (e: any) {
      console.warn("Receipt POST failed:", e);
      setPostStatus("error");
      setPostErr(e?.message || t('receiptProcess.errorSave'));
      // Do NOT re-arm the auto-POST guard here: the effect below re-fires on any
      // header/footer/products identity change, so resetting the ref turned a
      // DETERMINISTIC server rejection (the garbled-date 500, receipt-242 re-scan)
      // into an endless "saving receipt…" modal loop. Retries stay MANUAL via the
      // error card's retry button (retryPost re-arms + re-runs deliberately).
    }
  };

  useEffect(() => {
    if (isExistingMode) return;
    if (isPreviewMode) return; // preview: skip receipt creation
    if (hasPostedRef.current) return;
    if (!header || !footer) return;
    if (header.matchLoading) return;
    hasPostedRef.current = true;
    runPost();
  }, [header, footer, products, isPreviewMode]);

  const retryPost = () => {
    hasPostedRef.current = true;
    runPost();
  };

  // Step 2: MinIO upload — runs in parallel with POST, PATCH filePath once done.
  const runUpload = async () => {
    // HARD GUARD: only ever burn+upload on a FRESH SCAN. In existing mode the
    // image is already uploaded (and already redacted). Re-running here re-burns
    // the masks onto the already-burned MinIO image — the "random black band on
    // reopen". The imageFilePath guard below was insufficient because
    // parsed.image.filePath is frozen at POST time (still null then; the real
    // filePath is PATCHed to a separate column AFTER the upload), so on reopen
    // imageFilePath stays null and the burn leaked through. The orphan case
    // (filePath === "") only surfaces an error badge — it never re-uploads — so
    // there is no legitimate existing-mode upload to preserve.
    if (isExistingMode) return;
    if (!imageUri || !receiptId) return;
    setUploadStatus("pending");
    setUploadErr(null);
    try {
      const urlRes = await fetchWithTimeout(`${API_BASE_URL}/api/receipts/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: `receipt-${receiptId}.jpg`,
          mimeType: "image/jpeg",
        }),
        timeoutMs: TIMEOUT_STANDARD_MS,
      });
      if (!urlRes.ok) throw new Error(`upload-url HTTP ${urlRes.status}`);
      const { uploadUrl, filePath } = await urlRes.json();
      if (!uploadUrl || !filePath) throw new Error(t('receiptProcess.errorUploadUrlFields'));

      // Burn the card/loyalty/cashier black boxes into the image BEFORE upload
      // so the raw card data never leaves the device. This goes through the
      // SAME shared `buildRedactedUploadUri` as the headless queue, so every
      // entry point (take-photo / upload / shopping-list) masks identically.
      // Fail-closed: if sensitive bands were detected but a clean redaction
      // can't be produced (incl. missing image dims), abort — never PUT the
      // original image that still shows a card number.
      // `imageDims` is set during OCR and goes stale across the post→existing-
      // mode re-mount (existing-mode load doesn't repopulate it), which made the
      // redaction abort with "invalid image dims 0x0" — esp. on the multi-segment
      // path. Measure the actual upload image instead of trusting that state; the
      // mask bands (filtered to this page's height) map onto these pixels.
      // This burn ONLY runs on a fresh scan (runUpload bails in existing mode),
      // so imageDims is the OCR pixel space the mask bands were detected in —
      // burn the bands at percent of those same dims.
      let uploadW = imageDims?.width ?? 0;
      let uploadH = imageDims?.height ?? 0;
      if (!(uploadW > 0) || !(uploadH > 0)) {
        try {
          // TRUE decoder pixels via ImageManipulator — NOT Image.getSize, which
          // BitmapFactory down-samples tall images to (an undersized denominator
          // would misposition the burned bands).
          const info = await ImageManipulator.manipulateAsync(imageUri, []);
          if (!(uploadW > 0)) uploadW = info.width;
          if (!(uploadH > 0)) uploadH = info.height;
        } catch { /* leave 0 — buildRedactedUploadUri fail-closes if bands exist */ }
      }
      let uploadUri = imageUri;
      try {
        uploadUri = await buildRedactedUploadUri(imageUri, uploadW, uploadH, maskBandsClamped);
      } catch (e: any) {
        console.warn("[mask] redaction failed, aborting upload:", e?.message ?? e);
        // Log the unprocessable case (P4). Fire-and-forget; never block on it.
        fetch(`${API_BASE_URL}/api/receipts/log-fail`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: userIdRef.current,
            failReason: "mask_failed",
            shoppingListId: linkListIdRef.current ?? undefined,
          }),
        }).catch(() => {});
        setUploadStatus("error");
        setUploadErr(t('receiptProcess.errorMaskFailed'));
        return;
      }

      // Local-file blob load is NOT a network call; fetch on a file:// URI
      // is synchronous-ish. No timeout needed.
      const imageBlob = await (await fetch(uploadUri)).blob();
      const putRes = await fetchWithTimeout(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: imageBlob,
        timeoutMs: TIMEOUT_HEAVY_MS,
      });
      if (!putRes.ok) throw new Error(`MinIO PUT HTTP ${putRes.status}`);

      const patchRes = await fetchWithTimeout(
        `${API_BASE_URL}/api/receipts/${receiptId}/file-path`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath }),
          timeoutMs: TIMEOUT_STANDARD_MS,
        },
      );
      if (!patchRes.ok) throw new Error(`PATCH HTTP ${patchRes.status}`);

      setImageFilePath(filePath);
      setUploadStatus("done");

      // Cache the EXACT redacted bytes we just persisted at the canonical reopen path
      // (buildReceiptPageMeta's download dest) so a later reopen of THIS receipt — or
      // any fallback crop build — short-circuits to the local file instead of a MinIO
      // round-trip, and renders the SAME redacted pixels that were stored. Best-effort.
      try {
        const cacheDir = FileSystem.cacheDirectory ?? "";
        if (cacheDir && uploadUri) {
          const dest = `${cacheDir}receipt-${receiptId}.jpg`;
          if (uploadUri !== dest) {
            await FileSystem.deleteAsync(dest, { idempotent: true });
            await FileSystem.copyAsync({ from: uploadUri, to: dest });
          }
        }
      } catch {
        /* non-fatal: the reopen path will just download as before */
      }
    } catch (e: any) {
      console.warn("MinIO upload failed:", e);
      setUploadStatus("error");
      setUploadErr(e?.message || t('receiptProcess.errorUploadPhoto'));
    }
  };

  useEffect(() => {
    if (isPreviewMode) return; // preview: skip MinIO upload + PATCH
    if (isExistingMode) return; // never re-burn/upload an already-saved receipt
    if (!imageUri || !receiptId || imageFilePath) return;
    if (uploadStatus === "pending" || uploadStatus === "error") return;
    runUpload();
  }, [imageUri, receiptId, imageFilePath, isPreviewMode, isExistingMode]);

  const retryUpload = () => {
    runUpload();
  };

  // Auto-retry: on reconnect AND on a 5-second interval while any step is
  // in error state. Errors are never shown to the user — everything retries
  // silently in the background.
  const lastOnlineAt = useNetworkStatus((s) => s.lastOnlineAt);
  const checkCandidate = useLevelStore(s => s.checkCandidate);
  useFocusEffect(useCallback(() => { checkCandidate(); }, [checkCandidate]));
  useEffect(() => {
    if (lastOnlineAt === null) return;
    if (isPreviewMode) return;
    if (postStatus === "error") retryPost();
    if (uploadStatus === "error" && imageUri) runUpload();
    if (comparisonStatus === "error" && receiptId) fetchComparison(receiptId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastOnlineAt]);

  const hasAnyError = postStatus === "error" || uploadStatus === "error" || comparisonStatus === "error";
  useEffect(() => {
    if (!hasAnyError || isPreviewMode) return;
    const interval = setInterval(() => {
      if (postStatus === "error") retryPost();
      if (uploadStatus === "error" && imageUri) runUpload();
      if (comparisonStatus === "error" && receiptId) fetchComparison(receiptId);
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAnyError, isPreviewMode]);

  /**
   * Issue-report: write a row into ReceiptLineIssue with the flagged fields,
   * and flip the line's Price.priceVerified back to 0 so the item no longer
   * contributes to trusted comparison totals until an admin reviews it.
   */
  const submitIssueReport = async (
    lineIdx: number,
    flags: { name: boolean; price: boolean; amount: boolean; discount: boolean; image: boolean },
  ) => {
    if (!receiptId) return;
    try {
      const userId = await getUserId();
      const res = await fetch(
        `${API_BASE_URL}/api/receipts/${receiptId}/lines/${lineIdx}/report-issue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, flags }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e: any) {
      console.warn("Issue report failed:", e?.message ?? e);
      Alert.alert(t('receiptProcess.errorSendTitle'), t('receiptProcess.errorSendBody'));
    }
  };

  /**
   * Direct "this isn't the right product" rejection of a line's match. The server
   * demotes the line — re-points it to a same-chain runner-up (≥ auto-apply) or
   * clears it to the OCR name with a userRejected veto — and returns the mutated
   * line, which we patch into this row in place (no reload needed).
   */
  const handleRejectMatch = async (lineIdx: number) => {
    if (!receiptId) return;
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/receipts/${receiptId}/lines/${lineIdx}/reject-match`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => null);
      const live = data?.line;
      if (live) {
        setProducts(prev => prev.map((p, i) => i === lineIdx ? {
          ...p,
          storeProductId: live.storeProductId ?? null,
          matchedName: live.matchedName ?? null,
          storeProductImageUrl: live.storeProductImageUrl ?? null,
          matchConfidence: typeof live.matchConfidence === 'number' ? live.matchConfidence : null,
          matchConfirmed: !!live.matchConfirmed,
          priceVerified: !!live.priceVerified,
          itemConfidence: live.itemConfidence && typeof live.itemConfidence.band === 'string'
            ? (live.itemConfidence as ItemConfidence)
            : null,
          categoryId: live.categoryId ?? null,
          categoryName: live.categoryName ?? null,
          categoryL2Name: live.categoryL2Name ?? null,
        } : p));
      }
    } catch (e: any) {
      console.warn("Reject match failed:", e?.message ?? e);
      Alert.alert(t('receiptProcess.errorSendTitle'), t('receiptProcess.errorSendBody'));
    }
  };

  /**
   * Capture or pick an image, upload to MinIO via the same presigned-URL
   * pattern receipts use, then PATCH StoreProduct.imageUrl so every receipt
   * referencing this SP picks up the new photo.
   */
  const handleAddProductPhoto = async (lineIdx: number) => {
    const line = products[lineIdx];
    if (!line?.storeProductId) {
      Alert.alert(
        t('receiptProcess.errorProductUnmatched'),
        t('receiptProcess.errorProductUnmatchedBody'),
      );
      return;
    }
    try {
      // Permission check — expo-image-picker v15+ refuses silently without it.
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          t('receiptProcess.errorPermissionTitle'),
          t('receiptProcess.errorPermissionBody'),
        );
        return;
      }
      // expo-image-picker v17 dropped `MediaTypeOptions.Images`; the new API
      // takes a string array — "images" means photos only (no videos).
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.8,
        base64: false,
      });
      if (picked.canceled || !picked.assets?.[0]) return;
      const asset = picked.assets[0];

      // Hit the product-image-specific presigned-URL endpoint so the upload
      // lands in the product-images bucket, not the receipts bucket.
      const urlRes = await fetch(`${API_BASE_URL}/api/store-products/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: `sp-${line.storeProductId}-${Date.now()}.jpg`,
          mimeType: asset.mimeType || "image/jpeg",
        }),
      });
      if (!urlRes.ok) throw new Error(`upload-url HTTP ${urlRes.status}`);
      const { uploadUrl, filePath } = await urlRes.json();
      if (!uploadUrl || !filePath) throw new Error("Bad upload-url payload");

      const blob = await (await fetch(asset.uri)).blob();
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": asset.mimeType || "image/jpeg" },
        body: blob,
      });
      if (!putRes.ok) throw new Error(`MinIO PUT HTTP ${putRes.status}`);

      const userId = await getUserId();
      const patchRes = await fetch(
        `${API_BASE_URL}/api/store-products/${line.storeProductId}/image`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath, userId }),
        },
      );
      if (!patchRes.ok) throw new Error(`image PATCH HTTP ${patchRes.status}`);
      const patchBody = await patchRes.json();

      if (patchBody.queued) {
        // Regular user upload — the photo is in the admin pending
        // queue, not yet published. Tell the user clearly so they
        // don't expect to see their image instantly.
        Alert.alert(t('imageUpload.sentForReviewTitle'), t('imageUpload.sentForReviewBody'));
      } else if (patchBody.imageUrl) {
        // Admin upload — published immediately, update the thumbnail.
        setProducts((prev) => {
          const next = [...prev];
          if (next[lineIdx]) {
            next[lineIdx] = { ...next[lineIdx], storeProductImageUrl: patchBody.imageUrl };
          }
          return next;
        });
      }
    } catch (e: any) {
      console.warn("Photo upload failed:", e?.message ?? e);
      Alert.alert(t('receiptProcess.errorPhotoUploadTitle'), t('receiptProcess.errorPhotoUploadBody'));
    }
  };

  const retryComparison = () => {
    if (!receiptId) return;
    setComparisonStatus("pending");
    fetchComparison(receiptId);
  };

  // Step 3: debounced PUT on any parsedData change
  useEffect(() => {
    if (isPreviewMode) return; // preview: no PUT / no save
    if (!receiptId) return; // POST hasn't completed yet
    if (!header || !footer) return;
    if (isHydratingRef.current) return;

    const parsedData = buildParsedData(
      header,
      products,
      footer,
      // Same loaded-dims fallback as the POST path — geometry-derived dims are for
      // true legacy image:null receipts only (band-drift class).
      imageDims
        ? { uri: imageUri, ...imageDims }
        : loadedImageDimsRef.current
          ? { uri: imageUri, ...loadedImageDimsRef.current }
          : null,
      imageFilePath,
      maskBandsClamped,
      wordsDumpRef.current,
    );
    const nextComparisonKey = buildComparisonKey(header, products);
    shouldRefreshComparisonRef.current =
      nextComparisonKey !== comparisonKeyRef.current;
    comparisonKeyRef.current = nextComparisonKey;
    scheduleDebouncedSave(parsedData);
  }, [header, products, footer, receiptId, imageFilePath]);
  // Unmount flush
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const id = receiptIdRef.current;
      const userId = userIdRef.current;
      const snapshot = pendingSaveRef.current;
      if (id && userId && snapshot) {
        // Fire and forget — component is tearing down, can't await.
        // Use fetchWithTimeout with the standard timeout so a hung
        // request on unmount doesn't linger holding sockets open on
        // the device long after the screen is gone.
        fetchWithTimeout(`${API_BASE_URL}/api/receipts/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, parsedData: snapshot }),
          timeoutMs: TIMEOUT_STANDARD_MS,
        }).catch((err) => console.warn("Unmount flush failed:", err));
        pendingSaveRef.current = null;
      }
    };
  }, []);

  const saveNow = async (id: number, data: object) => {
    // In-flight guard: if a PUT is already running, stash the newest snapshot and let the
    // running save flush it on completion — never two PUTs racing.
    if (saveInFlightRef.current) {
      queuedSaveDataRef.current = data;
      return;
    }
    saveInFlightRef.current = true;
    try {
      const userId = userIdRef.current ?? (await getUserId());
      userIdRef.current = userId;
      await fetchWithTimeout(`${API_BASE_URL}/api/receipts/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, parsedData: data }),
        timeoutMs: TIMEOUT_STANDARD_MS,
      });
      // Only refetch the comparison when the user's edit actually changed
      // a field that feeds into it (price, quantity, store-product link).
      // Pure metadata edits still get persisted but don't pay the
      // comparison round-trip.
      if (shouldRefreshComparisonRef.current) {
        shouldRefreshComparisonRef.current = false;
        fetchComparison(id);
      }
    } catch (e) {
      console.warn("Save failed:", e);
    } finally {
      saveInFlightRef.current = false;
      // A newer edit arrived while this PUT was in flight — send it now so the latest
      // snapshot is always the last one written.
      const queued = queuedSaveDataRef.current;
      if (queued) {
        queuedSaveDataRef.current = null;
        void saveNow(id, queued);
      }
    }
  };

  const scheduleDebouncedSave = (data: object) => {
    pendingSaveRef.current = data;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    saveTimerRef.current = setTimeout(() => {
      const id = receiptIdRef.current;
      const snapshot = pendingSaveRef.current;
      if (id && snapshot) {
        saveNow(id, snapshot);
        pendingSaveRef.current = null;
      }
      saveTimerRef.current = null;
    }, 1500);
  };

  /**
   * Analize-flow bail path. Called when the receipt can't proceed past
   * an early phase (OCR produced nothing, chain not detected, store
   * lookup failed). Logs a FailedReceiptLog server-side for analytics
   * — lets us distinguish "user uploaded junk" from "OCR missed" —
   * then pops an alert and navigates back to the Analize tab. No
   * Receipt row is ever created on this path.
   */
  type BailReason =
    | "ocr_no_text"
    | "ocr_error"
    | "chain_unrecognized"
    | "store_unrecognized"
    | "no_products"
    | "doubled_scan";

  const USER_FACING_BAIL_MSG: Record<BailReason, string> = {
    ocr_no_text: t('receiptProcess.errorOcrUnreadable'),
    ocr_error: t('receiptProcess.errorOcrParse'),
    chain_unrecognized: t('receiptProcess.errorChain'),
    store_unrecognized: t('receiptProcess.errorStore'),
    no_products: t('receiptProcess.errorNoProducts'),
    doubled_scan: t('receiptProcess.errorDoubledScan'),
  };

  interface BailContext {
    ocrLineCount?: number | null;
    ocrPreview?: string | null;
    detectedChainName?: string | null;
    extractedStoreAddress?: string | null;
    /** OCR/parsed payload captured at fail time (JSON string) — the post-mortem trail. */
    parsedData?: string | null;
  }

  const bailWithLog = async (reason: BailReason, ctx: BailContext = {}) => {
    // Fire-and-forget log. Network/DB failure here must not block the
    // user's return to the Analize tab — the priority is getting them
    // out of the dead-end flow.
    try {
      const userId = await getUserId();
      fetchWithTimeout(`${API_BASE_URL}/api/receipts/log-fail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          failReason: reason,
          ocrLineCount: ctx.ocrLineCount ?? null,
          ocrPreview: ctx.ocrPreview ?? null,
          detectedChainName: ctx.detectedChainName ?? null,
          extractedStoreAddress: ctx.extractedStoreAddress ?? null,
          imageFilePath: imageFilePath ?? null,
          parsedData: ctx.parsedData ?? null,
        }),
        timeoutMs: TIMEOUT_FAST_MS,
      }).catch((e) => console.warn("[bailWithLog] log POST failed:", e));
    } catch (e) {
      console.warn("[bailWithLog] log prep failed:", e);
    }

    setLoading(false);
    // Bail = receipt can't be processed, nothing to resume. Drop the
    // draft so the Analize tab doesn't keep prompting "continue" on
    // a scan that will just bail again.
    clearReceiptDraft().catch(() => {});
    // Show the Souply-styled failure modal (Try again / Close) instead of the
    // stock OS Alert. Its buttons handle navigation — we DON'T navigate here, so
    // "Try again" can re-open the scanner from this screen.
    setFailGate(USER_FACING_BAIL_MSG[reason]);
  };

  const processReceipt = async (imageUris: string[]) => {
    // Quality gate. A readable receipt always yields a receipt id (now incl. the
    // "Kvitas"/synthetic fallbacks) and a DATE; TIME is OPTIONAL (midday default).
    // Outcomes:
    //   • receiptNo + date present → proceed (time defaulted to 12:00 when unread).
    //   • receiptNo present, date MISSING → ask the user to pick the printed date
    //     (capped at today; flows in exactly like an OCR date). Cancel → bail.
    //   • no receiptNo → genuinely unreadable → fail with a message (no rescan loop).
    // Mutates footer.date/footer.time so the rest of the save/price path uses them.
    // OCR line texts, hoisted for the bail helpers below (the `lineTexts` const lives
    // inside the try block; assigned right after OCR completes).
    let ocrLineTexts: string[] = [];
    const ensureKeyReceiptFields = async (
      footer: { receiptNo?: string | null; date?: string | null; time?: string | null } | null,
    ): Promise<boolean> => {
      // Post-mortem payload for the fail log: rows 37/38 (receipt-278's two dead scans)
      // stored only the preview message — with no OCR text there was no way to tell a
      // cropped-off date line from a garbled one. Ship the line count + tail + full text.
      const keyFieldsDiag = () => ({
        ocrLineCount: ocrLineTexts.length,
        parsedData: JSON.stringify({ footer, lineTexts: ocrLineTexts }),
      });
      // TIME IS OPTIONAL: some IKI layouts print date+time ONLY in the bottom VMI fiscal
      // line (receipt-278) — a slightly short frame loses both. The exact hour only
      // orders same-day receipts, so default to midday rather than dead-ending the scan.
      if (footer?.receiptNo && !footer.time) footer.time = '12:00';
      if (footer?.receiptNo && footer?.date) return true;
      if (footer?.receiptNo && !footer?.date) {
        // The component early-returns a full-screen loading view while `loading`
        // is true (`if (loading) return <loadingScreen>`), which UN-MOUNTS every
        // modal — including this one. Drop loading first so the date modal actually
        // renders; otherwise its promise never resolves and the screen hangs on
        // "Scanning and recognising" (the reported bug). Resume it on confirm.
        setLoading(false);
        setDateGateTemp(null); // empty field — force the user to actively pick
        const picked = await new Promise<Date | null>((resolve) => {
          dateGateResolveRef.current = resolve;
          setDateGate(true);
        });
        setDateGate(false);
        setDateGateShowPicker(false);
        dateGateResolveRef.current = null;
        if (picked) {
          setLoading(true); // resume the processing indicator for applyXResult
          const y = picked.getFullYear();
          const m = String(picked.getMonth() + 1).padStart(2, '0');
          const d = String(picked.getDate()).padStart(2, '0');
          footer.date = `${y}-${m}-${d}`;
          return true;
        }
        // dismissed without a date → can't proceed
        await bailWithLog('ocr_no_text', { ocrPreview: 'manual date entry cancelled', ...keyFieldsDiag() });
        return false;
      }
      // No receipt id → fail (no rescan loop). Include the OCR tail in the preview: the
      // key fields print at the BOTTOM, so the tail answers "cropped off or garbled?"
      // at a glance (the full text rides in parsedData).
      await bailWithLog('ocr_no_text', {
        ocrPreview:
          `missing key fields: receiptNo=- date=${footer?.date ?? '-'} time=${footer?.time ?? '-'}` +
          ` | tail: ${ocrLineTexts.slice(-8).join(' ⏎ ')}`,
        ...keyFieldsDiag(),
      });
      return false;
    };

    // A usable receipt needs at least ONE product with a COMPLETE identity — a real NAME and a
    // positive PRICE. Zero products, OR products that ALL lost their name ("?") or their price (a
    // garbled/blurred scan), means nothing actionable was recovered → bail with a "retake the
    // photo" prompt instead of saving a junk receipt. Runs BEFORE the date gate + BEFORE any
    // Receipt row is created (bailWithLog never creates one), so the failed scan never reaches the
    // DB — nothing to wipe. A garbled-but-PRESENT name still passes: that's a matching problem
    // (0 catalog matches), not a capture failure, and is not a retake case.
    const ensureHasProducts = async (products: any[], chainName: string): Promise<boolean> => {
      const list = Array.isArray(products) ? products : [];
      const hasName = (p: any) => typeof p?.name === 'string' && p.name.trim().length > 0 && p.name.trim() !== '?';
      const hasPrice = (p: any) =>
        (typeof p?.price === 'number' && p.price > 0) || (typeof p?.promoPrice === 'number' && p.promoPrice > 0);
      if (list.some((p) => hasName(p) && hasPrice(p))) return true;
      await bailWithLog('no_products', {
        detectedChainName: chainName,
        ocrLineCount: ocrLineTexts.length,
        ocrPreview: `${list.length} parsed, 0 with a complete name+price (${chainName})`,
        parsedData: JSON.stringify({ lineTexts: ocrLineTexts }),
      });
      return false;
    };

    try {
      setLoading(true);
      setLoadingMessage(t('receiptProcess.loadingScan'));
      setSkippedRegions([]); // only the IKI path repopulates this

      interface LineWithFrame {
        text: string;
        yTop: number;
        yBottom: number;
        xLeft: number;
        xRight: number;
        yLeftTop?: number;
        yRightTop?: number;
        yLeftBottom?: number;
        yRightBottom?: number;
        words?: { text: string; xLeft: number; xRight: number; yTop: number; yBottom: number; cornerPoints?: { x: number; y: number }[] }[];
      }

      const allLines: LineWithFrame[] = [];
      let combinedFrameScale = 1;
      let yOffset = 0; // running accumulator across pages in Image-pixel space
      let firstPageDims: { width: number; height: number } | null = null;
      let firstPageUri: string | null = null;
      const collectedPageMetas: PageMeta[] = [];

      for (let pageIdx = 0; pageIdx < imageUris.length; pageIdx++) {
        // Camera photos held sideways come through as landscape — rotate to
        // portrait first so the parser sees the receipt upright. No-op for
        // PDFs / screenshots that already arrive in portrait.
        const pageUri = await ensurePortraitOrientation(imageUris[pageIdx]);

        // Shared helper. Auto-tiles when the image is tall enough to hit
        // MLKit's ~4096 px soft cap (Lidl thermal receipts typically),
        // which otherwise silently halves character detail. Returns
        // lines already in page-pixel space with any per-tile offsets
        // applied, plus the pixelWidth/Height matching that space.
        const ocr = await ocrImageEnhanced(pageUri);
        const pageDims = { width: ocr.pixelWidth, height: ocr.pixelHeight };
        if (pageIdx === 0) firstPageDims = pageDims;
        if (pageIdx === 0) firstPageUri = pageUri;
        const frameScale = ocr.frameScale;
        if (pageIdx === 0) combinedFrameScale = frameScale;

        console.log(`=== PAGE ${pageIdx + 1}/${imageUris.length} ===`);
        console.log(
          `Image dims: ${pageDims.width} x ${pageDims.height}${ocr.tiled ? ` (tiled into ${ocr.tileCount})` : ''}`,
        );
        console.log(`MLKit max: ${ocr.mlkitMaxX} x ${ocr.mlkitMaxY}`);
        console.log(
          `frameScale: ${frameScale.toFixed(3)}, yOffset: ${yOffset.toFixed(0)}`,
        );

        let pageMaxYScaled = 0;
        const pageLineBounds: { l: number; r: number }[] = [];
        const offY = (v: number | undefined) => (v == null ? undefined : v + yOffset);
        for (const line of ocr.lines) {
          if (line.yBottom > pageMaxYScaled) pageMaxYScaled = line.yBottom;
          pageLineBounds.push({ l: line.xLeft, r: line.xRight });
          allLines.push({
            text: line.text,
            yTop: line.yTop + yOffset,
            yBottom: line.yBottom + yOffset,
            xLeft: line.xLeft,
            xRight: line.xRight,
            yLeftTop: offY(line.yLeftTop),
            yRightTop: offY(line.yRightTop),
            yLeftBottom: offY(line.yLeftBottom),
            yRightBottom: offY(line.yRightBottom),
            words: line.words?.map((w) => ({
              ...w, yTop: w.yTop + yOffset, yBottom: w.yBottom + yOffset,
              cornerPoints: w.cornerPoints?.map((p) => ({ x: p.x, y: p.y + yOffset })),
            })),
          });
        }

        // Receipt horizontal bounds via text-density histogram.
        // Percentile bounds fail when many "edge" lines (dividers, logos,
        // multi-line address text) reach close to the page edge — their
        // count exceeds the percentile cutoff and the crop degrades to full
        // width. Instead: bucket x into 20-px bins, count how many lines
        // cover each bin, keep bins with >=8% of peak coverage, and take
        // the outermost kept bins as the receipt column.
        // Histogram domain = pixel-space width (pageDims.width), which is
        // the same space `l`/`r` live in (frameScale was already applied).
        const BIN = 20;
        const nBins = Math.max(1, Math.ceil(pageDims.width / BIN));
        const hist = new Array(nBins).fill(0);
        for (const { l, r } of pageLineBounds) {
          const lo = Math.max(0, Math.floor(l / BIN));
          const hi = Math.min(nBins - 1, Math.floor((Math.max(l, r - 1)) / BIN));
          for (let b = lo; b <= hi; b++) hist[b]++;
        }
        const peak = hist.reduce((m, v) => Math.max(m, v), 0);
        const densityThresh = Math.max(1, peak * 0.08);
        let leftBin = 0;
        while (leftBin < nBins && hist[leftBin] < densityThresh) leftBin++;
        let rightBin = nBins - 1;
        while (rightBin >= 0 && hist[rightBin] < densityThresh) rightBin--;
        let receiptXLeftScaled = leftBin * BIN;
        let receiptXRightScaled = (rightBin + 1) * BIN;
        if (receiptXRightScaled <= receiptXLeftScaled) {
          receiptXLeftScaled = 0;
          receiptXRightScaled = pageDims.width;
        }
        console.log(
          `PAGE ${pageIdx + 1} receipt x-bounds (pixels): left=${Math.round(receiptXLeftScaled)}, right=${Math.round(receiptXRightScaled)}, pageW=${pageDims.width}, yExtent=${Math.round(pageMaxYScaled)}, yOffset=${Math.round(yOffset)}, peak=${peak}`,
        );

        collectedPageMetas.push({
          uri: pageUri,
          pixelWidth: pageDims.width,
          pixelHeight: pageDims.height,
          frameScale,
          yOffsetScaled: yOffset,
          pageMaxYScaled,
          receiptXLeftScaled,
          receiptXRightScaled,
        });

        // Offset subsequent pages by the actual scaled content extent of this
        // page (not pageDims.height, which can report a decoder-sampled size
        // smaller than the real MLKit coordinate space, causing pages to
        // overlap during merging). +50 px buffer to keep last-line-of-page-N
        // safely separated from first-line-of-page-N+1.
        yOffset += pageMaxYScaled + 50;
      }

      setPageMetas(collectedPageMetas);

      // CANONICAL IMAGE = the ROTATED page that OCR actually ran on, NOT the raw
      // capture. All region geometry (products/header/footer/masks) lives in this
      // rotated portrait space. Using the raw landscape capture here would render
      // every band in the wrong place, redact the masks at the wrong coords, and
      // upload a landscape image whose saved-receipt view can't be cropped. For a
      // portrait capture the rotated uri === the original, so this is a no-op.
      if (collectedPageMetas[0]?.uri) setImageUri(collectedPageMetas[0].uri);

      const dims = firstPageDims ?? { width: 0, height: 0 };
      setImageDims(dims);
      const frameScale = combinedFrameScale;
      allLines.sort((a, b) => a.yTop - b.yTop);

      // Detect bank/loyalty/cashier redaction boxes for the pre-upload image
      // masking. allLines are in image-pixel space, so the boxes map 1:1 onto
      // the uploaded photo (single-image; multi-page bands beyond page 0 fall
      // outside the uploaded page-0 image and are filtered at upload time).
      const detectedMaskBands = detectCardMaskBands(allLines);
      console.log(
        `[MASK] detected ${detectedMaskBands.length} band(s):`,
        detectedMaskBands.map((b) => `${b.label}@${Math.round(b.yTop)}-${Math.round(b.yBottom)}`).join(', ') || '(none)',
      );
      // SMOKING-GUN diagnostic: dump every OCR line that looks card/loyalty/
      // cashier-ish, regardless of detection result. If these lines are present
      // but `detected=0`, it's a DETECTOR bug; if they're absent, OCR never read
      // the payment section (photo cut off / blurry) → nothing to mask.
      const cardish = allLines.filter((l) =>
        /[*xX•·]{2,}|mokejim|moket|kortel|lojalum|kasin\w{0,3}k|\bbanko\b|maestro|visa|master/i.test(l.text),
      );
      console.log(
        `[MASK] card-ish OCR lines (${cardish.length}/${allLines.length} total):`,
      );
      for (const l of cardish) {
        console.log(`   y${Math.round(l.yTop)} » ${JSON.stringify(l.text)}`);
        // Per-word boxes — needed to verify the cashier mask starts at the cashier
        // value and never covers the Kvito Nr (which shares the row).
        if (l.words?.length) {
          console.log(
            `      words: ${l.words.map((w: any) => `${JSON.stringify(w.text)}[${Math.round(w.xLeft)}-${Math.round(w.xRight)}]`).join(' ')}`,
          );
        }
      }
      for (const b of detectedMaskBands.filter((b) => b.kind === 'cashier')) {
        console.log(`[MASK] cashier band x${Math.round(b.xLeft)}-${Math.round(b.xRight)} y${Math.round(b.yTop)}-${Math.round(b.yBottom)}`);
      }
      setMaskBands(detectedMaskBands);

      const mergedLines: LineWithFrame[] = [];
      const PRICE_RE = /^\d+[.,]\s?\d{2}\s*[AB]\s*$/;
      const ROW_THRESHOLD = 30 * frameScale;

      for (const line of allLines) {
        if (mergedLines.length > 0) {
          const last = mergedLines[mergedLines.length - 1];
          if (Math.abs(line.yTop - last.yTop) < ROW_THRESHOLD) {
            if (PRICE_RE.test(line.text)) {
              mergedLines.push({ ...line });
            } else if (PRICE_RE.test(last.text)) {
              mergedLines.splice(mergedLines.length - 1, 0, { ...line });
            } else {
              last.text = last.text + " " + line.text;
              last.yTop = Math.min(last.yTop, line.yTop);
              last.yBottom = Math.max(last.yBottom, line.yBottom);
              last.xLeft = Math.min(last.xLeft, line.xLeft);
              last.xRight = Math.max(last.xRight, line.xRight);
              // Carry the merged line's WORD boxes too (kept x-sorted). Without this the merged
              // line exposes only the FIRST row's words, so when MLKit fuses two STACKED print-rows
              // (dense product/payment sections on a narrow capture), the parser's word re-clustering
              // can't split them back apart and two products collapse into one (receipt-160). This
              // mirrors the shared utils/receiptOcrPipeline.ts merge, from which this copy diverged.
              if (line.words?.length) {
                last.words = [...(last.words ?? []), ...line.words].sort((a, b) => a.xLeft - b.xLeft);
              }
            }
            continue;
          }
        }
        mergedLines.push({ ...line });
      }

      const lineTexts = mergedLines.map((l) => l.text);
      ocrLineTexts = lineTexts; // expose to the bail helpers defined above the try

      // DOUBLED-SCAN gate: the camera caught the SAME receipt twice in one frame (receipt-167) — its
      // full slashed receipt number ("71/612/114973") then appears in ≥2 lines. The two copies can't
      // be reconciled: the header reads from copy 1, the products from copy 2, and the stored image
      // covers only one — so product bands land OFF-image (no crops in the Items tab) and the address
      // bands a garbled product line. Bail with a retake prompt rather than save a mangled receipt.
      // (A single receipt prints the full slashed number once; the short "Kvito numeris" form has no
      // slashes, and the terminal id "0429/0022/802" has a 3-digit tail → neither false-triggers.)
      {
        // Per-chain "this token prints exactly ONCE on a real receipt" extractors. The original
        // slashed form covers IKI/Rimi; the added forms make the gate effective for the other
        // chains too (it was silently inert there — a doubled Maxima/Lidl/Norfa frame saved a
        // mangled receipt instead of prompting a retake):
        //   Maxima  "Kvito Nr. 1234567"      — labelled, unslashed
        //   Maxima  "Dokumento numeris 123…" — alternative label
        //   Lidl    "Kvitas 47989/258"       — labelled 2-part (NOT the bare "#00NNNNN", which
        //                                      legitimately prints twice: header + VMI block)
        //   Norfa   "# Kvito numeris 123456 #"
        const ONCE_ONLY_TOKENS: RegExp[] = [
          /\b\d{2,4}\/\d{2,4}\/\d{4,8}\b/,                       // IKI/Rimi full slashed id
          /[KA][vouy]ito\s+Nr\S{0,2}\s*(\d{5,})/i,               // Maxima labelled id (stem-tolerant)
          /Dokumento\s+numeris\s*:?\s*(\d{4,})/i,                // Maxima alt label
          /\bKvitas\s+(\d{4,}\s*\/\s*\d+)/i,                     // Lidl labelled 2-part
          /#\s*Kvito\s+numeris\s+(\d{4,})\s*#/i,                 // Norfa
        ];
        const rcptTokens: string[] = [];
        for (const tx of lineTexts) {
          for (const re of ONCE_ONLY_TOKENS) {
            const m = tx.match(re);
            if (m) { rcptTokens.push((m[1] ?? m[0]).replace(/\s+/g, '')); break; }
          }
        }
        const dup = rcptTokens.find((tok, i) => rcptTokens.indexOf(tok) !== i);
        if (dup) {
          await bailWithLog("doubled_scan", { ocrPreview: `doubled scan: receiptNo ${dup} ×${rcptTokens.filter((tk) => tk === dup).length}` });
          return;
        }
      }

      if (__DEV__) {
        // DEV-only verbose OCR dump for parser debugging. Raw OCR holds pre-mask
        // PII (card / loyalty / cashier), so it must NEVER reach prod logs —
        // gate the whole thing behind __DEV__.
        console.log("=== MERGED OCR LINES ===");
        mergedLines.forEach((l, i) =>
          console.log(`${i}: [y=${Math.round(l.yTop)}] ${l.text}`),
        );
        const rawDump = lineTexts.join("\n");
        console.log(
          `=== DEDUPED RAW TEXT (${lineTexts.length} lines) ===\n` +
          rawDump +
          "\n=== END RAW TEXT ===",
        );
        // Metro truncates long logs — also drop the full raw text on the
        // clipboard so it's one paste away (no digging in the DB rawData field).
        Clipboard.setStringAsync(rawDump).catch(() => {});
        console.log(`[dev] raw OCR (${lineTexts.length} lines) copied to clipboard ✂️`);
      }

      // OCR produced nothing usable — bail before trying chain detection.
      // Empty-text check uses >= 3 lines as the threshold: a well-lit
      // receipt always emits at least the header + a couple of product
      // rows, so fewer than 3 lines means OCR effectively failed.
      if (lineTexts.filter((t) => t.trim().length > 0).length < 3) {
        await bailWithLog("ocr_no_text", {
          ocrLineCount: lineTexts.length,
          ocrPreview: lineTexts.join("\n").slice(0, 500),
        });
        return;
      }

      setLoadingMessage(t('receiptProcess.loadingScan'));

      // Chain-match gate + auto store-resolution (list-upload flow only).
      // For a multi-store group the receipt's detected chain AUTO-selects
      // which store row to link — no store-selection prompt. If the detected
      // chain matches none of the list's stores, ask before continuing (the
      // user may have shopped elsewhere — "I went to a different store"
      // override). Backing out is a retry, NOT a failure (not logged). The
      // isXReceipt checks are cheap regex; the real parse runs below regardless.
      linkListIdRef.current = fallbackLinkId;
      const expectedChainIds = Object.keys(linkMap).map(Number);
      if (expectedChainIds.length > 0) {
        const detectedChainId =
          isRimiReceipt(lineTexts) ? 2 :
          isMaximaReceipt(lineTexts) ? 1 :
          isNorfaReceipt(lineTexts) ? 4 :
          isLidlReceipt(lineTexts) ? 5 :
          isIkiReceipt(lineTexts) ? 3 :
          (detectChainByVatCode(lineTexts)?.chainId ?? null);
        if (detectedChainId != null && linkMap[detectedChainId] != null) {
          // Auto-detected store — link target resolved, no prompt.
          linkListIdRef.current = linkMap[detectedChainId];
        } else {
          const proceed = await new Promise<boolean>((resolve) => {
            chainGateResolveRef.current = resolve;
            setChainGate({ detectedChainId: detectedChainId ?? 0, expectedChainIds });
          });
          setChainGate(null);
          chainGateResolveRef.current = null;
          if (!proceed) {
            setLoading(false);
            router.replace('/(tabs)/shoppingList');
            return;
          }
          // Override: shopped at an unplanned store — fulfil the first
          // awaiting store slot of this list/group.
          linkListIdRef.current = Object.values(linkMap)[0] ?? fallbackLinkId;
        }
      }

      // Note on setLoading placement: we intentionally hold the main
      // loading overlay up through the ENTIRE applyXxxResult call.
      // Dropping it right after the early header was set used to flash
      // "Prekės (0) — prekės nerastos" to the user while per-product
      // match requests were still in flight. Keep the overlay until
      // products have been parsed + matched.
      //
      // Backup chain detection via the seller's PVM/VAT code — only consulted
      // when ALL the primary text-fingerprint detectors miss, so the normal
      // path is unchanged.
      const vatChainId =
        isRimiReceipt(lineTexts) || isMaximaReceipt(lineTexts) || isNorfaReceipt(lineTexts) ||
        isLidlReceipt(lineTexts) || isIkiReceipt(lineTexts)
          ? null
          : (detectChainByVatCode(lineTexts)?.chainId ?? null);

      if (isRimiReceipt(lineTexts) || vatChainId === 2) {
        // V2 Rimi parser does its own same-row absorption inside
        // findProductBandsInternal, so it expects RAW OCR lines.
        // The outer `mergedLines` blob fused header/product rows
        // on tight gaps and broke header detection — same class
        // of bug as Maxima below.
        const earlyHeader = parseRimiHeaderOnly(allLines);
        setHeader({
          chainName: "RIMI",
          chainId: 2,
          storeCode: earlyHeader.storeCode,
          storeAddress: earlyHeader.storeAddress,
          storeId: null,
          storeName: null,
          storeAddressMatched: null,
          matchConfidence: null,
          matchLoading: true,
          rawText: earlyHeader.rawText,
          region: earlyHeader.region,
        });

        const parsed = parseRimiReceipt(allLines);
        logParsedReview('RIMI', parsed);
        if (!(await ensureHasProducts(parsed.products, 'RIMI'))) return;
        if (!(await ensureKeyReceiptFields(parsed.footer))) { setLoading(false); return; }
        await applyRimiResult(parsed.header, parsed.products, parsed.footer);
        setLoading(false);
      } else if (isMaximaReceipt(lineTexts) || vatChainId === 1) {
        // Maxima parser does its own splitMergedLines + same-row
        // handling internally, so it expects RAW OCR lines, not the
        // outer `mergedLines` blob. Passing the merged blob caused
        // the first product's name to get glued onto the last
        // header line ("Kvitas bazėje:" + "Gira RUGILĖ" within
        // 30 px) and eaten by findHeaderEnd, leaving band 1 with
        // an empty name. Iki still consumes the merged blob
        // because its parser was tuned against that input.
        const earlyHeader = parseMaximaHeaderOnly(allLines);
        setHeader({
          chainName: "MAXIMA",
          chainId: 1,
          storeCode: earlyHeader.storeCode,
          storeAddress: earlyHeader.storeAddress,
          storeId: null,
          storeName: null,
          storeAddressMatched: null,
          matchConfidence: null,
          matchLoading: true,
          rawText: earlyHeader.rawText,
          region: earlyHeader.region,
        });

        const parsed = parseMaximaReceipt(allLines, PARSER_OPTS);
        if (__DEV__) {
          // Diagnostic: surface what the parser actually captured
          // from the footer so we can compare against the printed
          // receipt without poking the DB. Most useful when the
          // receipts list shows the wrong/missing date.
          console.log(
            "[parseMaximaReceipt] footer:",
            JSON.stringify({
              date: parsed.footer.date,
              time: parsed.footer.time,
              total: parsed.footer.total,
              receiptNo: parsed.footer.receiptNo,
              totalSavings: parsed.footer.totalSavings,
            }),
          );
        }
        logParsedReview('MAXIMA', parsed);
        if (!(await ensureHasProducts(parsed.products, 'MAXIMA'))) return;
        if (!(await ensureKeyReceiptFields(parsed.footer))) { setLoading(false); return; }
        await applyMaximaResult(parsed.header, parsed.products, parsed.footer);
        setLoading(false);
      } else if (isNorfaReceipt(lineTexts) || vatChainId === 4) {
        // Norfa V2 (hard-walled bands + per-band extract) consumes
        // RAW OCR lines — its mergeRowFragments pass needs the
        // original y-coords intact. Same reasoning as Rimi/Maxima.
        const earlyHeader = parseNorfaHeaderOnly(allLines);
        setHeader({
          chainName: "NORFA",
          chainId: 4,
          storeCode: earlyHeader.storeCode,
          storeAddress: earlyHeader.storeAddress,
          storeId: null,
          storeName: null,
          storeAddressMatched: null,
          matchConfidence: null,
          matchLoading: true,
          rawText: earlyHeader.rawText,
          region: earlyHeader.region,
        });

        const parsed = parseNorfaReceipt(allLines);
        logParsedReview('NORFA', parsed);
        if (!(await ensureHasProducts(parsed.products, 'NORFA'))) return;
        if (!(await ensureKeyReceiptFields(parsed.footer))) { setLoading(false); return; }
        await applyNorfaResult(parsed.header, parsed.products, parsed.footer);
        setLoading(false);
      } else if (isLidlReceipt(lineTexts) || vatChainId === 5) {
        // Lidl V2 (hard-walled bands + per-band extract) consumes
        // RAW OCR lines — same reasoning as Rimi/Maxima/Norfa.
        // Phone-photographed thermal print so OCR is rougher than
        // the e-receipt chains, but the V2 splitter handles the
        // head-fused / tail-fused / middle-fused-with-barcode
        // patterns MLKit emits.
        const earlyHeader = parseLidlHeaderOnly(allLines);
        setHeader({
          chainName: "LIDL",
          chainId: 5,
          storeCode: earlyHeader.storeCode,
          storeAddress: earlyHeader.storeAddress,
          storeId: null,
          storeName: null,
          storeAddressMatched: null,
          matchConfidence: null,
          matchLoading: true,
          rawText: earlyHeader.rawText,
          region: earlyHeader.region,
        });

        const parsed = parseLidlReceipt(allLines, PARSER_OPTS);
        logParsedReview('LIDL', parsed);
        if (!(await ensureHasProducts(parsed.products, 'LIDL'))) return;
        if (!(await ensureKeyReceiptFields(parsed.footer))) { setLoading(false); return; }
        await applyLidlResult(parsed.header, parsed.products, parsed.footer);
        setLoading(false);
      } else if (isIkiReceipt(lineTexts) || vatChainId === 3) {
        const earlyHeader = parseIkiHeaderOnly(mergedLines);
        setHeader({
          chainName: "IKI",
          chainId: 3,
          storeCode: earlyHeader.storeCode,
          storeAddress: earlyHeader.storeAddress,
          storeId: null,
          storeName: null,
          storeAddressMatched: null,
          matchConfidence: null,
          matchLoading: true,
          rawText: earlyHeader.rawText,
          region: earlyHeader.region,
        });

        // Capture the exact per-WORD lines the IKI column engine consumes, so a failing
        // receipt can be reproduced 1:1 in a jest fixture (the merged line text alone
        // loses the word coordinates the engine clusters on). Emitted as a TOP-LEVEL
        // `wordsDump` field in buildParsedData; feed a pasted blob to wordsToFixture.mjs.
        // wordsDump ships in staging+prod now (not __DEV__-only), so it MUST be PII-safe:
        // the card PAN / loyalty number / cashier name appear as raw words here. Redact
        // any word inside a mask band (or whose text LOOKS like a card/loyalty number) to
        // '[•••]', keeping its coordinates + corners (geometry is what the dump is for; the
        // parser skips these words anyway). The line text `t` runs through the same
        // redactReceiptText used for rawText so a full number never lands in plaintext.
        wordsDumpRef.current = mergedLines.map((l) => ({
          t: redactReceiptText(l.text),
          x: [Math.round(l.xLeft), Math.round(l.xRight)],
          y: [Math.round(l.yTop), Math.round(l.yBottom)],
          // LINE corner Ys [yLeftTop, yRightTop, yLeftBottom, yRightBottom] — the tilt
          // data the parser's de-skew consumes. Without it the off-device reparse ran
          // slope=0 and could NOT reproduce device parses (receipt-232's scramble was
          // invisible offline until this was traced by hand). Absent → omitted.
          c: l.yLeftTop != null
            ? [Math.round(l.yLeftTop), Math.round(l.yRightTop ?? l.yTop), Math.round(l.yLeftBottom ?? l.yBottom), Math.round(l.yRightBottom ?? l.yBottom)]
            : undefined,
          w: l.words?.map((w) => {
            const pii = wordCentreInMaskBand(w, detectedMaskBands) || looksLikePiiText(w.text);
            return [
              pii ? "[•••]" : w.text, Math.round(w.xLeft), Math.round(w.xRight), Math.round(w.yTop), Math.round(w.yBottom),
              // Element corners [TLx,TLy, TRx,TRy, BRx,BRy, BLx,BLy] (or undefined) — kept even when redacted.
              w.cornerPoints?.length ? w.cornerPoints.flatMap((p) => [Math.round(p.x), Math.round(p.y)]) : undefined,
            ];
          }),
        }));
        wordsSrcRef.current = "scan";

        let parsed = parseIkiReceipt(mergedLines);
        console.log(
          `[parse] IKI → ${parsed.products.length} product(s), total=${parsed.footer.total}, ` +
          `date=${parsed.footer.date}, receiptNo=${parsed.footer.receiptNo}`,
        );
        logParsedReview('IKI', parsed);
        if (!(await ensureHasProducts(parsed.products, 'IKI'))) return;
        if (!(await ensureKeyReceiptFields(parsed.footer))) { setLoading(false); return; }
        // WHOLE-SECTION PRODUCT re-OCR (flagged, Android only): when a product is a suspect
        // (dropped name "?", garbled/no price, amount-in-name, collapsed band) OR the receipt
        // doesn't reconcile beyond ~€1, the ENTIRE product section is re-cropped+upscaled+re-OCR'd
        // in one isolated pass, the fresh lines splice back in, and the WHOLE receipt re-parses (so
        // all global post-passes re-apply). Kept only if it strictly improves — fewer garbage,
        // reconciliation no worse, footer total unchanged. Fail-safe: any error/reject keeps
        // `parsed`. Whole-section (not per-band) is what fixes cross-row OCR scrambles. See
        // utils/productReocr.ts.
        if (PRODUCT_REOCR_ENABLED && Platform.OS === 'android' && firstPageUri && firstPageDims) {
          const reOcr = makeProductStripReocr(firstPageUri, firstPageDims.width, firstPageDims.height);
          let lines = mergedLines;
          // Re-OCR each receipt SECTION whose defect signal fires, in order, chaining the accepted
          // line stream. Each pass is fail-safe (rejects keep the prior parse). The defect ROUTES the
          // tool at the right section: garbled products → product strip; clean products that don't
          // reconcile → the payment block (the TOTAL is wrong, not a product); garbled address →
          // header. threshold 1.0 sits above deposit-fold noise.
          const passes: [string, () => Promise<ReocrOutcome>][] = [
            ['products', () => maybeReocrProducts(parsed, lines, reOcr, { reasons: ['no-name', 'no-price', 'amount-in-name', 'collapsed-band', 'garbled-name'] })],
            ['footer', () => maybeReocrFooter(parsed, lines, reOcr, { reconcileThreshold: 1.0 })],
            ['header', () => maybeReocrHeader(parsed, lines, reOcr)],
            ['products-recon', () => maybeReocrProducts(parsed, lines, reOcr, { reconcileThreshold: 1.0 })],
          ];
          for (const [label, run] of passes) {
            const o = await run();
            devLog(`productReocr.${label}`, { accepted: o.accepted, detail: o.detail });
            void reportReocrOutcome(parsed.footer.receiptNo, o.accepted, o.detail);
            if (o.accepted) { parsed = o.parsed; lines = o.lines; }
          }
        }
        // Option A: rebuild footer field bands (date/time/receiptNo/total) from a fresh
        // ISOLATED re-OCR of each strip — fixes guessed bands when MLKit dropped the
        // value's word boxes. Fail-safe (keeps the original band if the re-OCR misses).
        if (firstPageUri && firstPageDims) {
          parsed.footer.lineRegions = await refineFooterBands(
            firstPageUri,
            parsed.footer.lineRegions,
            { date: parsed.footer.date, time: parsed.footer.time, receiptNo: parsed.footer.receiptNo, total: parsed.footer.total },
            firstPageDims.width,
            firstPageDims.height,
          );
        }
        await applyIkiResult(parsed.header, parsed.products, parsed.footer, parsed.skippedRegions ?? []);
        setLoading(false);
      } else {
        await bailWithLog("chain_unrecognized", {
          ocrLineCount: lineTexts.length,
          ocrPreview: lineTexts.slice(0, 20).join("\n").slice(0, 500),
        });
      }
    } catch (error) {
      console.error("OCR error:", error);
      await bailWithLog("ocr_error", {
        ocrPreview: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // The store address didn't auto-match — send the user to the map
  // store-resolution screen (chain known, store not) and await their pick.
  // null = user backed out (caller bails as store_unrecognized).
  const promptStoreResolution = async (chainId: number, chainName: string, ocrAddress: string | null, rawText?: string | null) => {
    const prefill = ocrAddress || pickAddressFromRawText(rawText);
    const pending = requestStoreResolution(chainId, chainName, prefill);
    // Drop the OCR loader early-return so the modal mounts (mirrors the date gate), then
    // show the store-resolution modal on top and await the user's pick.
    setLoading(false);
    setStoreGate(true);
    const result = await pending;
    // Hide the map AND wait for its dismiss animation to complete before returning.
    // The caller may immediately show the fail modal (a cancelled pick → bailWithLog →
    // setFailGate). Presenting that transparent modal while this fullScreen map is still
    // sliding out stacks TWO modals on iOS (the map "stays" behind the fail card until
    // dismissed — the reported double-modal). onDismiss fires when the slide-out finishes;
    // a timeout backstops Android (no onDismiss) and any missed callback.
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; storeGateDismissRef.current = null; resolve(); };
      storeGateDismissRef.current = finish;
      setStoreGate(false);
      setTimeout(finish, 500);
    });
    if (result) setLoading(true); // resume the processing indicator after a pick
    return result;
  };

  const applyRimiResult = async (
    rHeader: RimiHeader,
    rProducts: RimiProduct[],
    rFooter: RimiFooter,
  ) => {
    const chainId = 2;

    let storeId: number | null = null;
    let storeName: string | null = null;
    let storeAddressMatched: string | null = null;
    let matchConfidence: number | null = null;

    if (rHeader.storeAddress) {
      try {
        const url = `${API_BASE_URL}/api/stores/match?chainId=${chainId}&address=${encodeURIComponent(rHeader.storeAddress)}`;
        const res = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_STANDARD_MS });
        const data = await res.json();
        if (data?.match) {
          storeId = data.match.storeId;
          storeName = data.match.storeName;
          storeAddressMatched = data.match.address;
          matchConfidence = data.match.confidence;
        }
      } catch (e) {
        console.warn("Store match failed:", e);
      }
    }

    // Bail if store couldn't be identified — no Receipt row is created
    // for this path. Same treatment as chain-unrecognized since an
    // un-mapped store downstream breaks price comparison and metric
    // aggregation; easier to make the user re-scan than to thread
    // a null-store receipt through the rest of the system.
    if (storeId === null) {
      const chosen = await promptStoreResolution(chainId, "RIMI", rHeader.storeAddress || null, rHeader.rawText);
      if (!chosen) {
        await bailWithLog("store_unrecognized", {
          detectedChainName: "RIMI",
          extractedStoreAddress: rHeader.storeAddress || null,
        });
        return;
      }
      storeId = chosen.storeId;
      storeName = chosen.storeName;
      storeAddressMatched = chosen.storeAddress;
      matchConfidence = 1;
    }

    setHeader({
      chainName: "RIMI",
      chainId,
      storeCode: rHeader.storeCode,
      storeAddress: rHeader.storeAddress,
      storeId,
      storeName,
      storeAddressMatched,
      matchConfidence,
      matchLoading: false,
      rawText: rHeader.rawText,
      region: rHeader.region,
      regionsVersion: REGIONS_VERSION, // fresh parse is authoritative — don't let rehydration re-OCR + clobber it
    });

    const AUTO_APPLY_THRESHOLD = RECOGNITION.match.autoApplyThreshold;

    // Initialise the loading-overlay progress counter. Each per-product
    // match promise below bumps `done` on completion so the user sees
    // "N / M prekių atpažinta" tick up instead of staring at a static
    // spinner during what can be 5-15s of sequential HTTP calls.
    setMatchProgress({ done: 0, total: rProducts.length });

    const matchPromises = rProducts.map(async (rp) => {
      let altMatches: ProductMatchOption[] = [];
      let isCrossChain = false;

      // Strip trailing size tokens from the product name so the fuzzy matcher
      // isn't biased by the number. Also extract amount/unit when present.
      // rp.parsedAmount/parsedUnit were extracted from the raw name before
      // cleanProductName stripped the size suffix — prefer them over re-parsing
      // the already-cleaned name (which would always return null for packaged goods).
      const { strippedName, amount: parsedAmountFromName, unit: parsedUnitFromName } =
        parseProductName(rp.name);

      // Rimi receipts often embed volume without a unit (e.g. "NATURĀ, 1,51"
      // means 1.51 L). When parseProductName strips a bare decimal ≤ 5 that
      // isn't an integer, infer litres — that range covers all common liquid
      // package sizes (0.25 L … 5 L) without catching gram/piece values.
      let resolvedAmount = rp.parsedAmount ?? parsedAmountFromName;
      let resolvedUnit = rp.parsedUnit ?? parsedUnitFromName;
      if (resolvedAmount === null && strippedName !== rp.name) {
        const stripped = rp.name.slice(strippedName.length).replace(/^[,\s]+/, "");
        const bare = parseFloat(stripped.replace(",", "."));
        if (
          Number.isFinite(bare) &&
          bare > 0.1 &&
          bare <= 5 &&
          !Number.isInteger(bare)
        ) {
          resolvedAmount = bare;
          resolvedUnit = "l";
        }
      }

      const matchName = strippedName || rp.name;
      // ABSURD-LENGTH guard (receipt-272): a mega-line (a phantom that glued trailer
      // text) makes the matcher score 14k candidates against a 200-char string — the
      // request runs past its timeout and the abort stalls the UI for seconds. No real
      // product name is this long; skip the match outright (the line stays unmatched).
      const absurdName = matchName.length > 80;
      if (absurdName) console.warn(`[match] skipped absurd-length name (${matchName.length} chars)`);
      // by-WEIGHT line (sold per kg) → matcher skips packaged SPs (and vice-versa).
      const wParam = rp.unit === 'kg' ? '1' : null;

      if (!absurdName) try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: matchName,
          ...(wParam ? { weighable: wParam } : {}),
        });
        const res = await fetchWithTimeout(
          `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
          {
            timeoutMs: TIMEOUT_FAST_MS,
          },
        );
        const data = await res.json();
        if (Array.isArray(data?.matches)) altMatches = data.matches;
        // Cross-chain fallback flag (whole match set): the same-chain catalog
        // returned nothing, so these candidates come from OTHER chains. Used to
        // orphan a weak (non-auto-applied) cross-chain pick — see topMatchDisplayFields.
        isCrossChain = !!data?.crossChain;
      } catch (e) {
        console.warn(`Product match failed for "${rp.name}":`, e);
      }

      const top = altMatches[0] || null;
      const autoApply = top !== null && top.confidence >= AUTO_APPLY_THRESHOLD;

      setMatchProgress((prev) =>
        prev ? { ...prev, done: prev.done + 1 } : prev,
      );

      return {
        name: matchName,
        // Weak cross-chain auto-matches are orphaned (OCR shown, candidates kept
        // for orphan-rescue); auto-matched lines start "system-verified"
        // (priceVerified=autoApply), flipped false on any user edit. See topMatchDisplayFields.
        ...topMatchDisplayFields(top, isCrossChain, autoApply),
        altMatches,
        price: rp.price,
        promoPrice: rp.promoPrice,
        quantity: rp.quantity,
        // "vnt" is the receipt quantity unit — not a product size unit.
        // Preserve "kg" for weighable products; use the extracted size unit
        // ("l", "g", …) when available; null when unknown.
        unit: rp.unit === "kg" ? "kg" : rp.unit,
        amount: resolvedAmount,
        sizeUnit: resolvedUnit,
        pricePerUnit: rp.pricePerUnit,
        rawLines: rp.rawLines,
        region: rp.region,
      } as ProductLine;
    });

    const productLines = await Promise.all(matchPromises);
    setMatchProgress(null);
    setProducts(productLines);

    setFooter({
      total: rFooter.total,
      date: rFooter.date,
      time: rFooter.time,
      receiptNo: rFooter.receiptNo,
      totalSavings: rFooter.totalSavings,
      comboDiscount: null,
      rawText: rFooter.rawText,
      region: rFooter.region,
    });
  };

  const applyMaximaResult = async (
    mHeader: MaximaHeader,
    mProducts: MaximaProduct[],
    mFooter: MaximaFooter,
  ) => {
    const chainId = 1;

    let storeId: number | null = null;
    let storeName: string | null = null;
    let storeAddressMatched: string | null = null;
    let matchConfidence: number | null = null;

    if (mHeader.storeAddress) {
      try {
        const url = `${API_BASE_URL}/api/stores/match?chainId=${chainId}&address=${encodeURIComponent(mHeader.storeAddress)}`;
        const res = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_STANDARD_MS });
        const data = await res.json();
        if (data?.match) {
          storeId = data.match.storeId;
          storeName = data.match.storeName;
          storeAddressMatched = data.match.address;
          matchConfidence = data.match.confidence;
        }
      } catch (e) {
        console.warn("Store match failed:", e);
      }
    }

    if (storeId === null) {
      const chosen = await promptStoreResolution(chainId, "MAXIMA", mHeader.storeAddress || null, mHeader.rawText);
      if (!chosen) {
        await bailWithLog("store_unrecognized", {
          detectedChainName: "MAXIMA",
          extractedStoreAddress: mHeader.storeAddress || null,
        });
        return;
      }
      storeId = chosen.storeId;
      storeName = chosen.storeName;
      storeAddressMatched = chosen.storeAddress;
      matchConfidence = 1;
    }

    setHeader({
      chainName: "MAXIMA",
      chainId,
      storeCode: mHeader.storeCode,
      storeAddress: mHeader.storeAddress,
      storeId,
      storeName,
      storeAddressMatched,
      matchConfidence,
      matchLoading: false,
      rawText: mHeader.rawText,
      region: mHeader.region,
      regionsVersion: REGIONS_VERSION, // fresh parse is authoritative — don't let rehydration re-OCR + clobber it
    });

    const AUTO_APPLY_THRESHOLD = RECOGNITION.match.autoApplyThreshold;

    setMatchProgress({ done: 0, total: mProducts.length });

    const matchPromises = mProducts.map(async (mp) => {
      let altMatches: ProductMatchOption[] = [];
      let isCrossChain = false;

      // mp.name is already cleaned (size stripped). mp.parsedAmount/parsedUnit
      // were extracted from the raw name before cleaning.
      const { strippedName } = parseProductName(mp.name);
      const matchName = strippedName || mp.name;
      // by-WEIGHT line (sold per kg) → matcher skips packaged SPs (and vice-versa).
      const wParam = mp.unit === 'kg' ? '1' : null;
      const resolvedAmount = mp.parsedAmount ?? null;
      const resolvedUnit = mp.parsedUnit ?? null;

      try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: matchName,
          ...(wParam ? { weighable: wParam } : {}),
        });
        const res = await fetchWithTimeout(
          `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
          {
            timeoutMs: TIMEOUT_FAST_MS,
          },
        );
        const data = await res.json();
        if (Array.isArray(data?.matches)) altMatches = data.matches;
        isCrossChain = !!data?.crossChain;
      } catch (e) {
        console.warn(`Product match failed for "${mp.name}":`, e);
      }

      const top = altMatches[0] || null;
      const autoApply = top !== null && top.confidence >= AUTO_APPLY_THRESHOLD;

      setMatchProgress((prev) =>
        prev ? { ...prev, done: prev.done + 1 } : prev,
      );

      return {
        name: matchName,
        // Weak cross-chain auto-matches are orphaned (OCR shown, candidates kept
        // for orphan-rescue). See topMatchDisplayFields.
        ...topMatchDisplayFields(top, isCrossChain, autoApply),
        altMatches,
        price: mp.price,
        promoPrice: mp.promoPrice,
        quantity: mp.quantity,
        unit: mp.unit === "kg" ? "kg" : mp.unit,
        amount: resolvedAmount,
        sizeUnit: resolvedUnit,
        pricePerUnit: mp.pricePerUnit,
        rawLines: mp.rawLines,
        region: mp.region,
      } as ProductLine;
    });

    const productLines = await Promise.all(matchPromises);
    setMatchProgress(null);
    setProducts(productLines);

    setFooter({
      total: mFooter.total,
      date: mFooter.date,
      time: mFooter.time,
      receiptNo: mFooter.receiptNo,
      totalSavings: mFooter.totalSavings,
      comboDiscount: null,
      rawText: mFooter.rawText,
      region: mFooter.region,
    });
  };

  const applyNorfaResult = async (
    nHeader: NorfaHeader,
    nProducts: NorfaProduct[],
    nFooter: NorfaFooter,
  ) => {
    const chainId = 4;

    let storeId: number | null = null;
    let storeName: string | null = null;
    let storeAddressMatched: string | null = null;
    let matchConfidence: number | null = null;

    if (__DEV__) {
      console.log(
        "[Norfa] storeAddress OCR =",
        JSON.stringify(nHeader.storeAddress),
      );
    }

    if (nHeader.storeAddress) {
      try {
        const url = `${API_BASE_URL}/api/stores/match?chainId=${chainId}&address=${encodeURIComponent(nHeader.storeAddress)}`;
        const res = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_STANDARD_MS });
        const data = await res.json();
        if (__DEV__) console.log("[Norfa] match response:", JSON.stringify(data));
        if (data?.match) {
          storeId = data.match.storeId;
          storeName = data.match.storeName;
          storeAddressMatched = data.match.address;
          matchConfidence = data.match.confidence;
        }
      } catch (e) {
        console.warn("Store match failed:", e);
      }
    }

    if (storeId === null) {
      const chosen = await promptStoreResolution(chainId, "NORFA", nHeader.storeAddress || null, nHeader.rawText);
      if (!chosen) {
        if (__DEV__) {
          console.log(
            "[Norfa] Header rawText (first 500 chars):\n",
            (nHeader.rawText || "").slice(0, 500),
          );
        }
        await bailWithLog("store_unrecognized", {
          detectedChainName: "NORFA",
          extractedStoreAddress: nHeader.storeAddress || null,
        });
        return;
      }
      storeId = chosen.storeId;
      storeName = chosen.storeName;
      storeAddressMatched = chosen.storeAddress;
      matchConfidence = 1;
    }

    setHeader({
      chainName: "NORFA",
      chainId,
      storeCode: nHeader.storeCode,
      storeAddress: nHeader.storeAddress,
      storeId,
      storeName,
      storeAddressMatched,
      matchConfidence,
      matchLoading: false,
      rawText: nHeader.rawText,
      region: nHeader.region,
      regionsVersion: REGIONS_VERSION, // fresh parse is authoritative — don't let rehydration re-OCR + clobber it
    });

    const AUTO_APPLY_THRESHOLD = RECOGNITION.match.autoApplyThreshold;

    setMatchProgress({ done: 0, total: nProducts.length });

    const matchPromises = nProducts.map(async (np) => {
      let altMatches: ProductMatchOption[] = [];
      let isCrossChain = false;

      const { strippedName, amount: parsedAmount, unit: parsedUnit } = parseProductName(np.name);
      const matchName = strippedName || np.name;
      // by-WEIGHT line (sold per kg) → matcher skips packaged SPs (and vice-versa).
      const wParam = np.unit === 'kg' ? '1' : null;

      try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: matchName,
          ...(wParam ? { weighable: wParam } : {}),
        });
        const res = await fetchWithTimeout(
          `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
          {
            timeoutMs: TIMEOUT_FAST_MS,
          },
        );
        const data = await res.json();
        if (Array.isArray(data?.matches)) altMatches = data.matches;
        isCrossChain = !!data?.crossChain;
      } catch (e) {
        console.warn(`Product match failed for "${np.name}":`, e);
      }

      const top = altMatches[0] || null;
      const autoApply = top !== null && top.confidence >= AUTO_APPLY_THRESHOLD;

      setMatchProgress((prev) =>
        prev ? { ...prev, done: prev.done + 1 } : prev,
      );

      return {
        name: matchName,
        // Weak cross-chain auto-matches are orphaned (OCR shown, candidates kept
        // for orphan-rescue). See topMatchDisplayFields.
        ...topMatchDisplayFields(top, isCrossChain, autoApply),
        altMatches,
        price: np.price,
        promoPrice: np.promoPrice,
        quantity: np.quantity,
        unit: np.unit === "kg" ? "kg" : np.unit,
        amount: np.parsedAmount ?? parsedAmount,
        sizeUnit: np.parsedUnit ?? parsedUnit,
        pricePerUnit: np.pricePerUnit,
        rawLines: np.rawLines,
        region: np.region,
      } as ProductLine;
    });

    const productLines = await Promise.all(matchPromises);
    setMatchProgress(null);
    setProducts(productLines);

    setFooter({
      total: nFooter.total,
      date: nFooter.date,
      time: nFooter.time,
      receiptNo: nFooter.receiptNo,
      totalSavings: nFooter.totalSavings,
      comboDiscount: null,
      rawText: nFooter.rawText,
      region: nFooter.region,
    });
  };

  const applyLidlResult = async (
    lHeader: LidlHeader,
    lProducts: LidlProduct[],
    lFooter: LidlFooter,
  ) => {
    const chainId = 5;

    let storeId: number | null = null;
    let storeName: string | null = null;
    let storeAddressMatched: string | null = null;
    let matchConfidence: number | null = null;

    if (lHeader.storeAddress) {
      try {
        const url = `${API_BASE_URL}/api/stores/match?chainId=${chainId}&address=${encodeURIComponent(lHeader.storeAddress)}`;
        const res = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_STANDARD_MS });
        const data = await res.json();
        if (data?.match) {
          storeId = data.match.storeId;
          storeName = data.match.storeName;
          storeAddressMatched = data.match.address;
          matchConfidence = data.match.confidence;
        }
      } catch (e) {
        console.warn("Store match failed:", e);
      }
    }

    if (storeId === null) {
      const chosen = await promptStoreResolution(chainId, "LIDL", lHeader.storeAddress || null, lHeader.rawText);
      if (!chosen) {
        await bailWithLog("store_unrecognized", {
          detectedChainName: "LIDL",
          extractedStoreAddress: lHeader.storeAddress || null,
        });
        return;
      }
      storeId = chosen.storeId;
      storeName = chosen.storeName;
      storeAddressMatched = chosen.storeAddress;
      matchConfidence = 1;
    }

    setHeader({
      chainName: "LIDL",
      chainId,
      storeCode: lHeader.storeCode,
      storeAddress: lHeader.storeAddress,
      storeId,
      storeName,
      storeAddressMatched,
      matchConfidence,
      matchLoading: false,
      rawText: lHeader.rawText,
      region: lHeader.region,
      regionsVersion: REGIONS_VERSION, // fresh parse is authoritative — don't let rehydration re-OCR + clobber it
    });

    const AUTO_APPLY_THRESHOLD = RECOGNITION.match.autoApplyThreshold;

    setMatchProgress({ done: 0, total: lProducts.length });

    const matchPromises = lProducts.map(async (lp) => {
      let altMatches: ProductMatchOption[] = [];
      let isCrossChain = false;

      const { strippedName, amount: parsedAmount, unit: parsedUnit } = parseProductName(lp.name);
      const matchName = strippedName || lp.name;
      // by-WEIGHT line (sold per kg) → matcher skips packaged SPs (and vice-versa).
      const wParam = lp.unit === 'kg' ? '1' : null;

      try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: matchName,
          ...(wParam ? { weighable: wParam } : {}),
        });
        const res = await fetchWithTimeout(
          `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
          {
            timeoutMs: TIMEOUT_FAST_MS,
          },
        );
        const data = await res.json();
        if (Array.isArray(data?.matches)) altMatches = data.matches;
        isCrossChain = !!data?.crossChain;
      } catch (e) {
        console.warn(`Product match failed for "${lp.name}":`, e);
      }

      const top = altMatches[0] || null;
      const autoApply = top !== null && top.confidence >= AUTO_APPLY_THRESHOLD;

      setMatchProgress((prev) =>
        prev ? { ...prev, done: prev.done + 1 } : prev,
      );

      return {
        name: matchName,
        // Weak cross-chain auto-matches are orphaned (OCR shown, candidates kept
        // for orphan-rescue). See topMatchDisplayFields.
        ...topMatchDisplayFields(top, isCrossChain, autoApply),
        altMatches,
        price: lp.price,
        promoPrice: lp.promoPrice,
        quantity: lp.quantity,
        unit: lp.unit === "kg" ? "kg" : lp.unit,
        amount: parsedAmount,
        sizeUnit: parsedUnit,
        pricePerUnit: lp.pricePerUnit,
        rawLines: lp.rawLines,
        region: lp.region,
      } as ProductLine;
    });

    const productLines = await Promise.all(matchPromises);
    setMatchProgress(null);
    setProducts(productLines);

    setFooter({
      total: lFooter.total,
      date: lFooter.date,
      time: lFooter.time,
      receiptNo: lFooter.receiptNo,
      totalSavings: lFooter.totalSavings,
      comboDiscount: null,
      rawText: lFooter.rawText,
      region: lFooter.region,
    });
  };

  const applyIkiResult = async (
    iHeader: IkiHeader,
    iProducts: IkiProduct[],
    iFooter: IkiFooter,
    iSkipped: LabeledRegion[] = [],
  ) => {
    const chainId = 3;
    setSkippedRegions(iSkipped);

    let storeId: number | null = null;
    let storeName: string | null = null;
    let storeAddressMatched: string | null = null;
    let matchConfidence: number | null = null;

    if (iHeader.storeAddress) {
      try {
        const url = `${API_BASE_URL}/api/stores/match?chainId=${chainId}&address=${encodeURIComponent(iHeader.storeAddress)}`;
        const res = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_STANDARD_MS });
        const data = await res.json();
        if (data?.match) {
          storeId = data.match.storeId;
          storeName = data.match.storeName;
          storeAddressMatched = data.match.address;
          matchConfidence = data.match.confidence;
        }
      } catch (e) {
        console.warn("Store match failed:", e);
      }
    }

    if (storeId === null) {
      const chosen = await promptStoreResolution(chainId, "IKI", iHeader.storeAddress || null, iHeader.rawText);
      if (!chosen) {
        await bailWithLog("store_unrecognized", {
          detectedChainName: "IKI",
          extractedStoreAddress: iHeader.storeAddress || null,
        });
        return;
      }
      storeId = chosen.storeId;
      storeName = chosen.storeName;
      storeAddressMatched = chosen.storeAddress;
      matchConfidence = 1;
    }

    setHeader({
      chainName: "IKI",
      chainId,
      storeCode: iHeader.storeCode,
      storeAddress: iHeader.storeAddress,
      storeId,
      // Prefer DB-matched name, fall back to OCR-extracted so the header card
      // shows something identifiable even when the store isn't in the DB yet.
      storeName: storeName ?? (iHeader.storeName || null),
      storeAddressMatched,
      matchConfidence,
      matchLoading: false,
      rawText: iHeader.rawText,
      region: iHeader.region,
      lineRegions: iHeader.lineRegions,
      // Stamp the CURRENT regions version: a FRESH live parse already produced
      // the best bands. Without this the version is undefined → the rehydration
      // effect treats every fresh scan as "stale", re-OCRs the saved (downscaled/
      // redacted) image and OVERWRITES footer.lineRegions — and that re-OCR often
      // loses the SUMA/Mokėti total band. Rehydration is only for OLD receipts
      // loaded from storage, never for what we just parsed.
      regionsVersion: REGIONS_VERSION,
    });

    const AUTO_APPLY_THRESHOLD = RECOGNITION.match.autoApplyThreshold;

    setMatchProgress({ done: 0, total: iProducts.length });

    const matchPromises = iProducts.map(async (ip) => {
      let altMatches: ProductMatchOption[] = [];
      let isCrossChain = false;

      const { strippedName, amount: parsedAmount, unit: parsedUnit } = parseProductName(ip.name);
      const matchName = strippedName || ip.name;
      // by-WEIGHT line (sold per kg) → matcher skips packaged SPs (and vice-versa).
      const wParam = ip.unit === 'kg' ? '1' : null;

      try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: matchName,
          ...(wParam ? { weighable: wParam } : {}),
        });
        const res = await fetchWithTimeout(
          `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
          {
            timeoutMs: TIMEOUT_FAST_MS,
          },
        );
        const data = await res.json();
        if (Array.isArray(data?.matches)) altMatches = data.matches;
        isCrossChain = !!data?.crossChain;
      } catch (e) {
        console.warn(`Product match failed for "${ip.name}":`, e);
      }

      const top = altMatches[0] || null;
      const autoApply = top !== null && top.confidence >= AUTO_APPLY_THRESHOLD;

      setMatchProgress((prev) =>
        prev ? { ...prev, done: prev.done + 1 } : prev,
      );

      return {
        name: matchName,
        // Weak cross-chain auto-matches are orphaned (OCR shown, candidates kept
        // for orphan-rescue). See topMatchDisplayFields.
        ...topMatchDisplayFields(top, isCrossChain, autoApply),
        altMatches,
        price: ip.price,
        promoPrice: ip.promoPrice,
        quantity: ip.quantity,
        unit: ip.unit === "kg" ? "kg" : ip.unit,
        amount: parsedAmount,
        sizeUnit: parsedUnit,
        pricePerUnit: ip.pricePerUnit,
        rawLines: ip.rawLines,
        region: ip.region,
      } as ProductLine;
    });

    const productLines = await Promise.all(matchPromises);
    setMatchProgress(null);
    setProducts(productLines);

    setFooter({
      total: iFooter.total,
      date: iFooter.date,
      time: iFooter.time,
      receiptNo: iFooter.receiptNo,
      totalSavings: iFooter.totalSavings,
      comboDiscount: iFooter.comboDiscount ?? null,
      rawText: iFooter.rawText,
      region: iFooter.region,
      lineRegions: iFooter.lineRegions,
    });
  };

  const applyGenericResult = (lines: string[]) => {
    setHeader({
      chainName: t('receiptProcess.fallbackChain'),
      chainId: null,
      storeCode: "",
      storeAddress: "",
      storeId: null,
      storeName: null,
      storeAddressMatched: null,
      matchConfidence: null,
      matchLoading: false,
      rawText: lines.slice(0, 5).join("\n"),
      region: { yTop: 0, yBottom: 0, xLeft: 0, xRight: 0 },
    });
    setProducts([]);
    setFooter({
      total: null,
      date: "",
      time: "",
      receiptNo: "",
      comboDiscount: null,
      totalSavings: null,
      rawText: lines.slice(-5).join("\n"),
      region: { yTop: 0, yBottom: 0, xLeft: 0, xRight: 0 },
    });
  };

  const isProcessing =
    !firstCompleteReached &&
    (postStatus === "pending" ||
      uploadStatus === "pending" ||
      comparisonStatus === "pending");

  // Skeleton state for the existing-receipt load path. Gated by a 150 ms
  // delay so quick loads (cached comparison + warm /receipts/:id) don't
  // strobe a skeleton frame in and out. Fresh-OCR mode keeps its own
  // `isProcessing` step overlay below — skeleton would lose the
  // step-tracking message users actually want there.
  const [showLoadSkeleton, setShowLoadSkeleton] = useState(false);
  useEffect(() => {
    if (!loading || !isExistingMode) {
      setShowLoadSkeleton(false);
      return;
    }
    const timer = setTimeout(() => setShowLoadSkeleton(true), 150);
    return () => clearTimeout(timer);
  }, [loading, isExistingMode]);

  // C2: active tab. Default Suvestinė on every fresh open; resets when
  // the user navigates away and back (the screen remounts).
  const [activeTab, setActiveTab] = useState<ReceiptTab>("suvestine");
  // Collapsing header (shop name + address/date band that hides on scroll, segmented
  // control pinned below it). The parsed receipt header is the `header` var, so the
  // controller is `headerCtl`. Switching tabs resets the scroll offset so a fresh tab
  // always opens with the header expanded.
  const headerCtl = useCollapsingHeader();
  const switchTab = useCallback((tab: ReceiptTab) => {
    headerCtl.offset.value = 0;
    setActiveTab(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Legacy-receipt region rehydration. Triggers when ANY of:
  //   1. lineRegions is missing/empty (pre-Phase-5 receipts).
  //   2. lineRegions entries lack a `kind` (Phase-5 mid-format).
  //   3. header.regionsVersion is older than REGIONS_VERSION (parser
  //      revisions that altered emitted bands — e.g. Rimi receiptNo
  //      anchored, Norfa fallback band — invalidate prior rehydrations).
  //
  // Re-OCRs the cached image, runs the chain parser, applies the
  // result locally + persists back. Runs as soon as the image URL
  // is available so backfilled values (footer.total, totalSavings)
  // are visible on EVERY tab — not just Kvitas — without waiting for
  // the user to switch. The ref guard prevents repeat attempts
  // within the same session.
  // Per-RECEIPT-ID (not a session boolean): the screen instance is reused across
  // receipt A→B navigation, so a plain boolean would rehydrate only the FIRST receipt
  // viewed and leave B's stale/kindless bands + un-backfilled values (same reuse class
  // the sibling hasLoadedExistingRef was migrated to a per-id ref for).
  const regionRehydrationTriedRef = useRef<number | null>(null);
  const sectionNeedsRehydration = (regions: LabeledRegion[] | undefined): boolean => {
    if (!regions || regions.length === 0) return true;
    return !regions.some((r) => typeof (r as { kind?: string }).kind === 'string');
  };
  useEffect(() => {
    if (regionRehydrationTriedRef.current === receiptId) return;
    if (!imageUri) return;
    if (!receiptId) return;
    if (!header || header.chainId == null) return;
    const headerNeeds = sectionNeedsRehydration(header.lineRegions);
    const footerNeeds = sectionNeedsRehydration(footer?.lineRegions);
    const versionStale = header.regionsVersion !== REGIONS_VERSION;
    if (!headerNeeds && !footerNeeds && !versionStale) return;

    regionRehydrationTriedRef.current = receiptId;
    const chainId = header.chainId;
    const targetReceiptId = receiptId;
    const targetImageUri = imageUri;
    void (async () => {
      const result = await computeRehydratedRegions(targetImageUri, chainId);

      // CONVERGENCE (idempotent reopen): the per-reopen band drift came from
      // re-deriving header/footer geometry afresh on EVERY open of a stale/kindless
      // receipt, because the version stamp only landed on re-OCR success — a failed
      // re-OCR bailed and the receipt re-fired forever. Now we ALWAYS stamp the
      // current version (success OR failure), so a receipt is re-derived at most ONCE
      // and then short-circuits like a healthy v-current one. When re-OCR is
      // unavailable, keep the stored bands and just stamp the version.
      if (!result) {
        setHeader((h) => (h ? { ...h, regionsVersion: REGIONS_VERSION } : h));
        void markRegionsVersionCurrent(targetReceiptId);
        return;
      }
      // Region overwrite ONLY when the stored bands are unusable (missing/
      // kindless). A re-OCR of the uploaded image lands in a slightly different
      // pixel scale than the STORED product/mask bands (which we don't re-derive),
      // so overwriting just header/footer with re-OCR'd regions visibly misaligns
      // them against the products. When the stored regions are already kinded we
      // KEEP them — same coordinate space as the products — and still backfill the
      // re-parsed VALUES (total/date/…) + bump the version below. The overwrite
      // makes the bands kinded, so next reopen Needs=false → no further re-derive.
      // Which sections do we ADOPT the re-OCR'd geometry for? Same test the state
      // updates below use. ONLY adopted sections may be persisted — a section whose
      // stored bands we KEEP must not overwrite the DB with the re-OCR set (which lands
      // in a slightly different pixel scale). That per-open overwrite of good bands with
      // the misaligned re-OCR set WAS the downward band drift seen after a restart.
      const headerAdopted = headerNeeds && result.headerLineRegions.length > 0;
      const hadFooterTotal = (footer?.lineRegions ?? []).some((r) => r.kind === 'total');
      const willHaveFooterTotal = result.footerLineRegions.some((r) => r.kind === 'total');
      const footerAdopted =
        footerNeeds && result.footerLineRegions.length > 0 && (willHaveFooterTotal || !hadFooterTotal);

      setHeader((h) => {
        if (!h) return h;
        const next: HeaderData = { ...h, regionsVersion: REGIONS_VERSION };
        if (headerAdopted) {
          next.lineRegions = result.headerLineRegions;
        }
        return next;
      });
      setFooter((f) => {
        if (!f) return f;
        const next: FooterData = { ...f };
        // Only adopt re-OCR'd regions when the stored footer bands are unusable, so
        // they stay in the products' coordinate space. footerAdopted also guards
        // against replacing a total band we have with a re-OCR set that lost it.
        if (footerAdopted) {
          next.lineRegions = result.footerLineRegions;
        }
        // Re-parse is authoritative when it produced a value (number
        // or non-empty string). Covers three scenarios:
        //   1. Stored value is null (original parse failed — e.g. OCR
        //      diacritic variant) → backfill.
        //   2. Stored value is non-null but stale/wrong (got persisted
        //      by a buggy older parser revision) → overwrite, because
        //      the REGIONS_VERSION bump is the "re-derive everything"
        //      trigger.
        //   3. Receipt row's image got swapped (dev batch tool re-
        //      stages the same filename, or another flow points two
        //      rows at the same filePath) → identity fields drift
        //      from the image; backfilling receiptNo/date/time
        //      from the re-parse converges them back.
        // When re-parse field is null/empty we leave the existing
        // value untouched so a transient OCR miss can't wipe data.
        if (typeof result.total === 'number') {
          next.total = result.total;
        }
        if (typeof result.totalSavings === 'number') {
          next.totalSavings = result.totalSavings;
        }
        if (typeof result.receiptNo === 'string' && result.receiptNo.length > 0) {
          next.receiptNo = result.receiptNo;
        }
        if (typeof result.date === 'string' && result.date.length > 0) {
          next.date = result.date;
        }
        if (typeof result.time === 'string' && result.time.length > 0) {
          next.time = result.time;
        }
        return next;
      });
      // Persist ONLY the geometry we adopted. For a section we KEPT, send an empty
      // array — the server skips the lineRegions overwrite (keeps the stored bands,
      // see updateReceiptRegions) and applies just the backfilled values + version
      // stamp. This makes reopen idempotent and kills the per-reopen downward drift.
      void persistRehydratedRegions(targetReceiptId, {
        ...result,
        headerLineRegions: headerAdopted ? result.headerLineRegions : [],
        footerLineRegions: footerAdopted ? result.footerLineRegions : [],
      });
    })();
  }, [imageUri, receiptId, header, footer]);

  // C5 pull-down gesture was removed (Android default ScrollView doesn't
  // surface negative scroll offsets, so the iOS-only bounce mechanic
  // didn't work cross-platform). The receipt image now lives inline at
  // the top of the Kvitas tab via <ReceiptPhotoView>.
  const hasAsyncError =
    postStatus === "error" ||
    uploadStatus === "error" ||
    comparisonStatus === "error";

  usePreventRemove(isProcessing, ({ data }) => {
    Alert.alert(
      t('receiptProcess.leaveProcessingTitle'),
      t('receiptProcess.leaveProcessingBody'),
      [
        { text: t('receiptProcess.leaveWait'), style: "cancel", onPress: () => {} },
        {
          text: t('receiptProcess.leaveAction'),
          style: "destructive",
          onPress: () => navigation.dispatch(data.action),
        },
      ],
    );
  });

  // Mandatory-swipe phase: the swipe cards ARE this screen for the duration. When
  // the session finishes (onAllDone) or the user backs out (onExit) we run the
  // queued continuation and flip back to the detail render below. <SwipeQueue>
  // owns its own header, loader, crops and per-receipt advance internally.
  if (swiping && swipingReceiptId != null) {
    return (
      <SwipeQueue
        receiptIds={[String(swipingReceiptId)]}
        voluntary={false}
        renderHeader
        // FRESH-SCAN FAST PATH: hand the swipe screen the OCR-canonical page images we
        // JUST produced (and are uploading to MinIO) so the Card-B band crop renders
        // instantly from local files instead of waiting on the async upload + a ~14s
        // GET /image download-retry ladder. receiptId-tagged so a stale image from a
        // previous receipt can't be reused; empty on reopen (pageMetas cleared) → the
        // swipe screen falls back to the download path.
        localPages={
          pageMetas.length > 0
            ? { receiptId: String(swipingReceiptId), pages: pageMetas }
            : null
        }
        onAllDone={leaveSwipePhase}
        onExit={leaveSwipePhase}
        // LIVE patch: a Card-B vote ('different' demotes to OCR, identical/similar
        // confirm) updates this row immediately so flipping back to the detail shows
        // the resolved state — no wait for the focus re-sync on reopen. Guarded by the
        // active receipt id (the swipe phase is single-receipt).
        onLineResolved={(rid, lineIdx, live) => {
          if (String(rid) !== String(swipingReceiptId) || !live) return;
          setProducts(prev => prev.map((p, i) => i === lineIdx ? {
            ...p,
            storeProductId: live.storeProductId ?? null,
            matchedName: live.matchedName ?? null,
            storeProductImageUrl: live.storeProductImageUrl ?? null,
            matchConfidence: typeof live.matchConfidence === 'number' ? live.matchConfidence : null,
            matchConfirmed: !!live.matchConfirmed,
            priceVerified: !!live.priceVerified,
            itemConfidence: live.itemConfidence && typeof live.itemConfidence.band === 'string'
              ? (live.itemConfidence as ItemConfidence)
              : null,
            categoryId: live.categoryId ?? null,
            categoryName: live.categoryName ?? null,
            categoryL2Name: live.categoryL2Name ?? null,
          } : p));
        }}
      />
    );
  }

  if (loading) {
    // ONE unified loader — identical to the POST/upload overlay below and the swipe-queue
    // loader. The headline reflects the CURRENT action (reading vs matching); the sub-step
    // carries the live match counter when matching.
    const matching = !!(matchProgress && matchProgress.total > 0);
    return (
      <View style={styles.loadingContainer}>
        <ProcessingLoader
          stage={matching ? "matching" : "scanning"}
          subStep={matching ? t('receiptProcess.matchProgress', { done: matchProgress!.done, total: matchProgress!.total }) : null}
        />
      </View>
    );
  }

  // Which action the POST/upload/comparison overlay reflects right now.
  const processingStage: LoadingStage = postStatus === "pending"
    ? "sending"
    : uploadStatus === "pending"
    ? "uploading"
    : "comparing";

  // Collapsing-header title band: shop name + "address · date" (same ScreenHeading
  // every screen uses). The segmented control is the pinned section below it.
  const headerShopLine = isPreviewMode
    ? t('receiptProcess.titlePreview')
    : header?.storeName || header?.chainName || t('receiptProcess.title');
  const headerSubtitle = isPreviewMode
    ? undefined
    : [header?.storeAddressMatched || header?.storeAddress || null, footer?.date ? formatDate(footer.date) : null]
        .filter(Boolean)
        .join(" · ") || undefined;

  return (
    <>
      <CollapsingHeader
        controller={headerCtl}
        back
        background={colors.cardBackground}
        collapsing={<ScreenHeading title={headerShopLine} subtitle={headerSubtitle} />}
        // Segmented control stays pinned below the collapsing title so tabs are
        // always reachable while the body scrolls.
        pinned={
          <SegmentedControl
            active={activeTab}
            onChange={switchTab}
            productCount={products.length}
            styles={styles}
            colors={colors}
          />
        }
      />

      {/* ───── TAB: Suvestinė ───── */}
      {activeTab === "suvestine" && (
      <Animated.ScrollView
        {...headerCtl.scroll}
        style={styles.container}
        contentContainerStyle={{ paddingTop: headerCtl.paddingTop }}
      >
        {showLoadSkeleton ? (
          <View style={styles.sectionCard}>
            <SkeletonBox width="55%" height={16} borderRadius={6} />
            <View style={{ height: 18 }} />
            <SkeletonBox width="35%" height={28} borderRadius={6} />
            <View style={{ height: 4 }} />
            <SkeletonBox width="50%" height={12} borderRadius={6} />
            <View style={{ height: 18 }} />
            <SkeletonBox width="100%" height={56} borderRadius={12} />
            <View style={{ height: 8 }} />
            <SkeletonBox width="100%" height={56} borderRadius={12} />
            <View style={{ height: 8 }} />
            <SkeletonBox width="100%" height={56} borderRadius={12} />
          </View>
        ) : (
        <>
        <ReceiptComparisonSection
          comparison={comparison}
          loading={comparisonLoading && !comparison || comparisonStatus === "error"}
          error={null}
          summary={{
            // Prefer "Chain · Store" when both are known; fall back to chain
            // alone (better than "Neatpažinta" when we at least identified
            // the chain), then to the comparison source, then the last-resort
            // placeholder.
            shopName:
              (header?.chainName && header?.storeName
                ? `${header.chainName} · ${header.storeName}`
                : header?.storeName || header?.chainName) ||
              comparison?.currentChain.storeName ||
              t('receiptProcess.unknownStore'),
            shopAddress:
              header?.storeAddressMatched ||
              header?.storeAddress ||
              comparison?.currentChain.storeAddress ||
              null,
            productCount: products.length,
            receiptDate: footer?.date || null,
            storeRecognized: !!header?.storeId,
          }}
        />

        {/* Swipe-to-help entry point. Hidden when the queue is fully
            drained (swipeQueueFetched && swipeQueueCount === 0) so the
            CTA doesn't lie to users who already did the work. While the
            count is still loading (first 2 s after focus, see swipe-
            queue fetch), render optimistically — if the receipt actually
            has no work, the card disappears on its own once the fetch
            lands. Preview mode never persists, so the CTA isn't shown
            there either. */}
        {receiptId && (!swipeQueueFetched || swipeQueueCount > 0) && (
          <TouchableOpacity
            style={styles.swipeEntryCard}
            activeOpacity={0.85}
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              // Open the voluntary queue scoped to THIS receipt. Spec:
              // 3+3+3+1 cap (capVoluntaryQueue). The previous params
              // `{ standalone: "1" }` didn't match any mode the queue
              // screen handles, so taps landed on an empty "Ačiū!"
              // screen instantly.
              router.push({
                pathname: "/swipe/queue",
                params: { receiptId: String(receiptId), voluntary: "1" },
              } as any);
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.swipeEntryCta}>{t('receiptProcess.swipeEntryCta')}</Text>
              <Text style={styles.swipeEntryCount}>
                {swipeQueueFetched && swipeQueueCount > 0
                  ? t('receiptProcess.swipeEntryCount', { count: swipeQueueCount })
                  : t('receiptProcess.swipeEntryShort')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={22} color={colors.onPrimary} />
          </TouchableOpacity>
        )}

        {/* (header-region preview removed — the only consumer of
            editingSection === "header" had no path to ever flip the state
            to that value, leaving this branch unreachable. Header info
            now lives in the navbar; the dev-only OCR-debug crop is
            still available on the Kvitas footer card.) */}

        {/* C3: per-category spending breakdown */}
        <ReceiptCategoryBreakdown products={products} receiptId={receiptId} />
        </>
        )}
        <View style={{ height: 40 }} />
      </Animated.ScrollView>
      )}

      {/* ───── TAB: Prekės ───── */}
      {activeTab === "prekes" && (
      <Animated.ScrollView
        {...headerCtl.scroll}
        style={styles.container}
        contentContainerStyle={{ paddingTop: headerCtl.paddingTop }}
      >
        {showLoadSkeleton ? (
          <View style={styles.sectionCard}>
            <SkeletonBox width="40%" height={16} borderRadius={6} />
            <View style={{ height: 14 }} />
            {[0, 1, 2, 3].map((i) => (
              <View
                key={i}
                style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 }}
              >
                <SkeletonBox width={44} height={44} borderRadius={8} />
                <View style={{ flex: 1, gap: 6 }}>
                  <SkeletonBox width="70%" height={13} borderRadius={6} />
                  <SkeletonBox width="40%" height={11} borderRadius={6} />
                </View>
                <SkeletonBox width={54} height={14} borderRadius={6} />
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.prekesListWrap}>
            {(products.length === 0 || (IS_PROD && products.every(isMessedUp))) ? (
              <View style={styles.emptyProducts}>
                <Ionicons name="alert-circle-outline" size={32} color={colors.border} />
                <Text style={styles.emptyText}>{t('receiptProcess.productsEmpty')}</Text>
              </View>
            ) : (
              products.map((product, index) => {
              // PRODUCTION: hide a "messed up" (band-S3) line entirely. Keep the map over the full
              // `products` array (returning null) so every other row's `index` — used by the edit /
              // menu / rematch handlers — stays correct. dev/staging fall through and render it
              // with a marker (below).
              if (IS_PROD && isMessedUp(product)) return null;
              // B3: three visual states drive border / background.
              //   S1 confirmed  — matchConfirmed=true. Clean white, soft-accent border.
              //   S3 partial    — line parsed but no SP match. warning border + tint.
              //   S4 unrecognised — no name structure or no data. error border + tint, muted thumb, "—" price.
              const isUnrecognised = isCompletelyUnrecognized(product);
              const state: "S1" | "S3" | "S4" = product.matchConfirmed
                ? "S1"
                : isUnrecognised
                ? "S4"
                : "S3";
              // Per-line confidence band (DISPLAY-ONLY). When CONFIDENCE_BAND_DISPLAY
              // is on AND the server scored this line, the band — not the legacy
              // matchConfirmed flag — decides whether we trust the SP name/image
              // (S1) or fall back to the OCR text with a review nudge (S2) / alone
              // (S3). Off by default until thresholds are calibrated, so showSpInfo
              // stays bit-identical to the old `state === "S1"`. The `state`-driven
              // borders/placeholders/price below are unchanged (parse quality, not
              // identity confidence).
              const ic = product.itemConfidence ?? null;
              const useBand = CONFIDENCE_BAND_DISPLAY && ic != null;
              const showSpInfo = useBand ? ic!.band === "S1" : state === "S1";
              const showReviewBadge = useBand && ic!.band === "S2";
              const totalPrice =
                product.promoPrice != null && product.promoPrice < product.price
                  ? product.promoPrice * product.quantity
                  : product.price * product.quantity;
              const grossTotal = product.price * product.quantity;
              return (
              <TouchableOpacity
                key={index}
                style={[
                  styles.productRowCard,
                  index === 0 && styles.productRowCardFirst,
                  index === products.length - 1 && !(footer?.comboDiscount) && styles.productRowCardLast,
                  state === "S3" && styles.productRowCardS3,
                  state === "S4" && styles.productRowCardS4,
                ]}
                activeOpacity={canExpandProduct(product) ? 0.7 : 1}
                onPress={
                  canExpandProduct(product)
                    ? () => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                        setEditingSection(
                          editingSection === index ? null : index,
                        );
                      }
                    : undefined
                }
              >
                {/* Dev-only band crop: shows the OCR region this row's
                    data was extracted from, sliced from the receipt
                    image. Gated by __DEV__ so release bundles strip
                    the entire branch at Metro bundle time. Uses the
                    sharper pre-crop component — RegionPreview's
                    overflow-trick produced unreadable mush on Android
                    for narrow product bands. */}
                {__DEV__ &&
                  pageMetas.length > 0 &&
                  product.region &&
                  product.region.yBottom > product.region.yTop && (
                    <View style={styles.productBandCropWrap}>
                      <BandCropImage
                        pages={pageMetas}
                        region={product.region}
                        cardWidth={CARD_WIDTH}
                      />
                    </View>
                  )}
                <View style={styles.productRow}>
                  {showSpInfo && product.storeProductImageUrl ? (
                    <Image
                      source={{ uri: product.storeProductImageUrl }}
                      style={styles.productThumb}
                      resizeMode="contain"
                    />
                  ) : (
                    <View
                      style={[
                        styles.productThumbPlaceholder,
                        state === "S4" && styles.productThumbPlaceholderMuted,
                      ]}
                    >
                      <Text style={styles.productThumbEmoji}>🫜</Text>
                    </View>
                  )}
                  <View style={styles.productInfo}>
                    {/* Name typography: matched products use the primary
                        colour ("matched"), partial / unrecognised stay
                        textPrimary. Inline state icons removed — the
                        row's border + background communicate state now. */}
                    {showSpInfo && product.matchedName ? (
                      <Text style={styles.matchedName} numberOfLines={2}>
                        {product.matchedName}
                      </Text>
                    ) : (
                      <Text style={styles.productName} numberOfLines={2}>
                        {product.name}
                      </Text>
                    )}
                    <Text style={styles.productQuantity}>
                      {formatAmountLabel(product)}
                    </Text>
                    {/* S2 review nudge (user-facing, behind the flag): OCR name is
                        shown but the matched SP wants a human glance. */}
                    {showReviewBadge && ic && (
                      <ConfidenceBadge ic={ic} colors={colors} variant="review" />
                    )}
                    {/* Dev-only band readout — always on in dev builds so we can
                        watch the score on-device while calibrating. Stripped from
                        release bundles by __DEV__. */}
                    {__DEV__ && ic && (
                      <ConfidenceBadge ic={ic} colors={colors} variant="dev" />
                    )}
                    {/* dev/staging marker: this low-confidence line WOULD be hidden on production. */}
                    {!IS_PROD && isMessedUp(product) && (
                      <View style={styles.prodSkipBadge}>
                        <Ionicons name="eye-off-outline" size={11} color={colors.warning} />
                        <Text style={styles.prodSkipBadgeText}>{t('receiptProcess.prodSkipBadge')}</Text>
                      </View>
                    )}
                    {/* Re-verification pending: this match contradicts one of the user's old
                        'different' votes; the rejection is SUSPENDED and the pair is queued
                        as a priority swipe card. The chip keeps the open question visible. */}
                    {product.pendingReverification && (
                      <View style={styles.prodSkipBadge}>
                        <Ionicons name="help-circle-outline" size={11} color={colors.warning} />
                        <Text style={styles.prodSkipBadgeText}>{t('receiptProcess.reverifyBadge')}</Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.productPriceCol}>
                    {/* Show the OCR-captured price whenever we HAVE one — even for an
                        unrecognised (S4) line: the price is a real receipt fact, only the
                        product IDENTITY is unknown. "—" only when there is genuinely no
                        price (footer junk / an unrecoverable weighed €/kg → price 0). */}
                    {totalPrice > 0 ? (
                      product.promoPrice != null && product.promoPrice < product.price ? (
                        <>
                          <Text style={styles.productPrice}>{formatEuro(totalPrice)}</Text>
                          <Text style={styles.productPriceStrike}>{formatEuro(grossTotal)}</Text>
                        </>
                      ) : (
                        <Text style={styles.productPrice}>{formatEuro(totalPrice)}</Text>
                      )
                    ) : (
                      <Text style={styles.productPrice}>—</Text>
                    )}
                  </View>
                  <TouchableOpacity
                    style={styles.productRowMenuBtn}
                    onPress={(e) => {
                      e.stopPropagation?.();
                      Haptics.selectionAsync().catch(() => {});
                      setMenuOpenForIndex(index);
                    }}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Ionicons
                      name="ellipsis-vertical"
                      size={18}
                      color={colors.textSecondary}
                    />
                  </TouchableOpacity>
                </View>
                {editingSection === index && canExpandProduct(product) && (
                  <View style={styles.editSection}>
                    {isCompletelyUnrecognized(product) && (
                      <View style={styles.unrecognizedBlock}>
                        <Text style={styles.editLabel}>OCR pavadinimas</Text>
                        <View style={styles.editInputLoaderWrap}>
                          <TextInput
                            style={[
                              styles.editInput,
                              styles.editInputWithLoaderPadding,
                            ]}
                            value={product.name}
                            onChangeText={(text) => {
                              setProducts((prev) => {
                                const updated = [...prev];
                                updated[index] = {
                                  ...updated[index],
                                  name: text,
                                };
                                return updated;
                              });
                              scheduleManualRematch(index, text);
                            }}
                            placeholder={t('receiptProcess.namePlaceholder')}
                            placeholderTextColor={colors.textMuted}
                          />
                          {rematchLoadingByIndex[index] && (
                            <MaterialProgress
                              size="small"
                              color={colors.primary}
                              style={styles.editInputLoader}
                            />
                          )}
                        </View>
                      </View>
                    )}

                    {/* Raw OCR region preview — dev-only surface, gated by
                        DEV_MODE so end users don't see it. Useful for
                        debugging parser/geometry issues against the source
                        image. */}
                    {DEV_MODE && pageMetas.length > 0 && (
                      <View style={styles.regionPreviewWrap}>
                        <Text style={styles.rawTextLabel}>
                          Nuskaitytas regionas (dev):
                        </Text>
                        <RegionPreview
                          pages={pageMetas}
                          region={product.region}
                          cardWidth={CARD_WIDTH - 40}
                        />
                      </View>
                    )}
                  </View>
                )}
              </TouchableOpacity>
              );
              })
            )}
            {/* Receipt-level set-deal discount (IKI bare "RINKINYS") — an ADJUSTMENT row,
                not a product: no SP match, no price writes; the server subtracts it from
                savings and the visited-store comparison total. Rendered last so the paid
                total story is complete on this tab. */}
            {footer?.comboDiscount != null && footer.comboDiscount > 0 && (
              <View style={[styles.productRowCard, styles.productRowCardLast]}>
                <View style={styles.productRow}>
                  <View style={styles.productThumbPlaceholder}>
                    <Text style={styles.productThumbEmoji}>🏷️</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.productName} numberOfLines={1}>
                      {t('receiptProcess.comboDiscount')}
                    </Text>
                  </View>
                  <View style={styles.productPriceCol}>
                    <Text style={styles.productPrice}>−{formatEuro(footer.comboDiscount)}</Text>
                  </View>
                </View>
              </View>
            )}
          </View>
        )}
        <View style={{ height: 40 }} />
      </Animated.ScrollView>
      )}

      {/* ───── TAB: Kvitas ─────
          Stat grid card on top (Suma · Laikas · Kvito №) followed by
          the receipt photo with parser-region overlays. The dev-only
          chevron-to-reveal-OCR-region was dropped — the photo + bands
          are now the user-facing visual artifact, no separate dev path. */}
      {activeTab === "kvitas" && (
      <Animated.ScrollView
        {...headerCtl.scroll}
        style={styles.container}
        contentContainerStyle={{ paddingTop: headerCtl.paddingTop }}
      >
        {showLoadSkeleton ? (
          <View style={styles.sectionCard}>
            <SkeletonBox width="35%" height={16} borderRadius={6} />
            <View style={{ height: 14 }} />
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              {[0, 1, 2].map((i) => (
                <View key={i} style={{ alignItems: "center", flex: 1, gap: 6 }}>
                  <SkeletonBox width="60%" height={20} borderRadius={6} />
                  <SkeletonBox width="50%" height={10} borderRadius={4} />
                </View>
              ))}
            </View>
          </View>
        ) : (
          <>
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeader}>
                <Ionicons name="document-text-outline" size={20} color={colors.primary} />
                <Text style={styles.sectionTitle}>{t('summary.footerTitle')}</Text>
              </View>
              <FooterStatGrid footer={footer} comparison={comparison} styles={styles} />
            </View>
            <ReceiptPhotoView
              imageUri={imageUri}
              imageDims={imageDims}
              loading={imageLoading}
              headerRegions={
                header?.lineRegions && header.lineRegions.length > 0
                  ? header.lineRegions
                  : header?.region
                  ? [header.region]
                  : []
              }
              // Prod-hide parity: a line hidden from the Items list (isMessedUp) must not
              // leave its green band on the photo either — dev/staging still draw it.
              productRegions={products
                .filter((p) => !(IS_PROD && isMessedUp(p)))
                .map((p) => p.region)
                .filter(Boolean)}
              skippedRegions={skippedRegions}
              footerRegions={
                footer?.lineRegions && footer.lineRegions.length > 0
                  ? footer.lineRegions
                  : footer?.region
                  ? [footer.region]
                  : []
              }
              maskRegions={maskBandsClamped}
              // Fresh scan: draw the overlay over the un-redacted camera image. Saved
              // receipt: the displayed image is already burned-in, so skip the overlay
              // entirely — that's the warm-reopen "stray black band" the user hit.
              drawMasks={!isExistingMode}
            />
          </>
        )}
        <View style={{ height: 40 }} />
      </Animated.ScrollView>
      )}
      {isProcessing && (
        <View style={styles.processingOverlay} pointerEvents="auto">
          <View style={styles.processingCard}>
            <ProcessingLoader stage={processingStage} />
          </View>
        </View>
      )}

      {/* Per-row three-dots action menu. Sits as a modal sheet so it doesn't
          interfere with the ScrollView above. */}
      <Modal
        visible={menuOpenForIndex !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpenForIndex(null)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setMenuOpenForIndex(null)}
        >
          <Pressable style={styles.sheetCard} onPress={() => {}}>
            {menuOpenForIndex !== null &&
              (() => {
                const target = products[menuOpenForIndex];
                if (!target) return null;
                const hasImage =
                  !!target.storeProductImageUrl &&
                  String(target.storeProductImageUrl).length > 0;
                // Only offer photo upload for matched lines that don't yet
                // have an image. Unrecognized lines have no StoreProduct to
                // attach to — showing the option would just confuse.
                const canAddPhoto = !!target.storeProductId && !hasImage;
                return (
                  <>
                    {canAddPhoto && (
                      <TouchableOpacity
                        style={styles.sheetItem}
                        onPress={() => {
                          const idx = menuOpenForIndex;
                          setMenuOpenForIndex(null);
                          if (idx !== null) handleAddProductPhoto(idx);
                        }}
                      >
                        <Ionicons name="camera-outline" size={20} color={colors.textPrimary} />
                        <Text style={styles.sheetItemText}>{t('receiptProcess.addPhoto')}</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={styles.sheetItem}
                      onPress={() => {
                        const idx = menuOpenForIndex;
                        setMenuOpenForIndex(null);
                        setIssueFlags({ name: false, price: false, amount: false, discount: false, image: false });
                        if (idx !== null) setIssueModalForIndex(idx);
                      }}
                    >
                      <Ionicons name="flag-outline" size={20} color={colors.textPrimary} />
                      <Text style={styles.sheetItemText}>Neteisingi duomenys</Text>
                    </TouchableOpacity>
                    {!!target.storeProductId && (
                      <TouchableOpacity
                        style={styles.sheetItem}
                        onPress={() => {
                          const idx = menuOpenForIndex;
                          setMenuOpenForIndex(null);
                          if (idx === null) return;
                          Alert.alert(
                            'Netinkamas produktas?',
                            'Susiejimas su šiuo produktu bus pašalintas.',
                            [
                              { text: t('common.cancel'), style: 'cancel' },
                              { text: 'Pašalinti', style: 'destructive', onPress: () => handleRejectMatch(idx) },
                            ],
                          );
                        }}
                      >
                        <Ionicons name="close-circle-outline" size={20} color={colors.textPrimary} />
                        <Text style={styles.sheetItemText}>Netinkamas produktas</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={[styles.sheetItem, styles.sheetCancel]}
                      onPress={() => setMenuOpenForIndex(null)}
                    >
                      <Text style={styles.sheetCancelText}>{t('common.cancel')}</Text>
                    </TouchableOpacity>
                  </>
                );
              })()}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Issue-reporting modal — 4 checkboxes + Siųsti. */}
      <Modal
        visible={issueModalForIndex !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setIssueModalForIndex(null)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setIssueModalForIndex(null)}
        >
          <Pressable style={styles.issueModalCard} onPress={() => {}}>
            <Text style={styles.issueModalTitle}>Kas neteisinga?</Text>
            {(
              [
                { key: "name",     label: "Neteisingas pavadinimas" },
                { key: "price",    label: "Neteisinga kaina" },
                { key: "amount",   label: "Neteisingas kiekis" },
                { key: "discount", label: "Neteisinga nuolaida" },
                { key: "image",    label: "Neteisinga nuotrauka" },
              ] as const
            ).map(({ key, label }) => (
              <TouchableOpacity
                key={key}
                style={styles.checkboxRow}
                onPress={() =>
                  setIssueFlags((prev) => ({ ...prev, [key]: !prev[key] }))
                }
              >
                <Ionicons
                  name={issueFlags[key] ? "checkbox" : "square-outline"}
                  size={22}
                  color={issueFlags[key] ? colors.primary : colors.textSecondary}
                />
                <Text style={styles.checkboxLabel}>{label}</Text>
              </TouchableOpacity>
            ))}
            <View style={styles.issueModalBtnRow}>
              <TouchableOpacity
                style={[styles.issueModalBtn, styles.issueModalBtnSecondary]}
                onPress={() => setIssueModalForIndex(null)}
              >
                <Text style={styles.issueModalBtnTextSecondary}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.issueModalBtn,
                  styles.issueModalBtnPrimary,
                  !anyIssueChecked(issueFlags) && styles.issueModalBtnDisabled,
                ]}
                disabled={!anyIssueChecked(issueFlags)}
                onPress={() => {
                  const idx = issueModalForIndex;
                  if (idx !== null) submitIssueReport(idx, issueFlags);
                  setIssueModalForIndex(null);
                }}
              >
                <Text style={styles.issueModalBtnTextPrimary}>{t('receiptProcess.send')}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Chain-match gate (list-upload flow): receipt's chain ≠ list's store. */}
      <Modal
        visible={chainGate !== null}
        transparent
        animationType="fade"
        onRequestClose={() => chainGateResolveRef.current?.(false)}
      >
        <View style={styles.chainGateBackdrop}>
          <View style={styles.chainGateCard}>
            <Ionicons name="alert-circle-outline" size={40} color={colors.warning} />
            <Text style={styles.chainGateTitle}>{t('receiptProcess.chainGateTitle')}</Text>
            <Text style={styles.chainGateBody}>
              {t('receiptProcess.chainGateBody', {
                detected: chainGate?.detectedChainId ? (CHAIN_NAMES[chainGate.detectedChainId] ?? '?') : '?',
                expected: chainGate ? chainGate.expectedChainIds.map((c) => CHAIN_NAMES[c] ?? '?').join(' / ') : '',
              })}
            </Text>
            <TouchableOpacity style={styles.chainGatePrimary} onPress={() => chainGateResolveRef.current?.(true)}>
              <Text style={styles.chainGatePrimaryText}>{t('receiptProcess.chainGateDifferentStore')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.chainGateSecondary} onPress={() => chainGateResolveRef.current?.(false)}>
              <Text style={styles.chainGateSecondaryText}>{t('receiptProcess.chainGateCancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Store resolution (chain recognised, store not): a full-screen map-pick modal on
          top of the loader. Replaces the old /receipt/store-resolution route. */}
      <Modal
        visible={storeGate}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => completeStoreResolution(null)}
        onDismiss={() => storeGateDismissRef.current?.()}
      >
        <StoreResolutionOverlay />
      </Modal>

      {/* Manual date entry: receipt readable (receiptNo + time) but DATE unreadable. */}
      <Modal
        visible={dateGate}
        transparent
        animationType="fade"
        onRequestClose={() => dateGateResolveRef.current?.(null)}
      >
        <View style={styles.chainGateBackdrop}>
          <View style={styles.chainGateCard}>
            <Ionicons name="calendar-outline" size={40} color={colors.warning} />
            <Text style={styles.chainGateTitle}>{t('receiptProcess.dateGateTitle')}</Text>
            <Text style={styles.chainGateBody}>{t('receiptProcess.dateGateBody')}</Text>
            <TouchableOpacity style={styles.dateGateField} onPress={() => setDateGateShowPicker(true)}>
              <Ionicons name="calendar-outline" size={18} color={colors.textSecondary} />
              <Text style={[styles.dateGateFieldText, !dateGateTemp && styles.dateGatePlaceholder]}>
                {dateGateTemp
                  ? `${dateGateTemp.getFullYear()}-${String(dateGateTemp.getMonth() + 1).padStart(2, '0')}-${String(dateGateTemp.getDate()).padStart(2, '0')}`
                  : t('receiptProcess.dateGatePlaceholder')}
              </Text>
            </TouchableOpacity>
            {dateGateShowPicker && (
              <DateTimePicker
                value={dateGateTemp ?? new Date()}
                mode="date"
                // iOS: the full graphical calendar straight away (Apple's native
                // inline picker) — one tap → calendar. Android: 'inline' is an
                // iOS-only value; passing it leaves the bound unenforced (future
                // days stay tappable), so use the native 'calendar' dialog there,
                // which greys out + disables anything past maximumDate.
                display={Platform.OS === 'ios' ? 'inline' : 'calendar'}
                // A receipt can't be from the future → today is the latest selectable
                // day; everything after is greyed out and unselectable.
                maximumDate={new Date()}
                minimumDate={new Date(new Date().getFullYear() - 2, new Date().getMonth(), new Date().getDate())}
                onChange={(e, d) => {
                  setDateGateShowPicker(false);
                  // Belt-and-braces: never accept a future date even if a platform
                  // picker let one through (maximumDate already greys them out).
                  const endOfToday = new Date();
                  endOfToday.setHours(23, 59, 59, 999);
                  if (e.type === 'set' && d && d.getTime() <= endOfToday.getTime()) setDateGateTemp(d);
                }}
              />
            )}
            <TouchableOpacity
              style={[styles.chainGatePrimary, !dateGateTemp && styles.gateDisabled]}
              disabled={!dateGateTemp}
              onPress={() => dateGateResolveRef.current?.(dateGateTemp)}
            >
              <Text style={styles.chainGatePrimaryText}>{t('receiptProcess.dateGateConfirm')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.chainGateSecondary} onPress={() => dateGateResolveRef.current?.(null)}>
              <Text style={styles.chainGateSecondaryText}>{t('receiptProcess.dateGateCancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Souply-styled failure modal (replaces the stock OS Alert). */}
      <Modal
        visible={failGate !== null}
        transparent
        animationType="fade"
        onRequestClose={() => { setFailGate(null); router.replace("/(tabs)/receipts"); }}
      >
        <View style={styles.chainGateBackdrop}>
          <View style={styles.chainGateCard}>
            <Ionicons name="alert-circle-outline" size={40} color={colors.warning} />
            <Text style={styles.chainGateTitle}>{t('receiptProcess.failTitle')}</Text>
            <Text style={styles.chainGateBody}>{failGate}</Text>
            <TouchableOpacity
              style={styles.chainGatePrimary}
              onPress={() => {
                setFailGate(null);
                launchDocumentScanner(router, {
                  preview: isPreviewMode,
                  shoppingListId: shoppingListIdParam,
                  expectedChainId: expectedChainIdParam,
                  listMap: listMapParam,
                  replace: true,
                });
              }}
            >
              <Text style={styles.chainGatePrimaryText}>{t('receiptProcess.failTryAgain')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.chainGateSecondary} onPress={() => { setFailGate(null); router.replace("/(tabs)/receipts"); }}>
              <Text style={styles.chainGateSecondaryText}>{t('receiptProcess.failClose')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </>
  );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
  chainGateBackdrop: { flex: 1, backgroundColor: c.overlayBackdrop, alignItems: "center", justifyContent: "center", padding: 24 },
  chainGateCard: { backgroundColor: c.cardBackground, borderRadius: 16, padding: 24, alignItems: "center", gap: 10, width: "100%", maxWidth: 360 },
  chainGateTitle: { fontSize: 17, fontWeight: "700", color: c.textPrimary, textAlign: "center" },
  chainGateBody: { fontSize: 14, color: c.textSecondary, textAlign: "center", lineHeight: 20, marginBottom: 6 },
  chainGatePrimary: { backgroundColor: c.primary, borderRadius: 999, paddingVertical: 13, paddingHorizontal: 24, alignSelf: "stretch", alignItems: "center" },
  chainGatePrimaryText: { color: c.onPrimary, fontSize: 15, fontWeight: "700" },
  chainGateSecondary: { paddingVertical: 11, alignSelf: "stretch", alignItems: "center" },
  chainGateSecondaryText: { color: c.textSecondary, fontSize: 14, fontWeight: "600" },
  gateDisabled: { opacity: 0.4 },
  dateGateField: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "stretch", borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 14, marginVertical: 4 },
  dateGateFieldText: { fontSize: 16, fontWeight: "600", color: c.textPrimary },
  dateGatePlaceholder: { color: c.textSecondary, fontWeight: "500" },
  swipeEntryCard: {
    marginTop: 12,
    marginHorizontal: 16,
    backgroundColor: c.primary,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    shadowColor: c.primaryShadow,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 3,
  },
  swipeEntryCta: {
    color: c.onPrimary,
    fontSize: 17,
    fontWeight: "700",
  },
  swipeEntryCount: {
    color: c.onPrimary,
    opacity: 0.9,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    marginTop: 3,
  },
  swipeHelpMoreCard: {
    marginTop: 12,
    marginHorizontal: 16,
    backgroundColor: c.cardBackground,
    borderWidth: 1,
    borderColor: c.primary,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
  },
  swipeHelpMoreCta: {
    color: c.primary,
    fontSize: 15,
    fontWeight: "700",
  },
  swipeHelpMoreSubtitle: {
    color: c.textSecondary,
    fontSize: 12,
    fontWeight: "500",
    marginTop: 2,
  },
  processingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: c.overlayBackdrop,
    alignItems: "center",
    justifyContent: "center",
  },
  processingCard: {
    backgroundColor: c.cardBackground,
    borderRadius: 14,
    paddingVertical: 24,
    paddingHorizontal: 28,
    minWidth: 220,
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  processingTitle: {
    marginTop: 12,
    fontSize: 15,
    fontWeight: "700",
    color: c.textPrimary,
  },
  processingStep: {
    marginTop: 4,
    fontSize: 13,
    color: c.textSecondary,
  },
  errorBanner: {
    backgroundColor: c.errorMuted,
    borderColor: c.softAccent,
    borderWidth: 1,
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  errorHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  errorTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: c.errorStrong,
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  errorMsg: {
    flex: 1,
    fontSize: 12,
    color: c.errorStrong,
  },
  retryBtn: {
    backgroundColor: c.error,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  retryBtnText: {
    color: c.textInverse,
    fontSize: 12,
    fontWeight: "700",
  },
  editInputLoaderWrap: {
    position: "relative",
    marginBottom: 8,
  },
  editInputWithLoaderPadding: {
    marginBottom: 0,
    paddingRight: 38,
  },
  editInputLoader: {
    position: "absolute",
    right: 12,
    top: "50%",
    marginTop: -8,
  },
  unrecognizedBlock: {
    marginBottom: 10,
    gap: 8,
  },
  priceEditorInline: {
    marginBottom: 10,
  },

  regionPreviewWrap: {
    width: "100%",
    overflow: "hidden",
    borderRadius: 8,
  },

  actionButtonPrimary: {
    backgroundColor: c.primary,
    borderColor: c.primary,
  },

  actionButtonTextPrimary: {
    color: c.onPrimary,
  },
  actionsRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.primaryMuted,
    backgroundColor: c.primaryMuted,
  },
  actionButtonText: {
    fontSize: 13,
    color: c.primary,
    fontWeight: "600",
  },
  productBandCropWrap: {
    marginBottom: 8,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: c.pageBackground,
  },
  // B3: S1 (confirmed) is the default. Left edge picks up a 3 px soft
  // accent border to mark the row as "clean / matched".
  productRowCard: {
    backgroundColor: c.cardBackground,
    marginHorizontal: 16,
    marginTop: 0,
    borderRadius: 0,
    padding: 14,
    borderTopWidth: 0,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderLeftWidth: 3,
    borderColor: c.borderSubtle,
    borderLeftColor: c.softAccent,
  },
  productRowCardLast: {
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
  },
  // C2: with the products-header card gone (chevron collapse absorbed by
  // tabs), the first product row is now the visual top of the list.
  productRowCardFirst: {
    borderTopWidth: 1,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  // B3 S3 — partial recognition. Warning border + tint.
  productRowCardS3: {
    backgroundColor: c.warningMuted,
    borderLeftColor: c.warning,
    borderLeftWidth: 4,
  },
  // B3 S4 — fully unrecognised. Error border + tint; price collapses to "—",
  // thumbnail is the muted-emoji placeholder.
  productRowCardS4: {
    backgroundColor: c.errorMuted,
    borderLeftColor: c.error,
    borderLeftWidth: 4,
  },
  productThumbPlaceholderMuted: {
    opacity: 0.4,
  },
  productsHeaderTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  productsHint: {
    marginTop: 2,
    fontSize: 12,
    color: c.warning,
    fontWeight: "600",
  },
  productsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: 16,
    marginTop: 20,
    marginBottom: 0,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderBottomWidth: 0,
    backgroundColor: c.cardBackground,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: c.borderSubtle,
    overflow: "hidden",
  },
  productsHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  productsTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: c.textPrimary,
    flexShrink: 1,
  },
  container: { flex: 1, backgroundColor: c.pageBackground },

  // C2 — filter banner pinned below the navbar, styled like StoreChipBar so
  // the segmented tab row visually matches the chain-filter pattern used on
  // browse/discounts/shopping-list screens.
  segmentedWrap: {
    flexDirection: "row",
    backgroundColor: c.cardBackground,
    borderBottomWidth: 0.5,
    borderBottomColor: c.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  segmentTab: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.cardBackground,
  },
  segmentTabActive: {
    backgroundColor: c.primary,
    borderColor: c.primary,
  },
  segmentTabLabel: {
    fontSize: 13,
    color: c.textPrimary,
  },
  segmentTabLabelActive: {
    color: c.onPrimary,
    fontWeight: "600",
  },

  // C2 — Prekės tab wrapper: matches the card-stack rhythm of the other
  // tabs so the product rows don't feel orphaned.
  prekesListWrap: {
    marginTop: 8,
  },

  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.pageBackground,
    gap: 16,
  },
  loadingText: { fontSize: 15, color: c.textSecondary },

  sectionCard: {
    backgroundColor: c.cardBackground,
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
    padding: 16,
    elevation: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
  },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionTitle: { flex: 1, fontSize: 15, fontWeight: "600", color: c.textPrimary },
  sectionSubvalue: { fontSize: 13, color: c.textSecondary, marginTop: 2 },
  warningText: { fontSize: 12, color: c.warning, marginTop: 4 },
  productRow: { flexDirection: "row", alignItems: "center" },
  productInfo: { flex: 1 },
  productName: { fontSize: 14, color: c.textPrimary, fontWeight: "500" },
  matchedName: { fontSize: 14, color: c.primary, fontWeight: "600" },
  ocrName: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  productQuantity: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
  prodSkipBadge: {
    flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", marginTop: 4,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
    backgroundColor: "rgba(217,119,6,0.12)", borderWidth: StyleSheet.hairlineWidth, borderColor: c.warning,
  },
  prodSkipBadgeText: { fontSize: 10, fontWeight: "700", color: c.warning },
  productPriceCol: { alignItems: "flex-end", marginRight: 4 },
  productPrice: { fontSize: 15, fontWeight: "700", color: c.textPrimary },
  productPriceStrike: {
    fontSize: 12,
    color: c.textMuted,
    textDecorationLine: "line-through",
    marginTop: 2,
  },
  productRowMenuBtn: { padding: 6, marginLeft: 2 },

  // Three-dots action sheet
  sheetBackdrop: {
    flex: 1,
    backgroundColor: c.overlayBackdrop,
    justifyContent: "flex-end",
  },
  sheetCard: {
    backgroundColor: c.cardBackground,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  sheetItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  sheetItemText: { fontSize: 15, color: c.textPrimary, fontWeight: "500" },
  sheetCancel: { justifyContent: "center", marginTop: 4 },
  sheetCancelText: { fontSize: 14, color: c.textSecondary, fontWeight: "600" },

  // Issue-report modal
  issueModalCard: {
    backgroundColor: c.cardBackground,
    marginHorizontal: 24,
    borderRadius: 16,
    padding: 20,
    alignSelf: "center",
    marginTop: "auto",
    marginBottom: "auto",
    width: "88%",
  },
  issueModalTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: c.textPrimary,
    marginBottom: 14,
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
  },
  checkboxLabel: { fontSize: 15, color: c.textPrimary },
  issueModalBtnRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 16,
    justifyContent: "flex-end",
  },
  issueModalBtn: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
  },
  issueModalBtnSecondary: { backgroundColor: c.surfaceMuted },
  issueModalBtnPrimary: { backgroundColor: c.primary },
  issueModalBtnDisabled: { opacity: 0.4 },
  issueModalBtnTextSecondary: {
    color: c.textPrimary,
    fontWeight: "600",
    fontSize: 14,
  },
  issueModalBtnTextPrimary: {
    color: c.onPrimary,
    fontWeight: "700",
    fontSize: 14,
  },

  editSection: {
    marginTop: 12,
    paddingTop: 12,
  },
  rawTextLabel: { fontSize: 11, color: c.textMuted, marginBottom: 4 },
  rawText: {
    fontSize: 12,
    color: c.textSecondary,
    fontFamily: "monospace",
    backgroundColor: c.surfaceSubtle,
    padding: 8,
    borderRadius: 6,
    marginBottom: 10,
  },
  editInput: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: c.textPrimary,
    marginBottom: 8,
  },
  editRow: { flexDirection: "row", gap: 8 },
  editField: { flex: 1 },
  editLabel: { fontSize: 11, color: c.textMuted, marginBottom: 4 },

  footerStatGrid: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "stretch",
  },
  footerStatCell: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 4,
  },
  footerStatDivider: {
    width: 1,
    backgroundColor: c.borderSubtle,
    marginVertical: 4,
  },
  footerStatValue: {
    fontSize: 18,
    fontWeight: "600",
    color: c.textPrimary,
  },
  footerStatLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: c.textMuted,
    letterSpacing: 0.5,
    marginTop: 4,
    textTransform: "uppercase",
  },

  emptyProducts: { alignItems: "center", padding: 32, gap: 8 },
  emptyText: { fontSize: 14, color: c.textMuted },

  productThumb: {
    width: 48,
    height: 48,
    borderRadius: 6,
    backgroundColor: c.surfaceSubtle,
    marginRight: 10,
  },
  productThumbPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 6,
    backgroundColor: c.surfaceMuted,
    marginRight: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  productThumbEmoji: {
    fontSize: 26,
    opacity: 0.4,
  },
  browseButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: c.primary,
    borderRadius: 8,
    paddingVertical: 10,
    marginTop: 12,
  },
  browseButtonText: { color: c.onPrimary, fontSize: 14, fontWeight: "600" },
  savingsCard: {
    borderWidth: 1,
    borderColor: c.primaryMuted,
    backgroundColor: c.primaryMuted,
  },
  savingsText: {
    marginTop: 6,
    fontSize: 14,
    fontWeight: "700",
    color: c.primary,
  },
});
