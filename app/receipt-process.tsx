import { Ionicons } from "@expo/vector-icons";
import { usePreventRemove, useNavigation, useFocusEffect } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import TextRecognition from "@react-native-ml-kit/text-recognition";
import * as Haptics from "expo-haptics";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Dimensions,
    Image,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from "react-native";
import ReceiptComparisonSection from "../components/receipt/ReceiptComparisonSection";
import ReceiptCategoryBreakdown from "../components/receipt/ReceiptCategoryBreakdown";
import ReceiptPhotoView from "../components/receipt/ReceiptPhotoView";
import { SkeletonBox } from "../components/SkeletonBox";
import { formatEuro, formatDate } from "../utils/formatCurrency";
import { capVoluntaryQueue } from "../utils/swipeQueueCap";
import { API_BASE_URL } from "../config/api";
import { getUserId } from "../config/user";
import { useReceiptComparison } from "../hooks/useReceiptComparison";
import {
    computeRehydratedRegions,
    persistRehydratedRegions,
    REGIONS_VERSION,
} from "../services/regionsRehydrationService";
import { DEV_MODE } from "../constants/flags";
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
import { ocrImageTiled } from "../utils/mlkitOcr";
import { useProfileStore } from '../state/profileStore';

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
  rawText: string;
  region: Region;
  lineRegions?: LabeledRegion[];
}

/**
 * Per-page OCR context needed to render RegionPreview correctly for both
 * single-image scans and multi-page PDFs. Regions carry yTop/yBottom in the
 * merged-scaled OCR space; this maps them back to page-local image pixels.
 */
interface PageMeta {
  uri: string;
  pixelWidth: number;
  pixelHeight: number;
  /** scale applied to MLKit coords when populating lines/regions */
  frameScale: number;
  /** start of this page in merged-y space */
  yOffsetScaled: number;
  /** how much merged-y this page occupies (excludes +50 buffer) */
  pageMaxYScaled: number;
  /** horizontal bounds of the receipt text on this page, in merged/scaled space */
  receiptXLeftScaled: number;
  receiptXRightScaled: number;
}

interface RegionPreviewProps {
  pages: PageMeta[];
  region: Region;
  cardWidth: number;
}
type AsyncStatus = "idle" | "pending" | "done" | "error";

const CARD_WIDTH = Dimensions.get("window").width - 32 - 32;

/**
 * Camera photos of receipts often land in landscape (user holding phone
 * sideways, EXIF auto-rotation already baked into the bitmap). The downstream
 * parser + region preview assume a portrait receipt — horizontal rows from
 * different parts of the receipt otherwise merge on the same y and become
 * unparseable. If the image is landscape, try rotating both ±90° and pick
 * the rotation whose OCR produces more lines (the upright one always wins
 * because letters are legible). Returns the URI to use downstream (original
 * if already portrait, rotated variant otherwise).
 */
async function ensurePortraitOrientation(uri: string): Promise<string> {
  const dims = await new Promise<{ width: number; height: number }>(
    (resolve, reject) => {
      Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
    },
  );
  if (dims.height >= dims.width) return uri;

  const [rotatedCW, rotatedCCW] = await Promise.all([
    ImageManipulator.manipulateAsync(
      uri,
      [{ rotate: 90 }],
      { compress: 1, format: ImageManipulator.SaveFormat.JPEG },
    ),
    ImageManipulator.manipulateAsync(
      uri,
      [{ rotate: -90 }],
      { compress: 1, format: ImageManipulator.SaveFormat.JPEG },
    ),
  ]);

  const [ocrCW, ocrCCW] = await Promise.all([
    TextRecognition.recognize(rotatedCW.uri),
    TextRecognition.recognize(rotatedCCW.uri),
  ]);
  const scoreLines = (r: { blocks: { lines: { text: string }[] }[] }) =>
    r.blocks.reduce((sum, b) => sum + b.lines.length, 0);
  const cwScore = scoreLines(ocrCW);
  const ccwScore = scoreLines(ocrCCW);
  console.log(
    `[ensurePortraitOrientation] landscape ${dims.width}x${dims.height} -> CW lines=${cwScore}, CCW lines=${ccwScore}`,
  );
  return cwScore >= ccwScore ? rotatedCW.uri : rotatedCCW.uri;
}

/**
 * Sharp per-product band crop using `ImageManipulator.manipulateAsync`.
 *
 * Why this exists alongside `RegionPreview`: RegionPreview slides a
 * full-page Image inside an overflow:hidden container with negative
 * margins. RN on Android downsamples large bitmaps at decode time based
 * on the visible rectangle — feeding a 1080×5000 page into a 400×24 slot
 * throws away ~99% of the source pixels before render, producing
 * unreadable mush for tiny product bands. Pre-cropping to a small file
 * dodges the downsample heuristic so the band renders at native
 * resolution. Same fix the `Kvitų paketinis testas` detail screen uses.
 *
 * Only used in DEV builds (gated by `__DEV__` at the call site) — the
 * extra crop file per product isn't worth it for end users, who already
 * see the matched product image instead.
 */
function BandCropImage({ pages, region, cardWidth }: RegionPreviewProps) {
  const [croppedUri, setCroppedUri] = useState<string | null>(null);
  const [cropError, setCropError] = useState<string | null>(null);

  // Resolve which page the region lands on + its local pixel coords.
  // Same algorithm as RegionPreview so the two stay in lockstep.
  const cropPlan = useMemo(() => {
    if (region.yBottom <= region.yTop) return null;
    if (pages.length === 0) return null;
    let page: PageMeta = pages[0];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (
        region.yTop >= p.yOffsetScaled &&
        region.yTop < p.yOffsetScaled + p.pageMaxYScaled + 50
      ) {
        page = p;
        break;
      }
      page = p;
    }
    const localYTop = Math.max(0, Math.floor(region.yTop - page.yOffsetScaled));
    const localYBottom = Math.min(
      Math.ceil(region.yBottom - page.yOffsetScaled),
      page.pageMaxYScaled,
      page.pixelHeight,
    );
    const heightPx = Math.max(1, localYBottom - localYTop);
    const pad = 20;
    const xLeft = Math.max(0, Math.floor(page.receiptXLeftScaled - pad));
    const xRight = Math.min(
      page.pixelWidth,
      Math.ceil(page.receiptXRightScaled + pad),
    );
    const widthPx = Math.max(1, xRight - xLeft);
    return {
      uri: page.uri,
      originX: xLeft,
      originY: localYTop,
      width: widthPx,
      height: heightPx,
    };
  }, [pages, region]);

  useEffect(() => {
    if (!cropPlan) return;
    let cancelled = false;
    ImageManipulator.manipulateAsync(
      cropPlan.uri,
      [
        {
          crop: {
            originX: cropPlan.originX,
            originY: cropPlan.originY,
            width: cropPlan.width,
            height: cropPlan.height,
          },
        },
      ],
      { compress: 1, format: ImageManipulator.SaveFormat.PNG },
    )
      .then((res) => {
        if (!cancelled) setCroppedUri(res.uri);
      })
      .catch((e) => {
        if (!cancelled) setCropError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [cropPlan]);

  if (!cropPlan) return null;
  const aspect = cropPlan.width / cropPlan.height;
  return (
    <View
      style={{
        width: cardWidth,
        height: cardWidth / aspect,
        borderRadius: 6,
        overflow: "hidden",
        backgroundColor: "#0001",
      }}
    >
      {croppedUri && (
        <Image
          source={{ uri: croppedUri }}
          style={{ width: "100%", height: "100%" }}
          resizeMode="stretch"
        />
      )}
      {cropError && (
        <Text style={{ fontSize: 10, color: "#c00", padding: 2 }} numberOfLines={1}>
          crop failed: {cropError}
        </Text>
      )}
    </View>
  );
}

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
  const tabs: Array<{ key: ReceiptTab; label: string }> = [
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
): object {
  return {
    version: 1,
    image: imageMeta
      ? {
          filePath: imageFilePath,
          width: imageMeta.width,
          height: imageMeta.height,
        }
      : null,
    header,
    products,
    footer,
  };
}

export default function ProcessReceiptScreen() {
  const { t } = useTranslation();
  const { uri, uris: urisParam, receiptId: receiptIdParam, preview: previewParam, swipeDone: swipeDoneParam } = useLocalSearchParams<{
    uri?: string;
    uris?: string;
    receiptId?: string;
    preview?: string;
    swipeDone?: string;
  }>();
  const existingReceiptId = receiptIdParam ? Number(receiptIdParam) : null;
  const isExistingMode = Number.isFinite(existingReceiptId);
  // Set to true when navigating here FROM the swipe screen — prevents the
  // mandatory-swipe gate from immediately redirecting back to swipe.
  const swipeDone = swipeDoneParam === '1';

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
  const [loadingMessage, setLoadingMessage] = useState("Nuskaitomas kvitas...");
  // Per-product match progress. When non-null, loading overlay shows
  // an "N / M" counter alongside the message so the user sees the
  // phone is actively working through the product list. Reset to null
  // once matching completes (or on bail).
  const [matchProgress, setMatchProgress] = useState<
    { done: number; total: number } | null
  >(null);
  const isHydratingRef = useRef(false);
  // Component-scoped AbortController. Aborted on unmount so the 30+
  // in-flight product-match fetches don't keep the server churning
  // if the user backs out mid-analysis. Initialised lazily so the
  // very first call sees a valid signal.
  const mountAbortRef = useRef<AbortController | null>(null);
  if (!mountAbortRef.current) mountAbortRef.current = new AbortController();
  useEffect(() => {
    return () => {
      mountAbortRef.current?.abort();
      mountAbortRef.current = null;
    };
  }, []);
  const [header, setHeader] = useState<HeaderData | null>(null);
  const [products, setProducts] = useState<ProductLine[]>([]);
  const [footer, setFooter] = useState<FooterData | null>(null);
  const [editingSection, setEditingSection] = useState<
    "header" | "footer" | number | null
  >(null);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageDims, setImageDims] = useState<{
    width: number;
    height: number;
  } | null>(null);
  // Per-page metadata for RegionPreview (multi-page PDFs + horizontal
  // receipt-area crop to skip A4 whitespace).
  const [pageMetas, setPageMetas] = useState<PageMeta[]>([]);
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

  const loadExistingReceipt = async (id: number) => {
    try {
      setLoading(true);
      isHydratingRef.current = true;
      setLoadingMessage(t('receiptProcess.loading'));
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/receipts/${id}`, {
        timeoutMs: TIMEOUT_STANDARD_MS,
      });
      const receipt = await res.json();

      // If the receipt still has pending mandatory swipes, redirect to the
      // swipe screen unless we just came from it (swipeDone=1). The swipe
      // screen sets swipeDone when it navigates here so we don't loop.
      const pendingSwipes =
        !swipeDone &&
        (receipt.mandatorySwipesRequired ?? 0) > 0 &&
        (receipt.mandatorySwipesCompleted ?? 0) < (receipt.mandatorySwipesRequired ?? 0);
      if (pendingSwipes) {
        const remaining =
          (receipt.mandatorySwipesRequired ?? 0) -
          (receipt.mandatorySwipesCompleted ?? 0);
        router.replace({ pathname: "/swipe/queue", params: { receiptId: String(id) } } as any);
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
        })),
      );

      setFooter({
        total: parsed.footer.total ?? null,
        date: parsed.footer.date ?? "",
        time: parsed.footer.time ?? "",
        receiptNo: parsed.footer.receiptNo ?? receipt.receiptNo ?? "",
        totalSavings: parsed.footer.totalSavings ?? null,
        rawText: parsed.footer.rawText ?? "",
        region: parsed.footer.region ?? {
          yTop: 0,
          yBottom: 0,
          xLeft: 0,
          xRight: 0,
        },
        lineRegions: Array.isArray(parsed.footer.lineRegions)
          ? parsed.footer.lineRegions
          : undefined,
      });

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
      void (async () => {
        try {
          const imageRes = await fetch(
            `${API_BASE_URL}/api/receipts/${id}/image`,
          );
          const imageData = await imageRes.json();

          if (imageData?.url) {
            setImageUri(imageData.url);

            const parsedWidth = Number(parsed?.image?.width);
            const parsedHeight = Number(parsed?.image?.height);

            const applyDims = (w: number, h: number) => {
              setImageDims({ width: w, height: h });
              setPageMetas([
                {
                  uri: imageData.url,
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

            if (
              Number.isFinite(parsedWidth) &&
              Number.isFinite(parsedHeight) &&
              parsedWidth > 0 &&
              parsedHeight > 0
            ) {
              applyDims(parsedWidth, parsedHeight);
            } else {
              Image.getSize(
                imageData.url,
                (width, height) => applyDims(width, height),
                () => {},
              );
            }
          }
        } catch (e) {
          console.warn("Failed to load receipt image for region preview:", e);
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
  const receiptIdRef = useRef<number | null>(null);
  const userIdRef = useRef<string | null>(null);
  const hasPostedRef = useRef(false); // guard against double POST from re-renders
  const hasProcessedRef = useRef(false); // guard against double OCR in StrictMode dev builds
  // Mirrors hasProcessedRef but for the existing-receipt path. Without
  // this, StrictMode's dev double-mount issues two parallel GETs for the
  // same receipt id (and runs hydration twice, which racing against the
  // setTimeout(0) that clears isHydratingRef can slip a stray save through).
  const hasLoadedExistingRef = useRef(false);

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
    console.log("[receipt-process] uri effect", { uri, isExistingMode });
    if (isExistingMode) return;
    if (!uri) return;
    setReceiptId(null);
    setImageFilePath(null);
    setImageDims(null);
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
      if (hasLoadedExistingRef.current) return; // StrictMode dev double-mount
      hasLoadedExistingRef.current = true;
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
          setProducts(prev => prev.map(p => {
            if (!Array.isArray(p.altMatches) || p.altMatches.length === 0) return p;
            let touched = false;
            const nextAm: ProductMatchOption[] = p.altMatches.map(am => {
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
            return touched ? { ...p, altMatches: nextAm } : p;
          }));
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
              // Use the same endpoint the button click target uses
              // (voluntary mode, this receipt). Otherwise the count and
              // the cards-on-tap diverge — e.g. the legacy
              // /api/receipts/:id/swipe-queue endpoint advertised 23
              // cards but tapping landed on an empty queue because
              // navigation went to a `standalone` mode the queue screen
              // no longer handles.
              const [receiptRes, globalRes] = await Promise.all([
                fetch(
                  `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/swipe-queue?receiptId=${receiptId}&voluntary=1`,
                  { signal: controller.signal }
                ),
                fetch(
                  `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/swipe-queue`,
                  { signal: controller.signal }
                ),
              ]);
              clearTimeout(abortTimer);
              if (!receiptRes.ok || cancelled) return;
              const receiptData = await receiptRes.json();
              const globalData = globalRes.ok ? await globalRes.json() : { items: [] };
              const receiptItems = Array.isArray(receiptData?.items) ? receiptData.items : [];
              const globalItems = Array.isArray(globalData?.items) ? globalData.items : [];
              // Reuse the same cap the queue screen applies so the count
              // matches exactly what the user will swipe through.
              const capped = capVoluntaryQueue({ receiptItems, globalItems }).items;
              if (!cancelled) {
                setSwipeQueueCount(capped.length);
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
        imageDims ? { uri: imageUri, ...imageDims } : null,
        imageFilePath,
      );

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
        setPostStatus("done");
        // Receipt already exists server-side (either as this user's row
        // or a different user's). Drop the local draft — there's
        // nothing to resume; the data lives in someone's receipt list.
        clearReceiptDraft().catch(() => {});
        useProfileStore.getState().invalidate();
        router.replace("/(tabs)/receipts");
        setTimeout(() => {
          Alert.alert(t('receiptProcess.duplicateTitle'), t('receiptProcess.duplicateBody'));
        }, 100);
        return;
      }
      if (!res.ok || !data?.id) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setReceiptId(data.id);
      setPostStatus("done");
      clearReceiptDraft().catch(() => {});
      if (data.mandatorySwipesRequired > 0) {
        // User must swipe before seeing the price comparison — navigate to the
        // swipe screen now. Comparison will be fetched when they return to the
        // receipt view in existing mode after completing the swipes.
        router.replace({ pathname: "/swipe/queue", params: { receiptId: String(data.id) } } as any);
      } else {
        setComparisonStatus("pending");
        fetchComparison(data.id);
      }
    } catch (e: any) {
      console.warn("Receipt POST failed:", e);
      setPostStatus("error");
      setPostErr(e?.message || t('receiptProcess.errorSave'));
      hasPostedRef.current = false;
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

  // Step 2: MinIO upload — runs in parallel with POST, PATCH filePath once done
  const runUpload = async () => {
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

      // Local-file blob load is NOT a network call; fetch(imageUri)
      // on a file:// URI is synchronous-ish. No timeout needed.
      const imageBlob = await (await fetch(imageUri)).blob();
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
    } catch (e: any) {
      console.warn("MinIO upload failed:", e);
      setUploadStatus("error");
      setUploadErr(e?.message || t('receiptProcess.errorUploadPhoto'));
    }
  };

  useEffect(() => {
    if (isPreviewMode) return; // preview: skip MinIO upload + PATCH
    if (!imageUri || !receiptId || imageFilePath) return;
    if (uploadStatus === "pending" || uploadStatus === "error") return;
    runUpload();
  }, [imageUri, receiptId, imageFilePath, isPreviewMode]);

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
      imageDims ? { uri: imageUri, ...imageDims } : null,
      imageFilePath,
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
    | "store_unrecognized";

  const USER_FACING_BAIL_MSG: Record<BailReason, string> = {
    ocr_no_text: t('receiptProcess.errorOcrUnreadable'),
    ocr_error: t('receiptProcess.errorOcrParse'),
    chain_unrecognized: t('receiptProcess.errorChain'),
    store_unrecognized: t('receiptProcess.errorStore'),
  };

  interface BailContext {
    ocrLineCount?: number | null;
    ocrPreview?: string | null;
    detectedChainName?: string | null;
    extractedStoreAddress?: string | null;
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
    // Navigate first, then alert — alert shows on the Analize tab.
    router.replace("/(tabs)/receipts");
    setTimeout(() => {
      Alert.alert("Nepavyko apdoroti kvito", USER_FACING_BAIL_MSG[reason]);
    }, 100);
  };

  const processReceipt = async (imageUris: string[]) => {
    try {
      setLoading(true);
      setLoadingMessage(t('receiptProcess.loadingScan'));

      interface LineWithFrame {
        text: string;
        yTop: number;
        yBottom: number;
        xLeft: number;
        xRight: number;
      }

      const allLines: LineWithFrame[] = [];
      let combinedFrameScale = 1;
      let yOffset = 0; // running accumulator across pages in Image-pixel space
      let firstPageDims: { width: number; height: number } | null = null;
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
        const ocr = await ocrImageTiled(pageUri);
        const pageDims = { width: ocr.pixelWidth, height: ocr.pixelHeight };
        if (pageIdx === 0) firstPageDims = pageDims;
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
        for (const line of ocr.lines) {
          if (line.yBottom > pageMaxYScaled) pageMaxYScaled = line.yBottom;
          pageLineBounds.push({ l: line.xLeft, r: line.xRight });
          allLines.push({
            text: line.text,
            yTop: line.yTop + yOffset,
            yBottom: line.yBottom + yOffset,
            xLeft: line.xLeft,
            xRight: line.xRight,
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

      const dims = firstPageDims ?? { width: 0, height: 0 };
      setImageDims(dims);
      const frameScale = combinedFrameScale;
      allLines.sort((a, b) => a.yTop - b.yTop);

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
            }
            continue;
          }
        }
        mergedLines.push({ ...line });
      }

      console.log("=== MERGED OCR LINES ===");
      mergedLines.forEach((l, i) =>
        console.log(`${i}: [y=${Math.round(l.yTop)}] ${l.text}`),
      );

      const lineTexts = mergedLines.map((l) => l.text);

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

      // Note on setLoading placement: we intentionally hold the main
      // loading overlay up through the ENTIRE applyXxxResult call.
      // Dropping it right after the early header was set used to flash
      // "Prekės (0) — prekės nerastos" to the user while per-product
      // match requests were still in flight. Keep the overlay until
      // products have been parsed + matched.
      if (isRimiReceipt(lineTexts)) {
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
        await applyRimiResult(parsed.header, parsed.products, parsed.footer);
        setLoading(false);
      } else if (isMaximaReceipt(lineTexts)) {
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

        const parsed = parseMaximaReceipt(allLines);
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
        await applyMaximaResult(parsed.header, parsed.products, parsed.footer);
        setLoading(false);
      } else if (isNorfaReceipt(lineTexts)) {
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
        await applyNorfaResult(parsed.header, parsed.products, parsed.footer);
        setLoading(false);
      } else if (isLidlReceipt(lineTexts)) {
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

        const parsed = parseLidlReceipt(allLines);
        await applyLidlResult(parsed.header, parsed.products, parsed.footer);
        setLoading(false);
      } else if (isIkiReceipt(lineTexts)) {
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

        const parsed = parseIkiReceipt(mergedLines);
        await applyIkiResult(parsed.header, parsed.products, parsed.footer);
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
      await bailWithLog("store_unrecognized", {
        detectedChainName: "RIMI",
        extractedStoreAddress: rHeader.storeAddress || null,
      });
      return;
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
    });

    const AUTO_APPLY_THRESHOLD = 0.85;

    // Initialise the loading-overlay progress counter. Each per-product
    // match promise below bumps `done` on completion so the user sees
    // "N / M prekių atpažinta" tick up instead of staring at a static
    // spinner during what can be 5-15s of sequential HTTP calls.
    setMatchProgress({ done: 0, total: rProducts.length });

    const matchPromises = rProducts.map(async (rp) => {
      let altMatches: ProductMatchOption[] = [];

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

      try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: matchName,
        });
        const res = await fetchWithTimeout(
          `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
          {
            timeoutMs: TIMEOUT_FAST_MS,
            externalSignal: mountAbortRef.current?.signal,
          },
        );
        const data = await res.json();
        if (Array.isArray(data?.matches)) altMatches = data.matches;
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
        matchedName: top?.name ?? null,
        storeProductId: autoApply ? top!.storeProductId : null,
        storeProductImageUrl: top?.imageUrl ?? null,
        matchConfidence: top?.confidence ?? null,
        matchConfirmed: autoApply,
        // Auto-matched items start as "system-verified" — flipped to false the
        // moment the user intervenes (alt pick, browse pick, create, edit).
        priceVerified: autoApply,
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
      await bailWithLog("store_unrecognized", {
        detectedChainName: "MAXIMA",
        extractedStoreAddress: mHeader.storeAddress || null,
      });
      return;
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
    });

    const AUTO_APPLY_THRESHOLD = 0.85;

    setMatchProgress({ done: 0, total: mProducts.length });

    const matchPromises = mProducts.map(async (mp) => {
      let altMatches: ProductMatchOption[] = [];

      // mp.name is already cleaned (size stripped). mp.parsedAmount/parsedUnit
      // were extracted from the raw name before cleaning.
      const { strippedName } = parseProductName(mp.name);
      const matchName = strippedName || mp.name;
      const resolvedAmount = mp.parsedAmount ?? null;
      const resolvedUnit = mp.parsedUnit ?? null;

      try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: matchName,
        });
        const res = await fetchWithTimeout(
          `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
          {
            timeoutMs: TIMEOUT_FAST_MS,
            externalSignal: mountAbortRef.current?.signal,
          },
        );
        const data = await res.json();
        if (Array.isArray(data?.matches)) altMatches = data.matches;
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
        matchedName: top?.name ?? null,
        storeProductId: autoApply ? top!.storeProductId : null,
        storeProductImageUrl: top?.imageUrl ?? null,
        matchConfidence: top?.confidence ?? null,
        matchConfirmed: autoApply,
        priceVerified: autoApply,
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
    });

    const AUTO_APPLY_THRESHOLD = 0.85;

    setMatchProgress({ done: 0, total: nProducts.length });

    const matchPromises = nProducts.map(async (np) => {
      let altMatches: ProductMatchOption[] = [];

      const { strippedName, amount: parsedAmount, unit: parsedUnit } = parseProductName(np.name);
      const matchName = strippedName || np.name;

      try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: matchName,
        });
        const res = await fetchWithTimeout(
          `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
          {
            timeoutMs: TIMEOUT_FAST_MS,
            externalSignal: mountAbortRef.current?.signal,
          },
        );
        const data = await res.json();
        if (Array.isArray(data?.matches)) altMatches = data.matches;
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
        matchedName: top?.name ?? null,
        storeProductId: autoApply ? top!.storeProductId : null,
        storeProductImageUrl: top?.imageUrl ?? null,
        matchConfidence: top?.confidence ?? null,
        matchConfirmed: autoApply,
        priceVerified: autoApply,
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
      await bailWithLog("store_unrecognized", {
        detectedChainName: "LIDL",
        extractedStoreAddress: lHeader.storeAddress || null,
      });
      return;
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
    });

    const AUTO_APPLY_THRESHOLD = 0.85;

    setMatchProgress({ done: 0, total: lProducts.length });

    const matchPromises = lProducts.map(async (lp) => {
      let altMatches: ProductMatchOption[] = [];

      const { strippedName, amount: parsedAmount, unit: parsedUnit } = parseProductName(lp.name);
      const matchName = strippedName || lp.name;

      try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: matchName,
        });
        const res = await fetchWithTimeout(
          `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
          {
            timeoutMs: TIMEOUT_FAST_MS,
            externalSignal: mountAbortRef.current?.signal,
          },
        );
        const data = await res.json();
        if (Array.isArray(data?.matches)) altMatches = data.matches;
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
        matchedName: top?.name ?? null,
        storeProductId: autoApply ? top!.storeProductId : null,
        storeProductImageUrl: top?.imageUrl ?? null,
        matchConfidence: top?.confidence ?? null,
        matchConfirmed: autoApply,
        priceVerified: autoApply,
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
      rawText: lFooter.rawText,
      region: lFooter.region,
    });
  };

  const applyIkiResult = async (
    iHeader: IkiHeader,
    iProducts: IkiProduct[],
    iFooter: IkiFooter,
  ) => {
    const chainId = 3;

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
      await bailWithLog("store_unrecognized", {
        detectedChainName: "IKI",
        extractedStoreAddress: iHeader.storeAddress || null,
      });
      return;
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
    });

    const AUTO_APPLY_THRESHOLD = 0.85;

    setMatchProgress({ done: 0, total: iProducts.length });

    const matchPromises = iProducts.map(async (ip) => {
      let altMatches: ProductMatchOption[] = [];

      const { strippedName, amount: parsedAmount, unit: parsedUnit } = parseProductName(ip.name);
      const matchName = strippedName || ip.name;

      try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: matchName,
        });
        const res = await fetchWithTimeout(
          `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
          {
            timeoutMs: TIMEOUT_FAST_MS,
            externalSignal: mountAbortRef.current?.signal,
          },
        );
        const data = await res.json();
        if (Array.isArray(data?.matches)) altMatches = data.matches;
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
        matchedName: top?.name ?? null,
        storeProductId: autoApply ? top!.storeProductId : null,
        storeProductImageUrl: top?.imageUrl ?? null,
        matchConfidence: top?.confidence ?? null,
        matchConfirmed: autoApply,
        priceVerified: autoApply,
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
      rawText: iFooter.rawText,
      region: iFooter.region,
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
  const regionRehydrationTriedRef = useRef(false);
  const sectionNeedsRehydration = (regions: LabeledRegion[] | undefined): boolean => {
    if (!regions || regions.length === 0) return true;
    return !regions.some((r) => typeof (r as { kind?: string }).kind === 'string');
  };
  useEffect(() => {
    if (regionRehydrationTriedRef.current) return;
    if (!imageUri) return;
    if (!receiptId) return;
    if (!header || header.chainId == null) return;
    const headerNeeds = sectionNeedsRehydration(header.lineRegions);
    const footerNeeds = sectionNeedsRehydration(footer?.lineRegions);
    const versionStale = header.regionsVersion !== REGIONS_VERSION;
    if (!headerNeeds && !footerNeeds && !versionStale) return;

    regionRehydrationTriedRef.current = true;
    const chainId = header.chainId;
    const targetReceiptId = receiptId;
    const targetImageUri = imageUri;
    void (async () => {
      const result = await computeRehydratedRegions(targetImageUri, chainId);
      if (!result) return;
      // Apply unconditionally on version stale — even if the section
      // already has kinded regions, the new parser revision may emit
      // different bands. Only an empty result array is rejected.
      setHeader((h) => {
        if (!h) return h;
        const next: HeaderData = { ...h, regionsVersion: REGIONS_VERSION };
        if (result.headerLineRegions.length > 0) {
          next.lineRegions = result.headerLineRegions;
        }
        return next;
      });
      setFooter((f) => {
        if (!f) return f;
        const next: FooterData = { ...f };
        if (result.footerLineRegions.length > 0) {
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
      void persistRehydratedRegions(targetReceiptId, result);
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

  if (loading) {
    const pct =
      matchProgress && matchProgress.total > 0
        ? Math.min(100, Math.round((matchProgress.done / matchProgress.total) * 100))
        : 0;
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>{loadingMessage}</Text>
        {matchProgress && matchProgress.total > 0 && (
          <View style={{ marginTop: 12, alignItems: "center", gap: 8 }}>
            <Text style={{ color: colors.textMuted, fontSize: 13 }}>
              {t('receiptProcess.matchProgress', { done: matchProgress.done, total: matchProgress.total })}
            </Text>
            <View
              style={{
                width: 220,
                height: 4,
                borderRadius: 2,
                backgroundColor: colors.surfaceMuted ?? "#eee",
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  backgroundColor: colors.primary,
                }}
              />
            </View>
          </View>
        )}
      </View>
    );
  }

  const processingStep = postStatus === "pending"
    ? t('receiptProcess.loadingSending')
    : uploadStatus === "pending"
    ? t('receiptProcess.loadingPhoto')
    : comparisonStatus === "pending"
    ? t('receiptProcess.loadingComparison')
    : null;

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () => {
            if (isPreviewMode) {
              return (
                <Text style={styles.navTitle} numberOfLines={1}>
                  {t('receiptProcess.titlePreview')}
                </Text>
              );
            }
            // Compose the shop line the same way the hero card used to —
            // prefer "Chain · Store" when both are known, fall back gracefully.
            const shopLine =
              (header?.chainName && header?.storeName
                ? `${header.chainName} · ${header.storeName}`
                : header?.storeName || header?.chainName) ||
              t('receiptProcess.title');
            const addr = header?.storeAddressMatched || header?.storeAddress || null;
            const dateLabel = footer?.date ? formatDate(footer.date) : null;
            const subtitle = [addr, dateLabel].filter(Boolean).join(" · ");
            return (
              <View style={styles.navHeaderWrap}>
                <Text style={styles.navTitle} numberOfLines={1}>
                  {shopLine}
                </Text>
                {!!subtitle && (
                  <Text style={styles.navSubtitle} numberOfLines={1}>
                    {subtitle}
                  </Text>
                )}
              </View>
            );
          },
        }}
      />
      {/* C2: segmented control pinned below the navbar. Lives OUTSIDE the
          per-tab ScrollViews so it stays visible while the body scrolls. */}
      <SegmentedControl
        active={activeTab}
        onChange={setActiveTab}
        productCount={products.length}
        styles={styles}
        colors={colors}
      />

      {/* ───── TAB: Suvestinė ───── */}
      {activeTab === "suvestine" && (
      <ScrollView style={styles.container}>
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
      </ScrollView>
      )}

      {/* ───── TAB: Prekės ───── */}
      {activeTab === "prekes" && (
      <ScrollView style={styles.container}>
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
            {products.length === 0 ? (
              <View style={styles.emptyProducts}>
                <Ionicons name="alert-circle-outline" size={32} color={colors.border} />
                <Text style={styles.emptyText}>{t('receiptProcess.productsEmpty')}</Text>
              </View>
            ) : (
              products.map((product, index) => {
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
                  index === products.length - 1 && styles.productRowCardLast,
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
                  {state === "S1" && product.storeProductImageUrl ? (
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
                    {state === "S1" && product.matchedName ? (
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
                  </View>
                  <View style={styles.productPriceCol}>
                    {state === "S4" ? (
                      <Text style={styles.productPrice}>—</Text>
                    ) : product.promoPrice != null &&
                      product.promoPrice < product.price ? (
                      <>
                        <Text style={styles.productPrice}>{formatEuro(totalPrice)}</Text>
                        <Text style={styles.productPriceStrike}>{formatEuro(grossTotal)}</Text>
                      </>
                    ) : (
                      <Text style={styles.productPrice}>{formatEuro(totalPrice)}</Text>
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
                            <ActivityIndicator
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
          </View>
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
      )}

      {/* ───── TAB: Kvitas ─────
          Stat grid card on top (Suma · Laikas · Kvito №) followed by
          the receipt photo with parser-region overlays. The dev-only
          chevron-to-reveal-OCR-region was dropped — the photo + bands
          are now the user-facing visual artifact, no separate dev path. */}
      {activeTab === "kvitas" && (
      <ScrollView style={styles.container}>
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
              headerRegions={
                header?.lineRegions && header.lineRegions.length > 0
                  ? header.lineRegions
                  : header?.region
                  ? [header.region]
                  : []
              }
              productRegions={products.map((p) => p.region).filter(Boolean)}
              footerRegions={
                footer?.lineRegions && footer.lineRegions.length > 0
                  ? footer.lineRegions
                  : footer?.region
                  ? [footer.region]
                  : []
              }
            />
          </>
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
      )}
      {isProcessing && (
        <View style={styles.processingOverlay} pointerEvents="auto">
          <View style={styles.processingCard}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.processingTitle}>Kvitas apdorojamas</Text>
            {!!processingStep && (
              <Text style={styles.processingStep}>{processingStep}</Text>
            )}
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
    </>
  );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
  navHeaderWrap: { alignItems: "center", maxWidth: 240 },
  navTitle: { fontSize: 15, fontWeight: "700", color: c.textPrimary },
  navSubtitle: { fontSize: 11, color: c.textSecondary, marginTop: 1 },
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

  // C2 — segmented control pinned below the navbar.
  segmentedWrap: {
    flexDirection: "row",
    backgroundColor: c.surfaceMuted,
    marginHorizontal: 16,
    marginTop: 12,
    padding: 4,
    borderRadius: 10,
    gap: 4,
  },
  segmentTab: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentTabActive: {
    backgroundColor: c.cardBackground,
    elevation: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 1,
  },
  segmentTabLabel: {
    fontSize: 13,
    fontWeight: "500",
    color: c.textSecondary,
  },
  segmentTabLabelActive: {
    color: c.textPrimary,
    fontWeight: "700",
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
