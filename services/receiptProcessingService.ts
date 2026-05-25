import TextRecognition from "@react-native-ml-kit/text-recognition";
import * as ImageManipulator from "expo-image-manipulator";
import { Image } from "react-native";
import { parseProductName } from "@shared/parsers/productNameParser";
import { ocrImageTiled } from "../utils/mlkitOcr";
import { API_BASE_URL } from "../config/api";
import { getUserId } from "../config/user";
import {
  fetchWithTimeout,
  TIMEOUT_FAST_MS,
  TIMEOUT_HEAVY_MS,
  TIMEOUT_STANDARD_MS,
} from "../utils/fetchWithTimeout";
import {
  isIkiReceipt,
  parseIkiReceipt,
  type IkiProduct,
} from "@shared/parsers/ikiParser";
import {
  isMaximaReceipt,
  parseMaximaReceipt,
  type MaximaProduct,
} from "@shared/parsers/maximaParser";
import {
  isLidlReceipt,
  parseLidlReceipt,
  type LidlProduct,
} from "@shared/parsers/lidlParser";
import {
  isNorfaReceipt,
  parseNorfaReceipt,
  type NorfaProduct,
} from "@shared/parsers/norfaParser";
import {
  isRimiReceipt,
  parseRimiReceipt,
  type LabeledRegion,
  type Region,
} from "@shared/parsers/rimiParser";
import { REGIONS_VERSION } from "./regionsRehydrationService";

export interface ProcessingResult {
  receiptId: number;
  mandatorySwipesRequired: number;
}

export type ProcessingFailReason =
  | "ocr_no_text"
  | "ocr_error"
  | "chain_unrecognized"
  | "store_unrecognized"
  | "post_failed";

export class ProcessingError extends Error {
  constructor(
    public readonly reason: ProcessingFailReason,
    message: string,
  ) {
    super(message);
    this.name = "ProcessingError";
  }
}

const AUTO_APPLY_THRESHOLD = 0.85;

interface LineWithFrame {
  text: string;
  yTop: number;
  yBottom: number;
  xLeft: number;
  xRight: number;
}

interface MatchedProduct {
  name: string;
  matchedName: string | null;
  storeProductId: number | null;
  storeProductImageUrl: string | null;
  matchConfidence: number | null;
  matchConfirmed: boolean;
  priceVerified: boolean;
  altMatches: unknown[];
  price: number;
  promoPrice: number | null;
  quantity: number;
  unit: string | null;
  amount: number | null;
  sizeUnit: string | null;
  pricePerUnit: number | null;
  rawLines: string[];
  region: Region;
}

async function rotatePortrait(uri: string): Promise<string> {
  const dims = await new Promise<{ width: number; height: number }>(
    (resolve, reject) => {
      Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
    },
  );
  if (dims.height >= dims.width) return uri;
  const [cw, ccw] = await Promise.all([
    ImageManipulator.manipulateAsync(uri, [{ rotate: 90 }], {
      compress: 1,
      format: ImageManipulator.SaveFormat.JPEG,
    }),
    ImageManipulator.manipulateAsync(uri, [{ rotate: -90 }], {
      compress: 1,
      format: ImageManipulator.SaveFormat.JPEG,
    }),
  ]);
  const [ocrCW, ocrCCW] = await Promise.all([
    TextRecognition.recognize(cw.uri),
    TextRecognition.recognize(ccw.uri),
  ]);
  const countLines = (r: { blocks: { lines: unknown[] }[] }) =>
    r.blocks.reduce((s, b) => s + b.lines.length, 0);
  return countLines(ocrCW) >= countLines(ocrCCW) ? cw.uri : ccw.uri;
}

async function ocrAllPages(imageUris: string[]): Promise<{
  allLines: LineWithFrame[];
  mergedLines: LineWithFrame[];
  frameScale: number;
  /** First page, post-rotation: this is what we upload + crop against. */
  firstPageUri: string;
  firstPageWidth: number;
  firstPageHeight: number;
}> {
  const allLines: LineWithFrame[] = [];
  let frameScale = 1;
  let yOffset = 0;
  let firstPageUri = imageUris[0] ?? "";
  let firstPageWidth = 0;
  let firstPageHeight = 0;

  for (let pageIdx = 0; pageIdx < imageUris.length; pageIdx++) {
    const pageUri = await rotatePortrait(imageUris[pageIdx]);
    const ocr = await ocrImageTiled(pageUri);
    if (pageIdx === 0) {
      frameScale = ocr.frameScale;
      firstPageUri = pageUri;
      firstPageWidth = ocr.pixelWidth;
      firstPageHeight = ocr.pixelHeight;
    }

    let pageMaxYScaled = 0;
    for (const line of ocr.lines) {
      if (line.yBottom > pageMaxYScaled) pageMaxYScaled = line.yBottom;
      allLines.push({
        text: line.text,
        yTop: line.yTop + yOffset,
        yBottom: line.yBottom + yOffset,
        xLeft: line.xLeft,
        xRight: line.xRight,
      });
    }
    yOffset += pageMaxYScaled + 50;
  }

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

  return { allLines, mergedLines, frameScale, firstPageUri, firstPageWidth, firstPageHeight };
}

/**
 * Map a local file URI to the MIME type the server-side presigner expects.
 * Lidl receipts are PNG natively (we receive them via Share Extension or
 * file pick); cameraphone scans land as JPEG; PDF pages come back from
 * `/api/receipts/pdf-to-image` as PNG. Sending the wrong Content-Type
 * lets MinIO serve the blob with a mismatched header, which can confuse
 * downstream consumers (and made the per-product dev crop silently
 * blank for Lidl because the receipt-image endpoint produced nothing).
 */
function detectMimeAndExt(uri: string): { mimeType: string; ext: "jpg" | "png" } {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".png")) return { mimeType: "image/png", ext: "png" };
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return { mimeType: "image/jpeg", ext: "jpg" };
  }
  // Default to JPEG — that's what the camera + ImageManipulator emit.
  return { mimeType: "image/jpeg", ext: "jpg" };
}

/**
 * Upload the receipt's first-page image to MinIO and PATCH the receipt
 * row with its filePath. Mirrors the legacy `runUpload` from
 * receipt-process.tsx. Multi-page PDFs only upload page 1 — same as
 * the legacy flow; the dev band crop is only useful for first-page
 * products anyway.
 *
 * Errors are logged but not thrown: a failed image upload leaves the
 * receipt fully usable (data is in the DB), it just means the per-
 * product band crop won't render. The user can re-upload the photo
 * from the dev-only retry path on the receipt detail screen.
 */
async function uploadReceiptImage(
  receiptId: number,
  imageUri: string,
  signal: AbortSignal,
): Promise<void> {
  if (!imageUri) return;
  const { mimeType, ext } = detectMimeAndExt(imageUri);
  try {
    const urlRes = await fetchWithTimeout(
      `${API_BASE_URL}/api/receipts/upload-url`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: `receipt-${receiptId}.${ext}`,
          mimeType,
        }),
        timeoutMs: TIMEOUT_STANDARD_MS,
        externalSignal: signal,
      },
    );
    if (!urlRes.ok) throw new Error(`upload-url HTTP ${urlRes.status}`);
    const { uploadUrl, filePath } = await urlRes.json();
    if (!uploadUrl || !filePath) {
      throw new Error("upload-url response missing fields");
    }

    // fetch on file:// is local I/O — no timeout needed.
    const imageBlob = await (await fetch(imageUri)).blob();
    const putRes = await fetchWithTimeout(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": mimeType },
      body: imageBlob,
      timeoutMs: TIMEOUT_HEAVY_MS,
      externalSignal: signal,
    });
    if (!putRes.ok) throw new Error(`MinIO PUT HTTP ${putRes.status}`);

    const patchRes = await fetchWithTimeout(
      `${API_BASE_URL}/api/receipts/${receiptId}/file-path`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath }),
        timeoutMs: TIMEOUT_STANDARD_MS,
        externalSignal: signal,
      },
    );
    if (!patchRes.ok) throw new Error(`PATCH HTTP ${patchRes.status}`);
  } catch (e) {
    console.warn(`[uploadReceiptImage] failed for receipt ${receiptId}:`, e);
  }
}

async function matchStore(
  chainId: number,
  storeAddress: string | null,
  signal: AbortSignal,
): Promise<{ storeId: number; storeName: string | null; storeAddressMatched: string | null; matchConfidence: number | null } | null> {
  if (!storeAddress) return null;
  try {
    const url = `${API_BASE_URL}/api/stores/match?chainId=${chainId}&address=${encodeURIComponent(storeAddress)}`;
    const res = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_STANDARD_MS, externalSignal: signal });
    const data = await res.json();
    if (data?.match) {
      return {
        storeId: data.match.storeId,
        storeName: data.match.storeName,
        storeAddressMatched: data.match.address,
        matchConfidence: data.match.confidence,
      };
    }
  } catch (e) {
    console.warn("Store match failed:", e);
  }
  return null;
}

async function matchProducts(
  chainId: number,
  rawProducts: {
    name: string;
    price: number;
    promoPrice: number | null;
    quantity: number;
    unit: string | null;
    pricePerUnit: number | null;
    parsedAmount?: number | null;
    parsedUnit?: string | null;
    isWeighable?: boolean;
    rawLines: string[];
    region: Region;
  }[],
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<MatchedProduct[]> {
  let done = 0;
  const promises = rawProducts.map(async (p) => {
    const { strippedName, amount: nameAmount, unit: nameUnit } = parseProductName(
      p.name,
      p.isWeighable,
    );
    const matchName = strippedName || p.name;
    let resolvedAmount = p.parsedAmount ?? nameAmount;
    let resolvedUnit = p.parsedUnit ?? nameUnit;

    // Rimi bare-decimal heuristic: "NATURĀ, 1,51" → 1.51 l
    if (chainId === 2 && resolvedAmount === null && strippedName !== p.name) {
      const tail = p.name.slice(strippedName.length).replace(/^[,\s]+/, "");
      const bare = parseFloat(tail.replace(",", "."));
      if (Number.isFinite(bare) && bare > 0.1 && bare <= 5 && !Number.isInteger(bare)) {
        resolvedAmount = bare;
        resolvedUnit = "l";
      }
    }

    let altMatches: unknown[] = [];
    try {
      const params = new URLSearchParams({ chainId: String(chainId), name: matchName });
      // Send the parser-extracted pack size so the matcher can prefer
      // SPs at the right amount + unit (e.g. ZEWA EVERYDAY 32 rit. vs
      // 12 rit.). Without these, name-similarity alone returns the wrong
      // pack variant at confidence 1.0. Skip when either is missing —
      // the matcher's name-only scoring handles those lines.
      if (resolvedAmount !== null && resolvedUnit) {
        params.set('amount', String(resolvedAmount));
        params.set('unit', resolvedUnit);
      }
      const res = await fetchWithTimeout(
        `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
        { timeoutMs: TIMEOUT_FAST_MS, externalSignal: signal },
      );
      const data = await res.json();
      if (Array.isArray(data?.matches)) altMatches = data.matches;
    } catch (e) {
      console.warn(`Product match failed for "${p.name}":`, e);
    }

    const top = (altMatches[0] as any) ?? null;
    const autoApply = top !== null && top.confidence >= AUTO_APPLY_THRESHOLD;
    done++;
    onProgress?.(done, rawProducts.length);

    return {
      name: matchName,
      matchedName: top?.name ?? null,
      storeProductId: autoApply ? top!.storeProductId : null,
      storeProductImageUrl: top?.imageUrl ?? null,
      matchConfidence: top?.confidence ?? null,
      matchConfirmed: autoApply,
      priceVerified: autoApply,
      altMatches,
      price: p.price,
      promoPrice: p.promoPrice,
      quantity: p.quantity,
      unit: p.unit === "kg" ? "kg" : p.unit,
      amount: resolvedAmount,
      sizeUnit: resolvedUnit,
      pricePerUnit: p.pricePerUnit,
      rawLines: p.rawLines,
      region: p.region,
    } as MatchedProduct;
  });

  return Promise.all(promises);
}

async function logFail(
  reason: ProcessingFailReason,
  ctx: {
    ocrLineCount?: number | null;
    ocrPreview?: string | null;
    detectedChainName?: string | null;
    extractedStoreAddress?: string | null;
  },
): Promise<void> {
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
        imageFilePath: null,
      }),
      timeoutMs: TIMEOUT_FAST_MS,
    }).catch((e) => console.warn("[logFail] POST failed:", e));
  } catch (e) {
    console.warn("[logFail] prep failed:", e);
  }
}

async function postReceipt(
  parsedData: object,
  signal: AbortSignal,
): Promise<{ receiptId: number; mandatorySwipesRequired: number }> {
  const userId = await getUserId();
  const res = await fetchWithTimeout(`${API_BASE_URL}/api/receipts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, filePath: "", parsedData }),
    timeoutMs: TIMEOUT_HEAVY_MS,
    externalSignal: signal,
  });
  const data = await res.json();
  if (res.status === 409) {
    throw new ProcessingError("post_failed", "Kvitas jau įkeltas");
  }
  if (!res.ok || !data?.id) {
    throw new ProcessingError("post_failed", data?.error || `HTTP ${res.status}`);
  }
  return { receiptId: data.id, mandatorySwipesRequired: data.mandatorySwipesRequired ?? 0 };
}

function buildHeader(
  chainName: string,
  chainId: number,
  storeCode: string,
  storeAddress: string,
  storeId: number,
  storeName: string | null,
  storeAddressMatched: string | null,
  matchConfidence: number | null,
  rawText: string,
  region: Region,
  lineRegions: LabeledRegion[],
) {
  return {
    chainName, chainId, storeCode, storeAddress, storeId, storeName,
    storeAddressMatched, matchConfidence, matchLoading: false, rawText, region,
    lineRegions,
    // Stamp so mobile can detect when persisted regions came from an
    // older parser revision and force a re-OCR rehydration.
    regionsVersion: REGIONS_VERSION,
  };
}

function buildFooter(
  f: { total: number | null; date: string; time: string; receiptNo: string; totalSavings: number | null; rawText: string; region: Region; lineRegions: LabeledRegion[] },
) {
  return { total: f.total, date: f.date, time: f.time, receiptNo: f.receiptNo, totalSavings: f.totalSavings, rawText: f.rawText, region: f.region, lineRegions: f.lineRegions };
}

// ── Chain processors ──────────────────────────────────────────────────────────

async function processRimi(
  allLines: LineWithFrame[],
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<object> {
  const chainId = 2;
  const parsed = parseRimiReceipt(allLines);
  const store = await matchStore(chainId, parsed.header.storeAddress, signal);
  if (!store) {
    await logFail("store_unrecognized", { detectedChainName: "RIMI", extractedStoreAddress: parsed.header.storeAddress || null });
    throw new ProcessingError("store_unrecognized", "Rimi parduotuvė neatpažinta");
  }
  const products = await matchProducts(chainId, parsed.products, signal, onProgress);
  return {
    version: 1, image: null,
    header: buildHeader("RIMI", chainId, parsed.header.storeCode, parsed.header.storeAddress, store.storeId, store.storeName, store.storeAddressMatched, store.matchConfidence, parsed.header.rawText, parsed.header.region, parsed.header.lineRegions),
    products,
    footer: buildFooter(parsed.footer),
  };
}

async function processMaxima(
  allLines: LineWithFrame[],
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<object> {
  const chainId = 1;
  const parsed = parseMaximaReceipt(allLines);
  const store = await matchStore(chainId, parsed.header.storeAddress, signal);
  if (!store) {
    await logFail("store_unrecognized", { detectedChainName: "MAXIMA", extractedStoreAddress: parsed.header.storeAddress || null });
    throw new ProcessingError("store_unrecognized", "Maxima parduotuvė neatpažinta");
  }
  const rawProds = parsed.products.map((mp: MaximaProduct) => ({
    name: mp.name,
    price: mp.price,
    promoPrice: mp.promoPrice,
    quantity: mp.quantity,
    unit: mp.unit,
    pricePerUnit: mp.pricePerUnit,
    rawLines: mp.rawLines,
    region: mp.region,
  }));
  const products = await matchProducts(chainId, rawProds, signal, onProgress);
  return {
    version: 1, image: null,
    header: buildHeader("MAXIMA", chainId, parsed.header.storeCode, parsed.header.storeAddress, store.storeId, store.storeName, store.storeAddressMatched, store.matchConfidence, parsed.header.rawText, parsed.header.region, parsed.header.lineRegions),
    products,
    footer: buildFooter(parsed.footer),
  };
}

async function processNorfa(
  allLines: LineWithFrame[],
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<object> {
  const chainId = 4;
  const parsed = parseNorfaReceipt(allLines);
  const store = await matchStore(chainId, parsed.header.storeAddress, signal);
  if (!store) {
    await logFail("store_unrecognized", { detectedChainName: "NORFA", extractedStoreAddress: parsed.header.storeAddress || null });
    throw new ProcessingError("store_unrecognized", "Norfa parduotuvė neatpažinta");
  }
  const rawProds = parsed.products.map((np: NorfaProduct) => ({
    name: np.name,
    price: np.price,
    promoPrice: np.promoPrice,
    quantity: np.quantity,
    unit: np.unit,
    pricePerUnit: np.pricePerUnit,
    rawLines: np.rawLines,
    region: np.region,
  }));
  const products = await matchProducts(chainId, rawProds, signal, onProgress);
  return {
    version: 1, image: null,
    header: buildHeader("NORFA", chainId, parsed.header.storeCode, parsed.header.storeAddress, store.storeId, store.storeName, store.storeAddressMatched, store.matchConfidence, parsed.header.rawText, parsed.header.region, parsed.header.lineRegions),
    products,
    footer: buildFooter(parsed.footer),
  };
}

async function processLidl(
  allLines: LineWithFrame[],
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<object> {
  const chainId = 5;
  const parsed = parseLidlReceipt(allLines);
  const store = await matchStore(chainId, parsed.header.storeAddress, signal);
  if (!store) {
    await logFail("store_unrecognized", { detectedChainName: "LIDL", extractedStoreAddress: parsed.header.storeAddress || null });
    throw new ProcessingError("store_unrecognized", "Lidl parduotuvė neatpažinta");
  }
  const rawProds = parsed.products.map((lp: LidlProduct) => ({
    name: lp.name,
    price: lp.price,
    promoPrice: lp.promoPrice,
    quantity: lp.quantity,
    unit: lp.unit,
    pricePerUnit: lp.pricePerUnit,
    rawLines: lp.rawLines,
    region: lp.region,
  }));
  const products = await matchProducts(chainId, rawProds, signal, onProgress);
  return {
    version: 1, image: null,
    header: buildHeader("LIDL", chainId, parsed.header.storeCode, parsed.header.storeAddress, store.storeId, store.storeName, store.storeAddressMatched, store.matchConfidence, parsed.header.rawText, parsed.header.region, parsed.header.lineRegions),
    products,
    footer: buildFooter(parsed.footer),
  };
}

async function processIki(
  mergedLines: LineWithFrame[],
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<object> {
  const chainId = 3;
  const parsed = parseIkiReceipt(mergedLines);
  const store = await matchStore(chainId, parsed.header.storeAddress, signal);
  if (!store) {
    await logFail("store_unrecognized", { detectedChainName: "IKI", extractedStoreAddress: parsed.header.storeAddress || null });
    throw new ProcessingError("store_unrecognized", "IKI parduotuvė neatpažinta");
  }
  const rawProds = parsed.products.map((ip: IkiProduct) => ({
    name: ip.name,
    price: ip.price,
    promoPrice: ip.promoPrice,
    quantity: ip.quantity,
    unit: ip.unit,
    pricePerUnit: ip.pricePerUnit,
    rawLines: ip.rawLines,
    region: ip.region,
  }));
  const products = await matchProducts(chainId, rawProds, signal, onProgress);
  return {
    version: 1, image: null,
    header: buildHeader("IKI", chainId, parsed.header.storeCode, parsed.header.storeAddress, store.storeId, store.storeName ?? (parsed.header.storeName || null), store.storeAddressMatched, store.matchConfidence, parsed.header.rawText, parsed.header.region, parsed.header.lineRegions),
    products,
    footer: buildFooter(parsed.footer),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function processOneReceipt(
  imageUris: string[],
  signal: AbortSignal,
  onProgress?: (step: string, done?: number, total?: number) => void,
): Promise<ProcessingResult> {
  try {
    onProgress?.("Nuskaitoma...");
    const {
      allLines,
      mergedLines,
      frameScale: _fs,
      firstPageUri,
      firstPageWidth,
      firstPageHeight,
    } = await ocrAllPages(imageUris);
    const lineTexts = mergedLines.map((l) => l.text);

    if (lineTexts.filter((t) => t.trim().length > 0).length < 3) {
      await logFail("ocr_no_text", {
        ocrLineCount: lineTexts.length,
        ocrPreview: lineTexts.join("\n").slice(0, 500),
      });
      throw new ProcessingError("ocr_no_text", "Nepavyko nuskaityti teksto");
    }

    onProgress?.("Atpažįstama...");
    let parsedData: object;
    const reportMatch = (d: number, t: number) =>
      onProgress?.(`${d}/${t} prekės`, d, t);

    if (isRimiReceipt(lineTexts)) {
      parsedData = await processRimi(allLines, signal, reportMatch);
    } else if (isMaximaReceipt(lineTexts)) {
      parsedData = await processMaxima(allLines, signal, reportMatch);
    } else if (isNorfaReceipt(lineTexts)) {
      parsedData = await processNorfa(allLines, signal, reportMatch);
    } else if (isLidlReceipt(lineTexts)) {
      parsedData = await processLidl(allLines, signal, reportMatch);
    } else if (isIkiReceipt(lineTexts)) {
      parsedData = await processIki(mergedLines, signal, reportMatch);
    } else {
      await logFail("chain_unrecognized", {
        ocrLineCount: lineTexts.length,
        ocrPreview: lineTexts.slice(0, 20).join("\n").slice(0, 500),
      });
      throw new ProcessingError("chain_unrecognized", "Parduotuvės tinklas neatpažintas");
    }

    // Inject image metadata so loadExistingReceipt can size pageMetas
    // without a separate Image.getSize round-trip. filePath stays null
    // until uploadReceiptImage PATCHes the receipt row below.
    const parsedDataWithImage = {
      ...(parsedData as Record<string, unknown>),
      image: {
        uri: firstPageUri,
        width: firstPageWidth,
        height: firstPageHeight,
        filePath: null,
      },
    };

    onProgress?.("Išsaugoma...");
    const postResult = await postReceipt(parsedDataWithImage, signal);

    // Background-but-awaited image upload. Without this, the dev band-
    // crop preview on the receipt detail screen has nothing to slice
    // (the `/api/receipts/:id/image` endpoint returns null). Failures
    // are non-fatal — the receipt data is already persisted; we just
    // lose the dev preview for that receipt.
    onProgress?.("Įkeliama nuotrauka...");
    await uploadReceiptImage(postResult.receiptId, firstPageUri, signal);

    return postResult;
  } catch (e) {
    if (e instanceof ProcessingError) throw e;
    // Surface network failures distinctly so the queue runner can pause
    // the item instead of marking it failed. NetworkError preserves the
    // existing fetchWithTimeout/RN error string ("Network request failed",
    // aborted, etc.) so the caller can decide.
    if (isNetworkLikeError(e)) {
      throw new NetworkError(e instanceof Error ? e.message : String(e));
    }
    console.error("[processOneReceipt] unexpected error:", e);
    await logFail("ocr_error", {
      ocrPreview: e instanceof Error ? e.message : String(e),
    });
    throw new ProcessingError("ocr_error", "Klaida apdorojant kvitą");
  }
}

/**
 * Distinguishes "no internet / server unreachable" failures from genuine
 * processing errors (parser couldn't find products, chain unknown, etc.).
 * On RN, fetch typically throws an Error whose message is exactly
 * "Network request failed" when offline. fetchWithTimeout's external
 * abort path surfaces as AbortError. We treat both as recoverable.
 */
export function isNetworkLikeError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "AbortError") return true;
  const msg = e.message || "";
  return (
    msg.includes("Network request failed") ||
    msg.includes("Failed to fetch") ||
    msg.includes("timeout") ||
    msg.includes("ECONN")
  );
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}
