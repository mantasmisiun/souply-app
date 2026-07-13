import { parseProductName } from "@shared/parsers/productNameParser";
import { detectCardMaskBands, redactReceiptText, type MaskBand } from "@shared/parsers/cardMaskDetection";
import { buildRedactedUploadUri } from "../components/MaskRedactionHost";
import { requestStoreResolution, pickAddressFromRawText } from "../utils/storeResolution";
import { router } from "expo-router";
import i18n from "../i18n";
import { ocrReceiptPages } from "../utils/receiptOcrPipeline";
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
import { detectChainByVatCode } from "@shared/parsers/chainVatFallback";
import { REGIONS_VERSION } from "./regionsRehydrationService";
import { pdfToImageUris } from "../utils/pdfToImages";
import { Platform } from "react-native";

// iOS MLKit splits rows into 2-4 near-same-y boxes; the Maxima+Lidl parsers carry an
// xLeft-sorted row merger behind this flag. Every parse surface must pass the SAME flag
// (interactive receipt-process, region rehydration, recovery, and this headless queue) —
// a site that omits it produces a DIFFERENT parse of the same photo on iOS.
const PARSER_OPTS = { iosOcr: Platform.OS === "ios" };

export interface ProcessingResult {
  receiptId: number;
  mandatorySwipesRequired: number;
}

export type ProcessingFailReason =
  | "ocr_no_text"
  | "ocr_error"
  | "chain_unrecognized"
  | "store_unrecognized"
  | "post_failed"
  | "mask_failed";

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
  // Carried from the parser so the server resolver sees that a by-weight line
  // is weighable (without it the resolver treats null as a form mismatch).
  isWeighable?: boolean | null;
  rawLines: string[];
  region: Region;
}

// OCR pipeline (rotate + tile + multi-page merge) is shared with account
// recovery via `utils/receiptOcrPipeline.ts` so the two paths can never drift.
const ocrAllPages = ocrReceiptPages;

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
    isWeighable?: boolean | null;
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
      p.isWeighable ?? undefined,
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
    // Absurd-length guard — see receipt-process.tsx (the receipt-272 mega-line hang).
    if (matchName.length > 80) {
      console.warn(`[match] skipped absurd-length name (${matchName.length} chars)`);
      return { altMatches: [] } as any;
    }
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
      isWeighable: p.isWeighable ?? null,
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
): Promise<{ receiptId: number; mandatorySwipesRequired: number; duplicate?: boolean }> {
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
    // The receipt already exists — typically because a PRIOR run of THIS item committed
    // the create but was killed before the image upload (leaving the row image-less). If
    // the server hands back the existing id, return it as duplicate so the caller RE-RUNS
    // the image-upload step against it (recovering the missing photo) instead of dropping
    // the item permanently image-less. Only bail when there's no id to recover.
    if (Number.isFinite(data?.existingReceiptId)) {
      return { receiptId: Number(data.existingReceiptId), mandatorySwipesRequired: 0, duplicate: true };
    }
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
    storeAddressMatched, matchConfidence, rawText, region, // matchLoading dropped (transient UI state)
    lineRegions,
    // Stamp so mobile can detect when persisted regions came from an
    // older parser revision and force a re-OCR rehydration.
    regionsVersion: REGIONS_VERSION,
  };
}

function buildFooter(
  f: { total: number | null; date: string; time: string; receiptNo: string; totalSavings: number | null; comboDiscount?: number | null; rawText: string; region: Region; lineRegions: LabeledRegion[] },
) {
  // rawText + region dropped from the persisted footer — byte-identical duplicates of
  // header.rawText/region, which stays the single source of truth. comboDiscount (IKI
  // bare-RINKINYS set deal) MUST pass through this whitelist — the server subtracts it
  // from savings + the visited-store comparison basket.
  return { total: f.total, date: f.date, time: f.time, receiptNo: f.receiptNo, totalSavings: f.totalSavings, comboDiscount: f.comboDiscount ?? null, lineRegions: f.lineRegions };
}

/**
 * Strip bank/loyalty card numbers + cashier name from the stored parsedData
 * (rawText fields + product rawLines) and stamp geometry-only redaction boxes
 * so the Kvitas-tab overlay can re-draw them. Mirrors receipt-process.tsx's
 * buildParsedData — the queue pipeline must give the same privacy guarantee.
 */
function redactQueueParsedData(parsedData: object, maskBands: MaskBand[]): object {
  const pd = parsedData as Record<string, any>;
  return {
    ...pd,
    header: pd.header ? { ...pd.header, rawText: redactReceiptText(pd.header.rawText) } : pd.header,
    products: Array.isArray(pd.products)
      ? pd.products.map((p: any) => ({
          ...p,
          rawLines: Array.isArray(p.rawLines) ? p.rawLines.map(redactReceiptText) : p.rawLines,
        }))
      : pd.products,
    // New blobs carry no footer.rawText (deduped); only redact it if an OLD blob still has one.
    footer: pd.footer
      ? { ...pd.footer, ...(pd.footer.rawText != null ? { rawText: redactReceiptText(pd.footer.rawText) } : {}) }
      : pd.footer,
    maskBands: maskBands.map((b) => ({
      yTop: b.yTop, yBottom: b.yBottom, xLeft: b.xLeft, xRight: b.xRight, kind: b.kind,
    })),
  };
}

// ── Chain processors ──────────────────────────────────────────────────────────

/**
 * The store address didn't auto-match — surface the map store-resolution screen
 * (chain known, store not) and await the user's pick. This service is headless,
 * so it uses expo-router's imperative `router`. null = user backed out.
 */
async function promptStoreResolution(chainId: number, chainName: string, address: string | null, rawText?: string | null) {
  const prefill = address || pickAddressFromRawText(rawText);
  console.log(`[storeResolution] (queue) ${chainName} prefill=${JSON.stringify(prefill)}`);
  const pending = requestStoreResolution(chainId, chainName, prefill);
  router.push("/receipt/store-resolution" as any);
  return await pending;
}

async function processRimi(
  allLines: LineWithFrame[],
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<object> {
  const chainId = 2;
  const parsed = parseRimiReceipt(allLines);
  let store = await matchStore(chainId, parsed.header.storeAddress, signal);
  if (!store) {
    const chosen = await promptStoreResolution(chainId, "RIMI", parsed.header.storeAddress || null, parsed.header.rawText);
    if (chosen) store = { storeId: chosen.storeId, storeName: chosen.storeName, storeAddressMatched: chosen.storeAddress, matchConfidence: 1 };
  }
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
  const parsed = parseMaximaReceipt(allLines, PARSER_OPTS);
  let store = await matchStore(chainId, parsed.header.storeAddress, signal);
  if (!store) {
    const chosen = await promptStoreResolution(chainId, "MAXIMA", parsed.header.storeAddress || null, parsed.header.rawText);
    if (chosen) store = { storeId: chosen.storeId, storeName: chosen.storeName, storeAddressMatched: chosen.storeAddress, matchConfidence: 1 };
  }
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
    // Weighed-vs-packaged signal — the matcher's weighable gate and the resolver's
    // self-heal are inert without it (it was silently dropped here for every chain).
    isWeighable: (mp as MaximaProduct & { isWeighable?: boolean | null }).isWeighable ?? (mp.unit === 'kg' ? true : null),
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
  let store = await matchStore(chainId, parsed.header.storeAddress, signal);
  if (!store) {
    const chosen = await promptStoreResolution(chainId, "NORFA", parsed.header.storeAddress || null, parsed.header.rawText);
    if (chosen) store = { storeId: chosen.storeId, storeName: chosen.storeName, storeAddressMatched: chosen.storeAddress, matchConfidence: 1 };
  }
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
    // Weighed-vs-packaged signal — the matcher's weighable gate and the resolver's
    // self-heal are inert without it (it was silently dropped here for every chain).
    isWeighable: (np as NorfaProduct & { isWeighable?: boolean | null }).isWeighable ?? (np.unit === 'kg' ? true : null),
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
  const parsed = parseLidlReceipt(allLines, PARSER_OPTS);
  let store = await matchStore(chainId, parsed.header.storeAddress, signal);
  if (!store) {
    const chosen = await promptStoreResolution(chainId, "LIDL", parsed.header.storeAddress || null, parsed.header.rawText);
    if (chosen) store = { storeId: chosen.storeId, storeName: chosen.storeName, storeAddressMatched: chosen.storeAddress, matchConfidence: 1 };
  }
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
    // Weighed-vs-packaged signal — the matcher's weighable gate and the resolver's
    // self-heal are inert without it (it was silently dropped here for every chain).
    isWeighable: (lp as LidlProduct & { isWeighable?: boolean | null }).isWeighable ?? (lp.unit === 'kg' ? true : null),
    // Pack-size reference (weighable → 1 kg) so matchProducts resolves
    // amount/sizeUnit — else weighables render with no amount. rimi parity.
    parsedAmount: lp.parsedAmount ?? null,
    parsedUnit: lp.parsedUnit ?? null,
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
  let store = await matchStore(chainId, parsed.header.storeAddress, signal);
  if (!store) {
    const chosen = await promptStoreResolution(chainId, "IKI", parsed.header.storeAddress || null, parsed.header.rawText);
    if (chosen) store = { storeId: chosen.storeId, storeName: chosen.storeName, storeAddressMatched: chosen.storeAddress, matchConfidence: 1 };
  }
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
    // Weighed-vs-packaged signal — the matcher's weighable gate and the resolver's
    // self-heal are inert without it (it was silently dropped here for every chain).
    isWeighable: ip.isWeighable ?? (ip.unit === 'kg' ? true : null),
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
  opts?: { isPdf?: boolean },
): Promise<ProcessingResult> {
  try {
    // PDF sources: page conversion is the item's FIRST stage (was a blocking
    // modal before enqueueing). Conversion errors route like any other step —
    // network-like failures pause the item, the rest mark it failed.
    let pages = imageUris;
    if (opts?.isPdf) {
      onProgress?.(i18n.t("receipts.menu.pdfConverting"));
      pages = await pdfToImageUris(imageUris[0]);
      if (pages.length === 0) throw new ProcessingError("ocr_error", "PDF be puslapių");
    }
    onProgress?.(i18n.t("receiptQueue.scanning"));
    const {
      allLines,
      mergedLines,
      frameScale: _fs,
      firstPageUri,
      firstPageWidth,
      firstPageHeight,
      // PDF pages get DOCUMENT-fidelity OCR (no photo downscale — that pushed
      // thin price digits under ML Kit's glyph floor), same as the live scan.
    } = await ocrAllPages(pages, "auto", opts?.isPdf ? { document: true } : undefined);
    const lineTexts = mergedLines.map((l) => l.text);

    if (lineTexts.filter((t) => t.trim().length > 0).length < 3) {
      await logFail("ocr_no_text", {
        ocrLineCount: lineTexts.length,
        ocrPreview: lineTexts.join("\n").slice(0, 500),
      });
      throw new ProcessingError("ocr_no_text", "Nepavyko nuskaityti teksto");
    }

    onProgress?.(i18n.t("receiptQueue.recognising"));
    let parsedData: object;
    const reportMatch = (d: number, t: number) =>
      onProgress?.(i18n.t("receiptQueue.products", { done: d, total: t }), d, t);

    // Primary text-fingerprint detection; fall back to the seller's PVM/VAT
    // code (chain-specific, printed on every receipt) when those all miss.
    const chainId =
      isRimiReceipt(lineTexts) ? 2 :
      isMaximaReceipt(lineTexts) ? 1 :
      isNorfaReceipt(lineTexts) ? 4 :
      isLidlReceipt(lineTexts) ? 5 :
      isIkiReceipt(lineTexts) ? 3 :
      (detectChainByVatCode(lineTexts)?.chainId ?? null);

    if (chainId === 2) {
      parsedData = await processRimi(allLines, signal, reportMatch);
    } else if (chainId === 1) {
      parsedData = await processMaxima(allLines, signal, reportMatch);
    } else if (chainId === 4) {
      parsedData = await processNorfa(allLines, signal, reportMatch);
    } else if (chainId === 5) {
      parsedData = await processLidl(allLines, signal, reportMatch);
    } else if (chainId === 3) {
      parsedData = await processIki(mergedLines, signal, reportMatch);
    } else {
      await logFail("chain_unrecognized", {
        ocrLineCount: lineTexts.length,
        ocrPreview: lineTexts.slice(0, 20).join("\n").slice(0, 500),
      });
      throw new ProcessingError("chain_unrecognized", "Parduotuvės tinklas neatpažintas");
    }

    // Detect bank/loyalty/cashier redaction boxes (image-pixel space), then
    // strip the same data from the stored parsedData. The queue pipeline gets
    // the SAME privacy guarantee as the interactive flow.
    const maskBands = detectCardMaskBands(allLines);
    console.log(`[MASK] (queue) detected ${maskBands.length} band(s)`);

    // Inject image metadata so loadExistingReceipt can size pageMetas
    // without a separate Image.getSize round-trip. filePath stays null
    // until uploadReceiptImage PATCHes the receipt row below.
    const parsedDataWithImage = {
      ...(redactQueueParsedData(parsedData, maskBands) as Record<string, unknown>),
      image: {
        uri: firstPageUri,
        width: firstPageWidth,
        height: firstPageHeight,
        filePath: null,
      },
    };

    onProgress?.(i18n.t("receiptQueue.saving"));
    const postResult = await postReceipt(parsedDataWithImage, signal);

    // Burn the black redaction boxes into the image BEFORE upload (via the
    // global off-screen ViewShot host — this service is headless). FAIL-CLOSED:
    // if the redacted copy can't be produced, SKIP the image upload entirely
    // rather than PUT the original that still shows a card number.
    let uploadUri: string | null = firstPageUri;
    if (maskBands.length > 0) {
      onProgress?.(i18n.t("receiptQueue.masking"));
      try {
        uploadUri = await buildRedactedUploadUri(firstPageUri, firstPageWidth, firstPageHeight, maskBands);
      } catch (e) {
        console.warn("[MASK] (queue) redaction failed — skipping image upload:", e);
        await logFail("mask_failed", { ocrLineCount: lineTexts.length });
        uploadUri = null;
      }
    }
    if (uploadUri) {
      onProgress?.(i18n.t("receiptQueue.uploading"));
      await uploadReceiptImage(postResult.receiptId, uploadUri, signal);
    }

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
