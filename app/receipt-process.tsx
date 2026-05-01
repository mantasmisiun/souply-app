import { Ionicons } from "@expo/vector-icons";
import { usePreventRemove, useNavigation, useFocusEffect } from "@react-navigation/native";
import TextRecognition from "@react-native-ml-kit/text-recognition";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { API_BASE_URL } from "../config/api";
import { getUserId } from "../config/user";
import { useReceiptComparison } from "../hooks/useReceiptComparison";
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
} from "../../shared/parsers/ikiParser";
import {
    isMaximaReceipt,
    parseMaximaHeaderOnly,
    parseMaximaReceipt,
    type MaximaFooter,
    type MaximaHeader,
    type MaximaProduct,
} from "../../shared/parsers/maximaParser";
import {
    isNorfaReceipt,
    parseNorfaHeaderOnly,
    parseNorfaReceipt,
    type NorfaFooter,
    type NorfaHeader,
    type NorfaProduct,
} from "../../shared/parsers/norfaParser";
import {
    isRimiReceipt,
    parseRimiHeaderOnly,
    parseRimiReceipt,
    Region,
    RimiFooter,
    RimiHeader,
    RimiProduct
} from "../../shared/parsers/rimiParser";
import { ocrImageTiled } from "../utils/mlkitOcr";

interface ProductMatchOption {
  storeProductId: number;
  productId: number;
  categoryId: number;
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
  unit: string;
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
}

interface FooterData {
  total: number | null;
  date: string;
  time: string;
  receiptNo: string;
  totalSavings: number | null;
  rawText: string;
  region: Region;
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
type SaveStatus = "idle" | "saving" | "saved" | "error";
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
  const { uri, uris: urisParam, receiptId: receiptIdParam, preview: previewParam } = useLocalSearchParams<{
    uri?: string;
    uris?: string;
    receiptId?: string;
    preview?: string;
  }>();
  const existingReceiptId = receiptIdParam ? Number(receiptIdParam) : null;
  const isExistingMode = Number.isFinite(existingReceiptId);

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
  const [productsExpanded, setProductsExpanded] = useState(false);
  // Save state
  const [receiptId, setReceiptId] = useState<number | null>(null);
  const [imageFilePath, setImageFilePath] = useState<string | null>(null);
  // How many swipe cards are currently waiting for this user on this receipt.
  // Fetched on mount and whenever the screen refocuses (so it updates after
  // the user returns from the swipe screen).
  const [swipeQueueCount, setSwipeQueueCount] = useState<number>(0);
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
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
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

  useEffect(() => {
    if (saveStatus !== "saved") return;
    const timer = setTimeout(() => setSaveStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [saveStatus]);
  const loadExistingReceipt = async (id: number) => {
    try {
      setLoading(true);
      isHydratingRef.current = true;
      setLoadingMessage("Įkeliami duomenys...");
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/receipts/${id}`, {
        timeoutMs: TIMEOUT_STANDARD_MS,
      });
      const receipt = await res.json();

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
        router.replace("/(tabs)/receipts");
        setTimeout(() => {
          Alert.alert(
            "Kvito duomenys sugadinti",
            "Šio kvito duomenys nebeprieinami. Pabandyk įkelti kvitą iš naujo.",
          );
        }, 100);
        return;
      }

      setHeader({
        chainName:
          parsed.header.chainName ?? receipt.chainName ?? "Neatpažinta",
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
      });

      setReceiptId(id);
      // Intentionally leave saveStatus as 'idle' on load — the badge
      // ("Išsaugoma"/"Išsaugota") should only surface on real user edits.
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
        setUploadErr(
          "Paveikslėlis nebuvo įkeltas. Pakartotinai apdoroti kvitą reikėtų iš Analizės skirtuko.",
        );
      }
      // Resolve image URL for region previews in existing-receipt mode
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
            // Existing receipts are saved as a single image; saved region
            // coords are in that image's pixel space, so frameScale=1 and
            // the full image width is used as the horizontal viewport.
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
      await fetchComparison(id);
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
    setSaveStatus("idle");
    setPostStatus("idle");
    setPostErr(null);
    setUploadStatus("idle");
    setUploadErr(null);
    setComparisonStatus("idle");
    setFirstCompleteReached(false);
    setComparison(null);
    hasPostedRef.current = false;
    comparisonKeyRef.current = "";
    shouldRefreshComparisonRef.current = false;
  }, [uri, isExistingMode, setComparison]);

  // Kick off OCR when uri is provided
  useEffect(() => {
    if (isExistingMode && existingReceiptId) {
      loadExistingReceipt(existingReceiptId);
      return;
    }

    if (imageUriList.length > 0) {
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

  // Refresh the swipe-queue count every time the receipt screen regains
  // focus (initial mount + returning from /receipt/swipe/[id]). Backend's
  // filter already excludes votes this user has cast, so the count we get
  // back IS exactly "cards remaining for this user".
  useFocusEffect(
    useMemo(
      () => () => {
        if (!receiptId) return;
        let cancelled = false;
        (async () => {
          try {
            const userId = await getUserId();
            const res = await fetch(
              `${API_BASE_URL}/api/receipts/${receiptId}/swipe-queue?userId=${encodeURIComponent(userId)}`
            );
            if (!res.ok) return;
            const data = await res.json();
            const queueSize = Array.isArray(data?.items)
              ? data.items.reduce(
                  (sum: number, it: any) =>
                    sum + (Array.isArray(it.candidates) ? it.candidates.length : 0),
                  0
                )
              : 0;
            if (!cancelled) setSwipeQueueCount(queueSize);
          } catch {
            /* swallow — it's advisory UI */
          }
        })();
        return () => {
          cancelled = true;
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
        router.replace("/(tabs)/receipts");
        setTimeout(() => {
          Alert.alert("Kvitas jau įkeltas", "Šis kvitas jau buvo įkeltas.");
        }, 100);
        return;
      }
      if (!res.ok || !data?.id) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setReceiptId(data.id);
      setSaveStatus("saved");
      setPostStatus("done");
      setComparisonStatus("pending");
      // Receipt is now persisted server-side; the draft has served
      // its purpose. Any subsequent app-kill recovery would use the
      // server's Receipt row via the Analize tab list, not the draft.
      clearReceiptDraft().catch(() => {});
      fetchComparison(data.id);
    } catch (e: any) {
      console.warn("Receipt POST failed:", e);
      setSaveStatus("error");
      setPostStatus("error");
      setPostErr(e?.message || "Nepavyko išsaugoti kvito");
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
      if (!uploadUrl || !filePath) throw new Error("upload-url atsakyme trūksta laukų");

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
      setUploadErr(e?.message || "Nepavyko įkelti nuotraukos");
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

  // Auto-retry on reconnect. When NetInfo flips offline → online,
  // fire whichever of POST / upload / comparison was previously in
  // the 'error' state. This covers the "user was on mobile data,
  // switched to Wi-Fi, the in-flight request died" field case
  // without requiring a manual tap. Only one auto-retry per online
  // transition; if that retry also fails, the user's manual retry
  // button remains the recovery path.
  const lastOnlineAt = useNetworkStatus((s) => s.lastOnlineAt);
  useEffect(() => {
    if (lastOnlineAt === null) return; // never been offline yet
    if (isPreviewMode) return;
    if (postStatus === "error") {
      retryPost();
    }
    if (uploadStatus === "error" && imageUri) {
      runUpload();
    }
    if (comparisonStatus === "error" && receiptId) {
      fetchComparison(receiptId);
    }
    // Intentionally NOT including the status flags in the dep array —
    // we only want to retry on the ONLINE TRANSITION, not every time
    // the status flag toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastOnlineAt]);

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
      Alert.alert("Nepavyko išsiųsti", "Bandykite dar kartą vėliau.");
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
        "Produktas neatpažintas",
        "Nuotraukos galima pridėti tik prie atpažintų produktų.",
      );
      return;
    }
    try {
      // Permission check — expo-image-picker v15+ refuses silently without it.
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Nėra prieigos",
          "Leiskite prieigą prie galerijos, kad pridėtumėte nuotrauką.",
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

      const patchRes = await fetch(
        `${API_BASE_URL}/api/store-products/${line.storeProductId}/image`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath }),
        },
      );
      if (!patchRes.ok) throw new Error(`image PATCH HTTP ${patchRes.status}`);
      const { imageUrl } = await patchRes.json();

      // Update the local ProductLine so the thumbnail appears immediately.
      setProducts((prev) => {
        const next = [...prev];
        if (next[lineIdx]) {
          next[lineIdx] = { ...next[lineIdx], storeProductImageUrl: imageUrl };
        }
        return next;
      });
    } catch (e: any) {
      console.warn("Photo upload failed:", e?.message ?? e);
      Alert.alert("Nuotraukos įkėlimas nepavyko", "Bandykite dar kartą.");
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
      setSaveStatus("saving");
      const userId = userIdRef.current ?? (await getUserId());
      userIdRef.current = userId;
      await fetchWithTimeout(`${API_BASE_URL}/api/receipts/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, parsedData: data }),
        timeoutMs: TIMEOUT_STANDARD_MS,
      });
      setSaveStatus("saved");

      if (shouldRefreshComparisonRef.current) {
        shouldRefreshComparisonRef.current = false;
      }
      fetchComparison(id);
    } catch (e) {
      console.warn("Save failed:", e);
      setSaveStatus("error");
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
    ocr_no_text:
      "Nepavyko nuskaityti kvito teksto. Pabandyk įkelti geresnę nuotrauką arba kitą kvitą.",
    ocr_error:
      "Įvyko klaida skaitant kvitą. Pabandyk dar kartą arba įkelk kitą kvitą.",
    chain_unrecognized:
      "Parduotuvės tinklas nebuvo atpažintas. Pabandyk įkelti geresnę nuotrauką arba kitą kvitą.",
    store_unrecognized:
      "Parduotuvė nebuvo atpažinta. Pabandyk įkelti geresnę nuotrauką arba kitą kvitą.",
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
      setLoadingMessage("Nuskaitomi ir atpažįstami duomenys");

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

      setLoadingMessage("Nuskaitomi ir atpažįstami duomenys");

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

      try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: rp.name,
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
        name: rp.name,
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
        unit: rp.unit,
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

      try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: mp.name,
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
        name: mp.name,
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
        unit: mp.unit,
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

      try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: np.name,
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
        name: np.name,
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
        unit: np.unit,
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

      try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: ip.name,
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
        name: ip.name,
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
        unit: ip.unit,
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
      chainName: "Neatpažinta",
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
  const hasAsyncError =
    postStatus === "error" ||
    uploadStatus === "error" ||
    comparisonStatus === "error";

  usePreventRemove(isProcessing, ({ data }) => {
    Alert.alert(
      "Kvitas dar apdorojamas",
      "Jei išeisite dabar, apdorojimas tęsis fone, bet galite matyti nepilną rezultatą.",
      [
        { text: "Palaukti", style: "cancel", onPress: () => {} },
        {
          text: "Išeiti",
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
              {matchProgress.done} / {matchProgress.total} prekių atpažinta
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

  // Save status badge (under the title, pill-style)
  const renderStatusBadge = () => {
    if (saveStatus === "idle") return null;
    const config = {
      saving: { bg: colors.infoMuted, color: colors.info, text: "Saugoma…" },
      saved: { bg: colors.primaryMuted, color: colors.primary, text: "Išsaugota" },
      error: { bg: colors.errorMuted, color: colors.error, text: "Nepavyko išsaugoti" },
    }[saveStatus];
    return (
      <View style={styles.statusOverlay}>
        <View style={[styles.statusBadge, { backgroundColor: config.bg }]}>
          <Text style={[styles.statusBadgeText, { color: config.color }]}>
            {config.text}
          </Text>
        </View>
      </View>
    );
  };

  const processingStep = postStatus === "pending"
    ? "Siunčiami kvito duomenys…"
    : uploadStatus === "pending"
    ? "Siunčiama nuotrauka…"
    : comparisonStatus === "pending"
    ? "Skaičiuojamas palyginimas…"
    : null;

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () => {
            if (isPreviewMode) {
              return (
                <Text style={styles.navTitle} numberOfLines={1}>
                  Kvito peržiūra (neišsaugoma)
                </Text>
              );
            }
            // Compose the shop line the same way the hero card used to —
            // prefer "Chain · Store" when both are known, fall back gracefully.
            const shopLine =
              (header?.chainName && header?.storeName
                ? `${header.chainName} · ${header.storeName}`
                : header?.storeName || header?.chainName) ||
              "Kvito analizė";
            const addr = header?.storeAddressMatched || header?.storeAddress || null;
            const dateLabel = footer?.date
              ? new Date(footer.date).toLocaleDateString("lt-LT")
              : null;
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
      <ScrollView style={styles.container}>
        {hasAsyncError && (
          <View style={styles.errorBanner}>
            <View style={styles.errorHeaderRow}>
              <Ionicons name="alert-circle" size={20} color={colors.error} />
              <Text style={styles.errorTitle}>Apdorojimas nepavyko</Text>
            </View>
            {postStatus === "error" && (
              <View style={styles.errorRow}>
                <Text style={styles.errorMsg}>
                  Kvito išsaugojimas: {postErr ?? "klaida"}
                </Text>
                <TouchableOpacity style={styles.retryBtn} onPress={retryPost}>
                  <Text style={styles.retryBtnText}>Bandyti dar kartą</Text>
                </TouchableOpacity>
              </View>
            )}
            {uploadStatus === "error" && (
              <View style={styles.errorRow}>
                <Text style={styles.errorMsg}>
                  Nuotraukos įkėlimas: {uploadErr ?? "klaida"}
                </Text>
                <TouchableOpacity style={styles.retryBtn} onPress={retryUpload}>
                  <Text style={styles.retryBtnText}>Bandyti dar kartą</Text>
                </TouchableOpacity>
              </View>
            )}
            {comparisonStatus === "error" && (
              <View style={styles.errorRow}>
                <Text style={styles.errorMsg}>
                  Palyginimas: {comparisonError ?? "klaida"}
                </Text>
                <TouchableOpacity
                  style={styles.retryBtn}
                  onPress={retryComparison}
                >
                  <Text style={styles.retryBtnText}>Bandyti dar kartą</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}
        <ReceiptComparisonSection
          comparison={comparison}
          loading={comparisonLoading && !comparison}
          error={comparisonError}
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
              "Neatpažinta parduotuvė",
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

        {/* Swipe-to-help entry point. When this receipt still has items for
            the user to act on (queue > 0), show the primary pink CTA. Once
            drained, swap to a less-accented "Man patinka padėti" button that
            routes into the cross-chain orphan queue — users who enjoyed the
            receipt swipe can keep contributing to the matching dataset.
            Preview mode never persists, so neither appears there. */}
        {receiptId && swipeQueueCount > 0 && (
          <TouchableOpacity
            style={styles.swipeEntryCard}
            activeOpacity={0.85}
            onPress={() =>
              router.push({
                pathname: "/receipt/swipe/[id]",
                params: { id: String(receiptId) },
              })
            }
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.swipeEntryCta}>Pagerink prekių atpažinimą</Text>
              <Text style={styles.swipeEntryCount}>
                Kortelių eilėje: {swipeQueueCount}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={22} color={colors.onPrimary} />
          </TouchableOpacity>
        )}
        {receiptId && swipeQueueCount === 0 && (
          <TouchableOpacity
            style={styles.swipeHelpMoreCard}
            activeOpacity={0.85}
            onPress={() => router.push("/swipe/extra")}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.swipeHelpMoreCta}>Man patinka padėti</Text>
              <Text style={styles.swipeHelpMoreSubtitle}>
                Padėk atpažinti daugiau prekių iš kitų parduotuvių
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.primary} />
          </TouchableOpacity>
        )}

        {editingSection === "header" &&
          header?.region &&
          pageMetas.length > 0 && (
            <View style={styles.editSection}>
              <Text style={styles.rawTextLabel}>Nuskaitytas regionas:</Text>
              <RegionPreview
                pages={pageMetas}
                region={header.region}
                cardWidth={CARD_WIDTH}
              />
            </View>
          )}

        {/* Products section */}
        <TouchableOpacity
          style={styles.productsHeader}
          onPress={() => setProductsExpanded((v) => !v)}
        >
          <View style={styles.productsHeaderLeft}>
            <Ionicons name="cart-outline" size={20} color={colors.primary} />
            <View style={styles.productsHeaderTextWrap}>
              <Text style={styles.productsTitle}>
                Prekės ({products.length})
              </Text>
            </View>
          </View>
          <Ionicons
            name={productsExpanded ? "chevron-up" : "chevron-down"}
            size={18}
            color={colors.textSecondary}
          />
        </TouchableOpacity>
        {productsExpanded && (
          <>
            {products.map((product, index) => (
              <TouchableOpacity
                key={index}
                style={[
                  styles.productRowCard,
                  index === products.length - 1 && styles.productRowCardLast,
                ]}
                activeOpacity={canExpandProduct(product) ? 0.7 : 1}
                onPress={
                  canExpandProduct(product)
                    ? () =>
                        setEditingSection(
                          editingSection === index ? null : index,
                        )
                    : undefined
                }
              >
                {/* Dev-only band crop: shows the OCR region this row's
                    data was extracted from, sliced from the receipt
                    image. Gated by __DEV__ so release bundles strip
                    the entire branch at Metro bundle time. */}
                {__DEV__ &&
                  pageMetas.length > 0 &&
                  product.region &&
                  product.region.yBottom > product.region.yTop && (
                    <View style={styles.productBandCropWrap}>
                      <RegionPreview
                        pages={pageMetas}
                        region={product.region}
                        cardWidth={CARD_WIDTH}
                      />
                    </View>
                  )}
                <View style={styles.productRow}>
                  {product.matchConfirmed && product.storeProductImageUrl ? (
                    <Image
                      source={{ uri: product.storeProductImageUrl }}
                      style={styles.productThumb}
                      resizeMode="contain"
                    />
                  ) : (
                    <View style={styles.productThumbPlaceholder}>
                      <Text style={styles.productThumbEmoji}>🥦</Text>
                    </View>
                  )}
                  <View style={styles.productInfo}>
                    {product.matchConfirmed && product.matchedName ? (
                      <Text style={styles.matchedName}>
                        <Ionicons
                          name="checkmark-circle"
                          size={16}
                          color={colors.primary}
                        />
                        {"  "}
                        {product.matchedName}
                      </Text>
                    ) : (
                      <Text style={styles.productName}>
                        <Ionicons
                          name={
                            isCompletelyUnrecognized(product)
                              ? "help-circle"
                              : "alert-circle"
                          }
                          size={16}
                          color={
                            isCompletelyUnrecognized(product)
                              ? colors.error
                              : colors.warning
                          }
                        />
                        {"  "}
                        {product.name}
                      </Text>
                    )}
                    <Text style={styles.productQuantity}>
                      {formatAmountLabel(product)}
                    </Text>
                  </View>
                  <View style={styles.productPriceCol}>
                    {product.promoPrice != null &&
                    product.promoPrice < product.price ? (
                      <>
                        <Text style={styles.productPrice}>
                          {(product.promoPrice * product.quantity).toFixed(2)} €
                        </Text>
                        <Text style={styles.productPriceStrike}>
                          {(product.price * product.quantity).toFixed(2)} €
                        </Text>
                      </>
                    ) : (
                      <Text style={styles.productPrice}>
                        {(product.price * product.quantity).toFixed(2)} €
                      </Text>
                    )}
                  </View>
                  <TouchableOpacity
                    style={styles.productRowMenuBtn}
                    onPress={(e) => {
                      e.stopPropagation?.();
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
                            placeholder="Įveskite produkto pavadinimą"
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
            ))}
          </>
        )}
        {products.length === 0 && (
          <View style={styles.emptyProducts}>
            <Ionicons name="alert-circle-outline" size={32} color={colors.border} />
            <Text style={styles.emptyText}>Prekės neatpažintos</Text>
          </View>
        )}

        {/* Footer section */}
        <TouchableOpacity
          style={styles.sectionCard}
          onPress={() =>
            setEditingSection(editingSection === "footer" ? null : "footer")
          }
        >
          <View style={styles.sectionHeader}>
            <Ionicons name="document-text-outline" size={20} color={colors.primary} />
            <Text style={styles.sectionTitle}>Kvito duomenys</Text>
            <Ionicons
              name={editingSection === "footer" ? "chevron-up" : "chevron-down"}
              size={18}
              color={colors.textSecondary}
            />
          </View>
          <View style={styles.footerContent}>
            <View style={styles.footerRow}>
              <Text style={styles.footerLabel}>Suma:</Text>
              <Text style={styles.footerValue}>
                {footer?.total ? `€${footer.total.toFixed(2)}` : "—"}
              </Text>
            </View>
            <View style={styles.footerRow}>
              <Text style={styles.footerLabel}>Data:</Text>
              <Text style={styles.footerValue}>
                {footer?.date || "—"} {footer?.time || ""}
              </Text>
            </View>
            <View style={styles.footerRow}>
              <Text style={styles.footerLabel}>Kvito Nr.:</Text>
              <Text style={styles.footerValue}>{footer?.receiptNo || "—"}</Text>
            </View>
          </View>
          {editingSection === "footer" &&
            footer?.region &&
            pageMetas.length > 0 && (
              <View style={styles.editSection}>
                <Text style={styles.rawTextLabel}>Nuskaitytas regionas:</Text>
                <RegionPreview
                  pages={pageMetas}
                  region={footer.region}
                  cardWidth={CARD_WIDTH}
                />
              </View>
            )}
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
      {renderStatusBadge()}
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
                        <Text style={styles.sheetItemText}>Pridėti nuotrauką</Text>
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
                      <Text style={styles.sheetCancelText}>Atšaukti</Text>
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
                <Text style={styles.issueModalBtnTextSecondary}>Atšaukti</Text>
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
                <Text style={styles.issueModalBtnTextPrimary}>Siųsti</Text>
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
  productRowCard: {
    backgroundColor: c.cardBackground,
    marginHorizontal: 16,
    marginTop: 0,
    borderRadius: 0,
    padding: 14,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: c.borderSubtle,
  },
  productRowCardLast: {
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
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
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.pageBackground,
    gap: 16,
  },
  loadingText: { fontSize: 15, color: c.textSecondary },

  statusBadgeWrap: {
    alignItems: "center",
    marginTop: 12,
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: "600",
  },

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

  footerContent: { marginTop: 10 },
  footerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
  footerLabel: { fontSize: 13, color: c.textSecondary },
  footerValue: { fontSize: 13, fontWeight: "600", color: c.textPrimary },

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
  statusOverlay: {
    position: "absolute",
    top: 12,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 50,
    elevation: 50,
    pointerEvents: "none",
  },
});
