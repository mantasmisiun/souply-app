import { Ionicons } from "@expo/vector-icons";
import { usePreventRemove, useNavigation } from "@react-navigation/native";
import TextRecognition from "@react-native-ml-kit/text-recognition";
import * as ImageManipulator from "expo-image-manipulator";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Dimensions,
    Image,
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
import { useTheme, type AppTheme } from "../constants/theme";
import {
    useReceiptCreateContext,
    useReceiptPickerState,
} from "../state/basketState";
import {
    isIkiReceipt,
    parseIkiHeaderOnly,
    parseIkiReceipt,
    type IkiFooter,
    type IkiHeader,
    type IkiProduct,
} from "../utils/ikiParser";
import {
    isMaximaReceipt,
    parseMaximaHeaderOnly,
    parseMaximaReceipt,
    type MaximaFooter,
    type MaximaHeader,
    type MaximaProduct,
} from "../utils/maximaParser";
import {
    isRimiReceipt,
    parseRimiHeaderOnly,
    parseRimiReceipt,
    Region,
    RimiFooter,
    RimiHeader,
    RimiProduct
} from "../utils/rimiParser";

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
  const isHydratingRef = useRef(false);
  const [priceEditorIndex, setPriceEditorIndex] = useState<number | null>(null);
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
  const canExpandProduct = (p: ProductLine) =>
    isFullyRecognized(p) || isCompletelyUnrecognized(p);

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
      if (priceEditorIndex === editingSection) setPriceEditorIndex(null);
    }
  }, [products, editingSection, priceEditorIndex]);
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
      const res = await fetch(
        `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
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
      const res = await fetch(`${API_BASE_URL}/api/receipts/${id}`);
      const receipt = await res.json();

      const parsed =
        typeof receipt.parsedData === "string"
          ? JSON.parse(receipt.parsedData)
          : receipt.parsedData;

      if (
        !parsed?.header ||
        !parsed?.footer ||
        !Array.isArray(parsed?.products)
      ) {
        throw new Error("Receipt parsedData is missing required fields");
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
      setSaveStatus("saved");
      hasPostedRef.current = true;

      if (parsed?.image?.filePath) {
        setImageFilePath(parsed.image.filePath);
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
      processReceipt(imageUriList);
    }
  }, [imageUriList, isExistingMode, existingReceiptId]);

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

      const res = await fetch(`${API_BASE_URL}/api/receipts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, filePath: "", parsedData }),
      });
      const data = await res.json();
      // Duplicate detection (e.g. re-photographing the same IKI receipt).
      // Navigate to the existing receipt instead of creating a parallel one.
      if (res.status === 409 && data?.existingReceiptId) {
        Alert.alert(
          "Kvitas jau įkeltas",
          "Šis kvitas jau yra jūsų sąraše. Atidarome ankstesnį įrašą.",
          [
            {
              text: "Gerai",
              onPress: () =>
                router.replace({
                  pathname: "/receipt-process",
                  params: { receiptId: String(data.existingReceiptId) },
                }),
            },
          ],
        );
        setPostStatus("done");
        return;
      }
      if (!res.ok || !data?.id) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setReceiptId(data.id);
      setSaveStatus("saved");
      setPostStatus("done");
      setComparisonStatus("pending");
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
      const urlRes = await fetch(`${API_BASE_URL}/api/receipts/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: `receipt-${receiptId}.jpg`,
          mimeType: "image/jpeg",
        }),
      });
      if (!urlRes.ok) throw new Error(`upload-url HTTP ${urlRes.status}`);
      const { uploadUrl, filePath } = await urlRes.json();
      if (!uploadUrl || !filePath) throw new Error("upload-url atsakyme trūksta laukų");

      const imageBlob = await (await fetch(imageUri)).blob();
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: imageBlob,
      });
      if (!putRes.ok) throw new Error(`MinIO PUT HTTP ${putRes.status}`);

      const patchRes = await fetch(`${API_BASE_URL}/api/receipts/${receiptId}/file-path`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath }),
      });
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
  const applyAltMatch = (productIndex: number, alt: ProductMatchOption) => {
    setProducts((prev) => {
      if (productIndex < 0 || productIndex >= prev.length) return prev;
      const updated = [...prev];
      updated[productIndex] = {
        ...updated[productIndex],
        matchedName: alt.name,
        storeProductId: alt.storeProductId,
        storeProductImageUrl: alt.imageUrl,
        matchConfidence: alt.confidence,
        matchConfirmed: true,
        priceVerified: false,
      };
      return updated;
    });
  };
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
        // Fire and forget — component is tearing down, can't await
        fetch(`${API_BASE_URL}/api/receipts/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, parsedData: snapshot }),
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
      await fetch(`${API_BASE_URL}/api/receipts/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, parsedData: data }),
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

  const handleBrowseCategories = async (idx: number) => {
    const product = products[idx];
    const topMatch = product.altMatches[0];

    // Guard: need a resolved chain + store + receipt to meaningfully create/link products.
    const chainId = header?.chainId;
    const storeId = header?.storeId;
    if (
      !Number.isFinite(chainId) ||
      !Number.isFinite(storeId) ||
      !Number.isFinite(receiptId)
    ) {
      Alert.alert(
        "Palaukite",
        "Parduotuvė ar kvitas dar neatpažinti. Pabandykite po akimirkos.",
      );
      return;
    }

    setCreateContext({
      receiptId: Number(receiptId),
      storeId: Number(storeId),
      chainId: Number(chainId),
      receiptDate: footer?.date ?? null,
      ocrName: product.name,
      ocrPrice: Number(product.price),
      ocrPromoPrice:
        product.promoPrice === null || product.promoPrice === undefined
          ? null
          : Number(product.promoPrice),
      ocrQuantity: Number(product.quantity),
      ocrUnit: product.unit || null,
      ocrIsWeighable: product.pricePerUnit !== null,
    });

    let preselectL1: string | undefined;
    let preselectL2: string | undefined;
    let preselectL3: string | undefined;

    if (topMatch) {
      try {
        const res = await fetch(
          `${API_BASE_URL}/api/categories/${topMatch.categoryId}/ancestors`,
        );
        const data = await res.json();
        if (data?.l1) preselectL1 = String(data.l1.id);
        if (data?.l2) preselectL2 = String(data.l2.id);
        if (data?.l3) preselectL3 = String(data.l3.id);
      } catch (e) {
        console.warn("Ancestor lookup failed:", e);
      }
    }

    if (preselectL1 && preselectL2) {
      router.push({
        pathname: "/receipt/browse",
        params: {
          chainId: String(chainId),
          productIndex: String(idx),
          preselectL1,
          ocrName: product.name,
        },
      });
      setTimeout(() => {
        router.push({
          pathname: "/receipt/browse/[categoryId]",
          params: {
            categoryId: preselectL2!,
            name: "",
            chainId: String(chainId),
            productIndex: String(idx),
            ocrName: product.name,
            ...(preselectL3 ? { preselectL3 } : {}),
          },
        });
      }, 50);
    } else {
      router.push({
        pathname: "/receipt/browse",
        params: {
          chainId: String(chainId),
          productIndex: String(idx),
          ocrName: product.name,
        },
      });
    }
  };

  const processReceipt = async (imageUris: string[]) => {
    try {
      setLoading(true);
      setLoadingMessage("Atpažįstamas tekstas...");

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

        const pageDims = await new Promise<{ width: number; height: number }>(
          (resolve, reject) => {
            Image.getSize(
              pageUri,
              (width, height) => resolve({ width, height }),
              reject,
            );
          },
        );
        if (pageIdx === 0) firstPageDims = pageDims;

        const pageResult = await TextRecognition.recognize(pageUri);

        let mlkitMaxX = 0;
        let mlkitMaxY = 0;
        for (const block of pageResult.blocks) {
          for (const line of block.lines) {
            if (line.frame) {
              mlkitMaxX = Math.max(mlkitMaxX, line.frame.left + line.frame.width);
              mlkitMaxY = Math.max(mlkitMaxY, line.frame.top + line.frame.height);
            }
          }
        }

        const scaleX = mlkitMaxX > 0 ? pageDims.width / mlkitMaxX : 1;
        const scaleY = mlkitMaxY > 0 ? pageDims.height / mlkitMaxY : 1;
        // Android's BitmapFactory auto-downsamples large bitmaps by a power
        // of 2 before handing them to Image.getSize, while MLKit reads the
        // full-resolution file. So the true MLKit→pixel scale is always a
        // simple fraction (1, 1/2, 1/4, 1/8). We estimate from the tightest
        // axis (whichever text fills more fully) then round to the nearest
        // fraction — otherwise the few-percent drift from text not quite
        // reaching the page edge shifts every region ~1 text line down.
        const estimatedScale = Math.min(1, scaleX, scaleY);
        const roundedInv = Math.max(
          1,
          Math.min(8, Math.round(1 / estimatedScale)),
        );
        const frameScale = 1 / roundedInv;
        if (pageIdx === 0) combinedFrameScale = frameScale;

        console.log(`=== PAGE ${pageIdx + 1}/${imageUris.length} ===`);
        console.log(`Image dims: ${pageDims.width} x ${pageDims.height}`);
        console.log(`MLKit max: ${mlkitMaxX} x ${mlkitMaxY}`);
        console.log(
          `Scale X: ${scaleX.toFixed(3)}, Y: ${scaleY.toFixed(3)}, using: ${frameScale.toFixed(3)}, yOffset: ${yOffset.toFixed(0)}`,
        );

        let pageMaxYScaled = 0;
        const pageLineBounds: { l: number; r: number }[] = [];
        for (const block of pageResult.blocks) {
          for (const line of block.lines) {
            if (line.frame && line.text.trim()) {
              const yTopScaled = line.frame.top * frameScale;
              const yBottomScaled = (line.frame.top + line.frame.height) * frameScale;
              const xLeftScaled = line.frame.left * frameScale;
              const xRightScaled = (line.frame.left + line.frame.width) * frameScale;
              if (yBottomScaled > pageMaxYScaled) pageMaxYScaled = yBottomScaled;
              pageLineBounds.push({ l: xLeftScaled, r: xRightScaled });
              allLines.push({
                text: line.text.trim(),
                yTop: yTopScaled + yOffset,
                yBottom: yBottomScaled + yOffset,
                xLeft: xLeftScaled,
                xRight: xRightScaled,
              });
            }
          }
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

      setLoadingMessage("Analizuojama struktūra...");

      if (isRimiReceipt(lineTexts)) {
        const earlyHeader = parseRimiHeaderOnly(mergedLines);
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
        setLoading(false);

        const parsed = parseRimiReceipt(mergedLines);
        await applyRimiResult(parsed.header, parsed.products, parsed.footer);
      } else if (isMaximaReceipt(lineTexts)) {
        const earlyHeader = parseMaximaHeaderOnly(mergedLines);
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
        setLoading(false);

        const parsed = parseMaximaReceipt(mergedLines);
        await applyMaximaResult(parsed.header, parsed.products, parsed.footer);
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
        setLoading(false);

        const parsed = parseIkiReceipt(mergedLines);
        await applyIkiResult(parsed.header, parsed.products, parsed.footer);
      } else {
        applyGenericResult(lineTexts);
        setLoading(false);
      }
    } catch (error) {
      console.error("OCR error:", error);
      setLoadingMessage("Klaida apdorojant kvitą");
      setLoading(false);
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
        const res = await fetch(url);
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

    const matchPromises = rProducts.map(async (rp) => {
      let altMatches: ProductMatchOption[] = [];

      try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: rp.name,
        });
        const res = await fetch(
          `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
        );
        const data = await res.json();
        if (Array.isArray(data?.matches)) altMatches = data.matches;
      } catch (e) {
        console.warn(`Product match failed for "${rp.name}":`, e);
      }

      const top = altMatches[0] || null;
      const autoApply = top !== null && top.confidence >= AUTO_APPLY_THRESHOLD;

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
        const res = await fetch(url);
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

    const matchPromises = mProducts.map(async (mp) => {
      let altMatches: ProductMatchOption[] = [];

      try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: mp.name,
        });
        const res = await fetch(
          `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
        );
        const data = await res.json();
        if (Array.isArray(data?.matches)) altMatches = data.matches;
      } catch (e) {
        console.warn(`Product match failed for "${mp.name}":`, e);
      }

      const top = altMatches[0] || null;
      const autoApply = top !== null && top.confidence >= AUTO_APPLY_THRESHOLD;

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
        const res = await fetch(url);
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

    const matchPromises = iProducts.map(async (ip) => {
      let altMatches: ProductMatchOption[] = [];

      try {
        const params = new URLSearchParams({
          chainId: String(chainId),
          name: ip.name,
        });
        const res = await fetch(
          `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
        );
        const data = await res.json();
        if (Array.isArray(data?.matches)) altMatches = data.matches;
      } catch (e) {
        console.warn(`Product match failed for "${ip.name}":`, e);
      }

      const top = altMatches[0] || null;
      const autoApply = top !== null && top.confidence >= AUTO_APPLY_THRESHOLD;

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
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>{loadingMessage}</Text>
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
          title: isPreviewMode ? "Kvito peržiūra (neišsaugoma)" : "Kvito analizė",
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

        {/* Swipe-to-help entry point. Only shown once the receipt is persisted
            (receiptId is set) and there's at least one product to potentially
            validate. Preview mode never persists, so this never appears there. */}
        {receiptId && products.length > 0 && (
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
              <Text style={styles.swipeEntryCount}>
                Atpažintos prekės{" "}
                {products.filter((p) => p.matchConfirmed).length} / {products.length}
              </Text>
              <Text style={styles.swipeEntryCta}>Padėk atpažinti</Text>
            </View>
            <Ionicons name="chevron-forward" size={22} color={colors.onPrimary} />
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
              <Text style={styles.productsHint}>
                Padėkite atpažinti prekes tikslesnei analizei.
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
                      <>
                        <Text style={styles.matchedName}>
                          <Ionicons
                            name="checkmark-circle"
                            size={16}
                            color={colors.primary}
                          />
                          {"  "}
                          {product.matchedName}
                        </Text>
                        <Text style={styles.ocrName}>{product.name}</Text>
                      </>
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
                    {product.quantity !== 1 && (
                      <Text style={styles.productQuantity}>
                        {product.quantity} {product.unit}
                        {product.pricePerUnit
                          ? ` × €${product.pricePerUnit.toFixed(2)}/${product.unit}`
                          : ""}
                      </Text>
                    )}
                  </View>
                  <View style={styles.productPriceCol}>
                    <Text style={styles.productPrice}>
                      €
                      {(
                        (product.promoPrice ?? product.price) *
                        product.quantity
                      ).toFixed(2)}
                    </Text>
                  </View>
                </View>
                {!product.matchConfirmed && product.altMatches.length > 0 && (
                  <View style={styles.inlineMatchSection}>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.optionCardsRow}
                    >
                      {product.altMatches.slice(0, 3).map((alt) => {
                        const selected =
                          product.storeProductId === alt.storeProductId;
                        const shownPrice = alt.promoPrice ?? alt.price ?? null;

                        return (
                          <TouchableOpacity
                            key={alt.storeProductId}
                            style={[
                              styles.optionCard,
                              selected && styles.optionCardSelected,
                            ]}
                            onPress={() => applyAltMatch(index, alt)}
                          >
                            {alt.imageUrl ? (
                              <Image
                                source={{ uri: alt.imageUrl }}
                                style={styles.optionCardImage}
                                resizeMode="contain"
                              />
                            ) : (
                              <View style={styles.optionCardImagePlaceholder} />
                            )}
                            <Text
                              numberOfLines={2}
                              style={styles.optionCardName}
                            >
                              {alt.name}
                            </Text>
                            <Text style={styles.optionCardMeta}>
                              {typeof shownPrice === "number"
                                ? `€${shownPrice.toFixed(2)}`
                                : `Tikimybė ${Math.round(alt.confidence * 100)}%`}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}

                      <TouchableOpacity
                        style={styles.optionCard}
                        onPress={() => handleBrowseCategories(index)}
                      >
                        <View style={styles.optionCardEmojiWrap}>
                          <Text style={styles.optionCardEmoji}>🥦</Text>
                          <Ionicons
                            name="add-circle"
                            size={22}
                            color={colors.primary}
                            style={styles.optionCardAddIcon}
                          />
                        </View>
                        <Text
                          numberOfLines={2}
                          style={styles.optionCardName}
                        >
                          Ieškoti kito produkto
                        </Text>
                      </TouchableOpacity>
                    </ScrollView>
                  </View>
                )}

                {editingSection === index && canExpandProduct(product) && (
                  <View style={styles.editSection}>
                    {isCompletelyUnrecognized(product) && (
                      <View style={styles.unrecognizedBlock}>
                        <Text style={styles.rawTextLabel}>
                          Nuskaitytas regionas:
                        </Text>
                        {pageMetas.length > 0 && (
                          <View style={styles.regionPreviewWrap}>
                            <RegionPreview
                              pages={pageMetas}
                              region={product.region}
                              cardWidth={CARD_WIDTH - 40}
                            />
                          </View>
                        )}

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
                    {priceEditorIndex === index && (
                      <View style={styles.priceEditorInline}>
                        {!isCompletelyUnrecognized(product) && (
                          <>
                            <Text style={styles.rawTextLabel}>
                              Nuskaitytas regionas:
                            </Text>
                            {pageMetas.length > 0 && (
                              <View style={styles.regionPreviewWrap}>
                                <RegionPreview
                                  pages={pageMetas}
                                  region={product.region}
                                  cardWidth={CARD_WIDTH - 40}
                                />
                              </View>
                            )}
                            <View style={{ height: 10 }} />
                          </>
                        )}

                        <View style={styles.editRow}>
                          <View style={styles.editField}>
                            <Text style={styles.editLabel}>Kaina</Text>
                            <TextInput
                              style={styles.editInput}
                              value={product.price.toString()}
                              onChangeText={(text) => {
                                setProducts((prev) => {
                                  const updated = [...prev];
                                  updated[index] = {
                                    ...updated[index],
                                    price: parseFloat(text) || 0,
                                    priceVerified: false,
                                  };
                                  return updated;
                                });
                              }}
                              keyboardType="decimal-pad"
                            />
                          </View>

                          <View style={styles.editField}>
                            <Text style={styles.editLabel}>Galutinė kaina</Text>
                            <TextInput
                              style={styles.editInput}
                              value={product.promoPrice?.toString() || ""}
                              onChangeText={(text) => {
                                setProducts((prev) => {
                                  const updated = [...prev];
                                  updated[index] = {
                                    ...updated[index],
                                    promoPrice: text
                                      ? parseFloat(text) || null
                                      : null,
                                    priceVerified: false,
                                  };
                                  return updated;
                                });
                              }}
                              keyboardType="decimal-pad"
                              placeholder="—"
                            />
                          </View>
                        </View>
                      </View>
                    )}
                    <View style={styles.actionsRow}>
                      <TouchableOpacity
                        style={[
                          styles.actionButton,
                          priceEditorIndex === index &&
                            styles.actionButtonPrimary,
                        ]}
                        onPress={() => {
                          if (priceEditorIndex === index) {
                            setPriceEditorIndex(null); // collapse editor, autosave already handles persistence
                          } else {
                            setPriceEditorIndex(index);
                          }
                        }}
                      >
                        <Ionicons
                          name={
                            priceEditorIndex === index
                              ? "checkmark"
                              : "pricetag-outline"
                          }
                          size={16}
                          color={
                            priceEditorIndex === index ? colors.onPrimary : colors.primary
                          }
                        />
                        <Text
                          style={[
                            styles.actionButtonText,
                            priceEditorIndex === index &&
                              styles.actionButtonTextPrimary,
                          ]}
                        >
                          {priceEditorIndex === index
                            ? "Patvirtinti"
                            : "Netinkama kaina"}
                        </Text>
                      </TouchableOpacity>

                      {priceEditorIndex !== index && (
                        <TouchableOpacity
                          style={styles.actionButton}
                          onPress={() => handleBrowseCategories(index)}
                        >
                          <Ionicons
                            name="grid-outline"
                            size={16}
                            color={colors.primary}
                          />
                          <Text style={styles.actionButtonText}>
                            Surasti produktą
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
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
    </>
  );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
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
  swipeEntryCount: {
    color: c.onPrimary,
    opacity: 0.9,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  swipeEntryCta: {
    color: c.onPrimary,
    fontSize: 17,
    fontWeight: "700",
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
  inlineMatchSection: {
    marginTop: 10,
    gap: 10,
  },
  optionCardsRow: {
    gap: 10,
    paddingRight: 16,
  },
  optionCard: {
    width: 150,
    backgroundColor: c.cardBackground,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    padding: 10,
  },
  optionCardSelected: {
    borderColor: c.primary,
    borderWidth: 2,
    backgroundColor: c.primaryMuted,
  },
  optionCardImage: {
    width: "100%",
    height: 70,
    borderRadius: 6,
    backgroundColor: c.surfaceSubtle,
    marginBottom: 8,
  },
  optionCardImagePlaceholder: {
    width: "100%",
    height: 70,
    borderRadius: 6,
    backgroundColor: c.surfaceMuted,
    marginBottom: 8,
  },
  optionCardEmojiWrap: {
    position: "relative",
    width: "100%",
    height: 70,
    borderRadius: 6,
    backgroundColor: c.surfaceMuted,
    marginBottom: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  optionCardEmoji: {
    fontSize: 40,
    opacity: 0.4,
  },
  optionCardAddIcon: {
    position: "absolute",
    right: 4,
    bottom: 4,
    backgroundColor: c.cardBackground,
    borderRadius: 11,
  },
  optionCardName: {
    fontSize: 12,
    fontWeight: "600",
    color: c.textPrimary,
  },
  optionCardMeta: {
    marginTop: 6,
    fontSize: 12,
    color: c.textSecondary,
    fontWeight: "600",
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
  productPriceCol: { alignItems: "flex-end", marginRight: 8 },
  productPrice: { fontSize: 15, fontWeight: "700", color: c.textPrimary },

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
