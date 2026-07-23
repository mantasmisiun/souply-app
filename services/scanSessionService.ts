/**
 * Background scan-session pipeline — the interactive Analyze scan flow
 * (OCR → chain detect → parse → gates → product match → POST → photo
 * upload), extracted out of app/receipt-process.tsx so it survives the
 * screen unmounting (tab switch / back gesture mid-processing).
 *
 * The screen subscribes to state/scanSession.ts: it renders the loader and
 * the input gates (date / chain / store map) from the store and answers
 * them via respondSessionInput / completeStoreResolution; when the session
 * publishes `done` it hydrates its local detail state from `parse` +
 * `completion`. Nothing here may render or navigate — user-facing UX
 * (alerts, modals, navigation) stays in the attached screen; if no screen
 * is attached the session simply waits (input) or finishes (done/failed)
 * and the Analyze live card surfaces it.
 *
 * This is the SAME pipeline the screen ran before, verbatim where possible:
 * shared OCR (utils/receiptOcrPipeline), shared scan flow (utils/
 * receiptScanFlow — ensemble, rimi section re-OCR, iki re-OCR + footer band
 * refine), per-chain store/product matching, buildParsedData, masked upload.
 */
import * as Clipboard from "expo-clipboard";
import { isNetworkLikeError } from "./receiptProcessingService";
import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import i18n from "../i18n";
import { API_BASE_URL } from "../config/api";
import { getUserId } from "../config/user";
import {
  fetchWithTimeout,
  TIMEOUT_FAST_MS,
  TIMEOUT_HEAVY_MS,
  TIMEOUT_STANDARD_MS,
} from "../utils/fetchWithTimeout";
import { ocrReceiptPages } from "../utils/receiptOcrPipeline";
import { detectReceiptChain, parseChainReceipt } from "../utils/receiptScanFlow";
import {
  requestStoreResolution,
  pickAddressFromRawText,
  type ResolvedStore,
} from "../utils/storeResolution";
import { buildRedactedUploadUri } from "../components/MaskRedactionHost";
import { recordStoreVisit } from "../utils/locationStorage";
import { clearReceiptDraft, saveReceiptDraft } from "../state/receiptDraft";
import { pdfToImageUris } from "../utils/pdfToImages";
import { mapLimit } from "../utils/concurrency";
import { useReceiptQueueStore } from "../state/receiptQueueStore";
import { useProfileStore } from "../state/profileStore";
import { REGIONS_VERSION } from "./regionsRehydrationService";
import { RECOGNITION } from "@shared/recognitionConfig";
import { parseProductName } from "@shared/parsers/productNameParser";
import {
  detectCardMaskBands,
  clampMaskBandsToProtected,
  redactReceiptText,
  wordCentreInMaskBand,
  looksLikePiiText,
  type MaskBand,
} from "@shared/parsers/cardMaskDetection";
import type { LabeledRegion } from "@shared/parsers/rimiParser";
import type { IkiProduct } from "@shared/parsers/ikiParser";
import type { PageMeta } from "../utils/receiptImage";
import {
  buildParsedData,
  logParsedReview,
  topMatchDisplayFields,
  type FooterData,
  type HeaderData,
  type ProductLine,
  type ProductMatchOption,
} from "../utils/receiptParsedData";
import {
  beginSession,
  isCurrentSession,
  requestSessionInput,
  sessionSet,
  useScanSession,
  type ScanParseResult,
  type StartScanOptions,
} from "../state/scanSession";

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

type BailReason =
  | "ocr_no_text"
  | "ocr_error"
  | "chain_unrecognized"
  | "store_unrecognized"
  | "no_products"
  | "doubled_scan";

interface BailContext {
  ocrLineCount?: number | null;
  ocrPreview?: string | null;
  detectedChainName?: string | null;
  extractedStoreAddress?: string | null;
  /** OCR/parsed payload captured at fail time (JSON string) — the post-mortem trail. */
  parsedData?: string | null;
}

const BAIL_MSG_KEYS: Record<BailReason, string> = {
  ocr_no_text: "receiptProcess.errorOcrUnreadable",
  ocr_error: "receiptProcess.errorOcrParse",
  chain_unrecognized: "receiptProcess.errorChain",
  store_unrecognized: "receiptProcess.errorStore",
  no_products: "receiptProcess.errorNoProducts",
  doubled_scan: "receiptProcess.errorDoubledScan",
};

/**
 * Retry context for the attached screen's reconnect/interval retries. Holds
 * everything the POST/upload steps need to re-run after a transient failure.
 */
interface RunCtx {
  sessionId: number;
  opts: StartScanOptions;
  userId: string | null;
  parsedData: object | null;
  imageUri: string | null;
  imageDims: { width: number; height: number } | null;
  maskBandsClamped: MaskBand[];
  linkListId: number | null;
  receiptId: number | null;
  resumedPhotoPresent: boolean;
}

let currentRun: RunCtx | null = null;

/**
 * DOUBLED-SCAN gate (receipt-167): the camera caught the SAME receipt twice in
 * one frame — its once-only receipt-number token then appears in ≥2 lines.
 * Pure + exported for tests. Returns the duplicated token or null.
 */
export function findDoubledScanToken(lineTexts: string[]): { token: string; count: number } | null {
  // Per-chain "this token prints exactly ONCE on a real receipt" extractors:
  //   IKI/Rimi  full slashed id "71/612/114973"
  //   Maxima    "Kvito Nr. 1234567" / "Dokumento numeris 123…"
  //   Lidl      "Kvitas 47989/258" (NOT the bare "#00NNNNN" which prints twice)
  //   Norfa     "# Kvito numeris 123456 #"
  const ONCE_ONLY_TOKENS: RegExp[] = [
    /\b\d{2,4}\/\d{2,4}\/\d{4,8}\b/,
    /[KA][vouy]ito\s+Nr\S{0,2}\s*(\d{5,})/i,
    /Dokumento\s+numeris\s*:?\s*(\d{4,})/i,
    /\bKvitas\s+(\d{4,}\s*\/\s*\d+)/i,
    /#\s*Kvito\s+numeris\s+(\d{4,})\s*#/i,
  ];
  const rcptTokens: string[] = [];
  for (const tx of lineTexts) {
    for (const re of ONCE_ONLY_TOKENS) {
      const m = tx.match(re);
      if (m) { rcptTokens.push((m[1] ?? m[0]).replace(/\s+/g, "")); break; }
    }
  }
  const dup = rcptTokens.find((tok, i) => rcptTokens.indexOf(tok) !== i);
  if (!dup) return null;
  return { token: dup, count: rcptTokens.filter((tk) => tk === dup).length };
}

/**
 * Start (or re-attach to) the background scan session for these images.
 * Returns the sessionId, or null when a DIFFERENT scan is still mid-flight
 * (the caller should surface "a scan is already running" and attach to it).
 */
export function startScanSession(opts: StartScanOptions): number | null {
  const existing = useScanSession.getState();
  const sessionId = beginSession(opts);
  if (sessionId === null) return null;
  // beginSession returns the LIVE session's id when the uris match — that's a
  // re-attach, not a fresh start; don't spawn a second pipeline over it.
  if (existing.sessionId === sessionId) return sessionId;
  currentRun = {
    sessionId,
    opts,
    userId: null,
    parsedData: null,
    imageUri: null,
    imageDims: null,
    maskBandsClamped: [],
    linkListId: null,
    receiptId: null,
    resumedPhotoPresent: false,
  };
  // Persist a draft so an OS kill mid-processing is recoverable from the
  // Analyze tab (previews never save anything server-side — out of scope).
  // PDF sources save theirs after conversion (the draft resume flow re-opens
  // with page-image uris).
  if (!opts.preview && opts.imageUris.length > 0) saveReceiptDraft(opts.imageUris).catch(() => {});
  runPipeline(sessionId, opts).catch((e) => {
    console.error("[scanSession] pipeline crashed:", e);
    // Infra blips (offline, tunnel error pages → JSON parse failures) are NOT
    // receipt failures: no FailedReceiptLog entry (nothing for an admin to
    // fix), and the user gets a "check your connection" message instead of
    // the misleading "OCR error" (prod FailedReceiptLog #26).
    if (isNetworkLikeError(e)) {
      sessionSet(sessionId, { phase: "failed", failMessage: i18n.t("receiptProcess.errorNetwork") });
      return;
    }
    void bailWithLog(sessionId, "ocr_error", { ocrPreview: e instanceof Error ? e.message : String(e) });
  });
  return sessionId;
}

async function bailWithLog(sessionId: number, reason: BailReason, ctx: BailContext = {}): Promise<void> {
  // A replaced session's late bail must neither log a spurious failure nor
  // touch the new session's state.
  if (!isCurrentSession(sessionId)) return;
  // Fire-and-forget log. Network/DB failure here must not block surfacing
  // the failure to the user.
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
        parsedData: ctx.parsedData ?? null,
      }),
      timeoutMs: TIMEOUT_FAST_MS,
    }).catch((e) => console.warn("[bailWithLog] log POST failed:", e));
  } catch (e) {
    console.warn("[bailWithLog] log prep failed:", e);
  }
  // Bail = receipt can't be processed, nothing to resume. Drop the draft so
  // the Analyze tab doesn't keep prompting "continue" on a scan that will
  // just bail again.
  clearReceiptDraft().catch(() => {});
  sessionSet(sessionId, { phase: "failed", failMessage: i18n.t(BAIL_MSG_KEYS[reason]) });
}

/** Resolve a store from the OCR address — header-zone address first, then the
 *  broader raw-text street scan (same extraction the map prefill uses). */
async function resolveStoreMatch(
  chainId: number,
  storeAddress: string | null | undefined,
  rawText: string | null | undefined,
): Promise<{ storeId: number; storeName: string | null; address: string | null; confidence: number | null } | null> {
  const candidates = Array.from(new Set(
    [(storeAddress ?? "").trim(), (pickAddressFromRawText(rawText) ?? "").trim()].filter(Boolean),
  ));
  for (const addr of candidates) {
    try {
      const url = `${API_BASE_URL}/api/stores/match?chainId=${chainId}&address=${encodeURIComponent(addr)}`;
      const res = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_STANDARD_MS });
      const data = await res.json();
      if (data?.match) {
        return { storeId: data.match.storeId, storeName: data.match.storeName, address: data.match.address, confidence: data.match.confidence };
      }
    } catch (e) {
      console.warn("Store match failed:", e);
    }
  }
  return null;
}

/** RE-OCR STORE INHERIT: a re-OCR reprocesses an EXISTING receipt's photo — when
 *  the fresh pass loses the address text entirely, inherit the original
 *  receipt's already-resolved store instead of re-asking. Chain-checked. */
async function inheritReocrStore(
  reocrReceiptId: number | null,
  chainId: number,
): Promise<{ storeId: number; storeName: string | null; storeAddress: string | null } | null> {
  if (reocrReceiptId == null || !Number.isFinite(reocrReceiptId)) return null;
  try {
    const res = await fetchWithTimeout(`${API_BASE_URL}/api/receipts/${reocrReceiptId}`, { timeoutMs: TIMEOUT_STANDARD_MS });
    if (!res.ok) return null;
    const r = await res.json();
    const pd = typeof r?.parsedData === "string" ? JSON.parse(r.parsedData) : r?.parsedData;
    const h = pd?.header ?? {};
    const sid = h?.storeId ?? r?.storeId;
    if (sid == null || (h?.chainId != null && h.chainId !== chainId)) return null;
    console.log(`[reocr] inherited store ${sid} (${h?.storeName ?? "?"}) from receipt ${reocrReceiptId}`);
    return { storeId: Number(sid), storeName: h?.storeName ?? null, storeAddress: h?.storeAddressMatched ?? null };
  } catch {
    return null;
  }
}

/** The store address didn't auto-match — publish a store input request (the
 *  attached screen shows the map modal) and await the user's pick. null =
 *  user backed out (caller bails as store_unrecognized). */
async function promptStoreResolution(
  sessionId: number,
  chainId: number,
  chainName: string,
  ocrAddress: string | null,
  rawText?: string | null,
): Promise<ResolvedStore | null> {
  const prefill = ocrAddress || pickAddressFromRawText(rawText);
  const pending = requestStoreResolution(chainId, chainName, prefill);
  sessionSet(sessionId, { inputRequest: { kind: "store", chainId, chainName, prefill }, phase: "input" });
  const result = await pending;
  sessionSet(sessionId, { inputRequest: null, phase: "processing" });
  return result;
}

function bumpMatchProgress(sessionId: number): void {
  if (!isCurrentSession(sessionId)) return;
  useScanSession.setState((s) => ({
    matchProgress: s.matchProgress ? { ...s.matchProgress, done: s.matchProgress.done + 1 } : s.matchProgress,
  }));
}

/** One product-match request against /api/store-products/match. */
async function fetchProductMatch(
  chainId: number,
  matchName: string,
  weighable: boolean,
): Promise<{ altMatches: ProductMatchOption[]; isCrossChain: boolean }> {
  let altMatches: ProductMatchOption[] = [];
  let isCrossChain = false;
  try {
    const params = new URLSearchParams({
      chainId: String(chainId),
      name: matchName,
      ...(weighable ? { weighable: "1" } : {}),
    });
    const res = await fetchWithTimeout(
      `${API_BASE_URL}/api/store-products/match?${params.toString()}`,
      { timeoutMs: TIMEOUT_FAST_MS },
    );
    const data = await res.json();
    if (Array.isArray(data?.matches)) altMatches = data.matches;
    // Cross-chain fallback flag (whole match set): the same-chain catalog
    // returned nothing, so these candidates come from OTHER chains.
    isCrossChain = !!data?.crossChain;
  } catch (e) {
    console.warn(`Product match failed for "${matchName}":`, e);
  }
  return { altMatches, isCrossChain };
}

/**
 * Chain-generic product matching. `resolveSize` preserves each chain's exact
 * historical amount/sizeUnit semantics (they differ deliberately — e.g. the
 * Rimi bare-decimal litre heuristic, Maxima's parser-extracted sizes).
 */
async function matchChainProducts<P extends {
  name: string;
  price: number;
  promoPrice: number | null;
  quantity: number;
  unit: string | null;
  pricePerUnit: number | null;
  rawLines: string[];
  region: any;
}>(
  sessionId: number,
  chainId: number,
  items: P[],
  resolveSize: (p: P, stripped: { strippedName: string; amount: number | null; unit: string | null }) => {
    matchName: string;
    amount: number | null;
    sizeUnit: string | null;
    skipMatch?: boolean;
  },
): Promise<ProductLine[]> {
  const AUTO_APPLY_THRESHOLD = RECOGNITION.match.autoApplyThreshold;
  sessionSet(sessionId, { matchProgress: { done: 0, total: items.length }, stage: "matching" });

  // Concurrency-capped: an uncapped fan-out monopolised the per-host socket
  // pool and starved every other screen's fetch — see utils/concurrency.ts.
  const lines = await mapLimit(items, 4, async (p) => {
    const stripped = parseProductName(p.name);
    const { matchName, amount, sizeUnit, skipMatch } = resolveSize(p, {
      strippedName: stripped.strippedName,
      amount: stripped.amount,
      unit: stripped.unit,
    });
    // by-WEIGHT line (sold per kg) → matcher skips packaged SPs (and vice-versa).
    const weighable = p.unit === "kg";
    const { altMatches, isCrossChain } = skipMatch
      ? { altMatches: [] as ProductMatchOption[], isCrossChain: false }
      : await fetchProductMatch(chainId, matchName, weighable);

    const top = altMatches[0] || null;
    const autoApply = top !== null && top.confidence >= AUTO_APPLY_THRESHOLD;
    bumpMatchProgress(sessionId);

    return {
      name: matchName,
      // Weak cross-chain auto-matches are orphaned (OCR shown, candidates kept
      // for orphan-rescue). See topMatchDisplayFields.
      ...topMatchDisplayFields(top, isCrossChain, autoApply),
      altMatches,
      price: p.price,
      promoPrice: p.promoPrice,
      quantity: p.quantity,
      unit: p.unit === "kg" ? "kg" : p.unit,
      amount,
      sizeUnit,
      pricePerUnit: p.pricePerUnit,
      rawLines: p.rawLines,
      region: p.region,
    } as ProductLine;
  });

  sessionSet(sessionId, { matchProgress: null });
  return lines;
}

/** Store resolution shared by every chain: auto-match → re-OCR inherit →
 *  user map pick. null = user backed out (caller bails). */
async function resolveChainStore(
  sessionId: number,
  opts: StartScanOptions,
  chainId: number,
  chainName: string,
  header: { storeAddress: string; rawText: string; lineRegions?: LabeledRegion[] },
): Promise<{ storeId: number; storeName: string | null; storeAddressMatched: string | null; matchConfidence: number | null; manualPick: boolean } | null> {
  {
    const m = await resolveStoreMatch(chainId, header.storeAddress, header.rawText);
    if (m) return { storeId: m.storeId, storeName: m.storeName, storeAddressMatched: m.address, matchConfidence: m.confidence, manualPick: false };
  }
  {
    const inh = await inheritReocrStore(opts.reocrReceiptId, chainId);
    if (inh) {
      header.lineRegions = (header.lineRegions ?? []).filter((r: any) => r?.kind !== "storeAddress");
      return { storeId: inh.storeId, storeName: inh.storeName, storeAddressMatched: inh.storeAddress, matchConfidence: 1, manualPick: false };
    }
  }
  const chosen = await promptStoreResolution(sessionId, chainId, chainName, header.storeAddress || null, header.rawText);
  if (!chosen) return null;
  return { storeId: chosen.storeId, storeName: chosen.storeName, storeAddressMatched: chosen.storeAddress, matchConfidence: 1, manualPick: true };
}

async function runPipeline(sessionId: number, opts: StartScanOptions): Promise<void> {
  const { linkMap, fallbackLinkId } = opts;
  let imageUris = opts.imageUris;
  let fromPdf = opts.fromPdf;

  // Step 0 — PDF → page images, as a background stage (was a blocking modal
  // at every entry point). On failure the normal fail modal / live card shows.
  if (opts.pdfUri && imageUris.length === 0) {
    sessionSet(sessionId, { stage: "converting" });
    try {
      imageUris = await pdfToImageUris(opts.pdfUri);
      if (imageUris.length === 0) throw new Error("no pages");
    } catch (e) {
      console.warn("[scanSession] pdf conversion failed:", e);
      await bailWithLog(sessionId, "ocr_error", {
        ocrPreview: `pdf conversion failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    if (!isCurrentSession(sessionId)) return;
    fromPdf = true; // PDF pages get DOCUMENT-fidelity OCR (no photo downscale)
    const newOpts = { ...opts, imageUris, fromPdf };
    sessionSet(sessionId, { opts: newOpts, stage: "scanning" });
    if (currentRun?.sessionId === sessionId) currentRun.opts = newOpts;
    if (!opts.preview) saveReceiptDraft(imageUris).catch(() => {});
  }
  // OCR line texts, hoisted for the bail helpers (assigned right after OCR).
  let ocrLineTexts: string[] = [];

  // Quality gate. A readable receipt always yields a receipt id and a DATE;
  // TIME is OPTIONAL (midday default). Missing date → ask the user to pick
  // the printed date via the attached screen's date modal. Cancel → bail.
  const ensureKeyReceiptFields = async (
    footer: { receiptNo?: string | null; date?: string | null; time?: string | null } | null,
  ): Promise<boolean> => {
    const keyFieldsDiag = () => ({
      ocrLineCount: ocrLineTexts.length,
      parsedData: JSON.stringify({ footer, lineTexts: ocrLineTexts }),
    });
    // Old-receipt gate: if the (parsed or entered) purchase date is more than 30
    // days old, make the uploader confirm it's really this trip's shop before it
    // saves — a stale receipt slipped into a shared trip is otherwise only caught
    // by the after-the-fact badge. Unparseable → don't gate.
    const OLD_RECEIPT_DAYS = 30;
    const confirmIfOldReceipt = async (dateStr: string): Promise<boolean> => {
      const d = new Date(dateStr);
      if (Number.isNaN(d.getTime())) return true;
      if ((Date.now() - d.getTime()) / 86400000 <= OLD_RECEIPT_DAYS) return true;
      const proceed = await requestSessionInput<boolean>(sessionId, { kind: "oldDate", date: dateStr });
      if (proceed) return true;
      await bailWithLog(sessionId, "ocr_no_text", { ocrPreview: `old receipt (${dateStr}) not confirmed`, ...keyFieldsDiag() });
      return false;
    };
    // TIME IS OPTIONAL: some IKI layouts print date+time ONLY in the bottom VMI
    // fiscal line — a slightly short frame loses both. The exact hour only
    // orders same-day receipts, so default to midday rather than dead-ending.
    if (footer?.receiptNo && !footer.time) footer.time = "12:00";
    if (footer?.receiptNo && footer?.date) return await confirmIfOldReceipt(footer.date);
    if (footer?.receiptNo && !footer?.date) {
      const picked = await requestSessionInput<Date | null>(sessionId, { kind: "date" });
      if (picked) {
        const y = picked.getFullYear();
        const m = String(picked.getMonth() + 1).padStart(2, "0");
        const d = String(picked.getDate()).padStart(2, "0");
        footer.date = `${y}-${m}-${d}`;
        // The manually-entered date must clear the same old-receipt gate.
        return await confirmIfOldReceipt(footer.date);
      }
      // dismissed without a date → can't proceed
      await bailWithLog(sessionId, "ocr_no_text", { ocrPreview: "manual date entry cancelled", ...keyFieldsDiag() });
      return false;
    }
    // No receipt id → fail (no rescan loop). Include the OCR tail: the key
    // fields print at the BOTTOM, so the tail answers "cropped off or garbled?".
    await bailWithLog(sessionId, "ocr_no_text", {
      ocrPreview:
        `missing key fields: receiptNo=- date=${footer?.date ?? "-"} time=${footer?.time ?? "-"}` +
        ` | tail: ${ocrLineTexts.slice(-8).join(" ⏎ ")}`,
      ...keyFieldsDiag(),
    });
    return false;
  };

  // A usable receipt needs at least ONE product with a real NAME and a
  // positive PRICE — else bail with a "retake" prompt instead of saving junk.
  const ensureHasProducts = async (products: any[], chainName: string): Promise<boolean> => {
    const list = Array.isArray(products) ? products : [];
    const hasName = (p: any) => typeof p?.name === "string" && p.name.trim().length > 0 && p.name.trim() !== "?";
    const hasPrice = (p: any) =>
      (typeof p?.price === "number" && p.price > 0) || (typeof p?.promoPrice === "number" && p.promoPrice > 0);
    if (list.some((p) => hasName(p) && hasPrice(p))) return true;
    await bailWithLog(sessionId, "no_products", {
      detectedChainName: chainName,
      ocrLineCount: ocrLineTexts.length,
      ocrPreview: `${list.length} parsed, 0 with a complete name+price (${chainName})`,
      parsedData: JSON.stringify({ lineTexts: ocrLineTexts }),
    });
    return false;
  };

  try {
    sessionSet(sessionId, { stage: "scanning" });

    // SHARED OCR pipeline — the exact per-page loop the dev batch and the
    // recovery flow run. The interactive scan must never branch off it.
    const ocrResult = await ocrReceiptPages(imageUris, "auto", {
      document: fromPdf,
      stripHealing: true,
    });
    if (!isCurrentSession(sessionId)) return;
    const allLines = ocrResult.allLines as LineWithFrame[];
    const collectedPageMetas: PageMeta[] = ocrResult.pageMetas;
    const firstPageDims = { width: ocrResult.firstPageWidth, height: ocrResult.firstPageHeight };

    // CANONICAL IMAGE = the ROTATED page that OCR actually ran on, NOT the raw
    // capture. All region geometry lives in this rotated portrait space.
    const canonicalImageUri = collectedPageMetas[0]?.uri ?? null;
    const imageDims = firstPageDims ?? { width: 0, height: 0 };
    if (currentRun?.sessionId === sessionId) {
      currentRun.imageUri = canonicalImageUri;
      currentRun.imageDims = imageDims;
    }

    // Detect bank/loyalty/cashier redaction boxes for the pre-upload masking.
    const detectedMaskBands = detectCardMaskBands(allLines as any);
    console.log(
      `[MASK] detected ${detectedMaskBands.length} band(s):`,
      detectedMaskBands.map((b) => `${b.label}@${Math.round(b.yTop)}-${Math.round(b.yBottom)}`).join(", ") || "(none)",
    );

    const mergedLines = ocrResult.mergedLines as LineWithFrame[];
    const lineTexts = mergedLines.map((l) => l.text);
    ocrLineTexts = lineTexts;

    const dup = findDoubledScanToken(lineTexts);
    if (dup) {
      await bailWithLog(sessionId, "doubled_scan", { ocrPreview: `doubled scan: receiptNo ${dup.token} ×${dup.count}` });
      return;
    }

    if (__DEV__) {
      // DEV-only verbose OCR dump for parser debugging. Raw OCR holds pre-mask
      // PII, so it must NEVER reach prod logs.
      console.log("=== MERGED OCR LINES ===");
      mergedLines.forEach((l, i) => console.log(`${i}: [y=${Math.round(l.yTop)}] ${l.text}`));
      const rawDump = lineTexts.join("\n");
      console.log(
        `=== DEDUPED RAW TEXT (${lineTexts.length} lines) ===\n` + rawDump + "\n=== END RAW TEXT ===",
      );
      Clipboard.setStringAsync(rawDump).catch(() => {});
      console.log(`[dev] raw OCR (${lineTexts.length} lines) copied to clipboard ✂️`);
    }

    // OCR produced nothing usable — bail before trying chain detection.
    if (lineTexts.filter((t) => t.trim().length > 0).length < 3) {
      await bailWithLog(sessionId, "ocr_no_text", {
        ocrLineCount: lineTexts.length,
        ocrPreview: lineTexts.join("\n").slice(0, 500),
      });
      return;
    }

    // Chain-match gate + auto store-link resolution (list-upload flow only).
    let linkListId: number | null = fallbackLinkId;
    const expectedChainIds = Object.keys(linkMap).map(Number);
    const detectedScan = detectReceiptChain(lineTexts);
    if (expectedChainIds.length > 0) {
      const detectedChainId = detectedScan.chainId;
      if (detectedChainId != null && linkMap[detectedChainId] != null) {
        linkListId = linkMap[detectedChainId];
      } else {
        const proceed = await requestSessionInput<boolean>(sessionId, {
          kind: "chainGate",
          detectedChainId: detectedChainId ?? 0,
          expectedChainIds,
        });
        if (!proceed) {
          // Backing out is a retry, NOT a failure (not logged). The attached
          // screen navigates back to the list tab on this completion.
          sessionSet(sessionId, { phase: "done", completion: { kind: "cancelled_list" } });
          return;
        }
        // Override: shopped at an unplanned store — fulfil the first
        // awaiting store slot of this list/group.
        linkListId = Object.values(linkMap)[0] ?? fallbackLinkId;
      }
    }
    if (currentRun?.sessionId === sessionId) currentRun.linkListId = linkListId;

    // THE single scan flow (utils/receiptScanFlow): chain parse → Phase-5
    // ensemble → rimi photo section re-OCR + primary-name graft → iki
    // whole-section re-OCR + footer band refine.
    const scanFlowArgs = {
      ocr: { allLines, mergedLines, pageMetas: collectedPageMetas },
      imageUris,
      document: fromPdf,
    };

    let header: HeaderData | null = null;
    let products: ProductLine[] = [];
    let footer: FooterData | null = null;
    let skippedRegions: LabeledRegion[] = [];
    let wordsDump: unknown;
    let wordsSrc = "none";

    const chain = detectedScan.chain;
    if (chain === "rimi" || chain === "maxima" || chain === "norfa" || chain === "lidl") {
      const CHAIN_META = {
        rimi: { chainId: 2, chainName: "RIMI" },
        maxima: { chainId: 1, chainName: "MAXIMA" },
        norfa: { chainId: 4, chainName: "NORFA" },
        lidl: { chainId: 5, chainName: "LIDL" },
      } as const;
      const { chainId, chainName } = CHAIN_META[chain];

      const parsed = (await parseChainReceipt(chain, scanFlowArgs)).parsed;
      if (!isCurrentSession(sessionId)) return;
      logParsedReview(chainName, parsed);
      if (!(await ensureHasProducts(parsed.products, chainName))) return;
      if (!(await ensureKeyReceiptFields(parsed.footer))) return;

      const store = await resolveChainStore(sessionId, opts, chainId, chainName, parsed.header);
      if (!store) {
        await bailWithLog(sessionId, "store_unrecognized", {
          detectedChainName: chainName,
          extractedStoreAddress: parsed.header.storeAddress || null,
        });
        return;
      }

      header = {
        chainName,
        chainId,
        storeCode: parsed.header.storeCode,
        storeAddress: parsed.header.storeAddress,
        storeId: store.storeId,
        storeName: store.storeName,
        storeAddressMatched: store.storeAddressMatched,
        matchConfidence: store.matchConfidence,
        matchLoading: false,
        rawText: parsed.header.rawText,
        region: parsed.header.region,
        // NOTE: lineRegions deliberately NOT set for these chains — exact
        // parity with the old in-screen applyXResult, which only IKI-persisted
        // them (the reopen rehydration pass builds the others' bands).
        // Fresh parse is authoritative — don't let rehydration re-OCR + clobber it.
        regionsVersion: REGIONS_VERSION,
      };

      // Per-chain amount/sizeUnit semantics preserved exactly (they differ
      // deliberately — see each chain's original applyXResult).
      products = await matchChainProducts(sessionId, chainId, parsed.products, (p: any, s) => {
        if (chain === "rimi") {
          // Rimi receipts often embed volume without a unit ("NATURĀ, 1,51" =
          // 1.51 L): a stripped bare decimal 0.1–5 that isn't an integer → litres.
          let amount = p.parsedAmount ?? s.amount;
          let sizeUnit = p.parsedUnit ?? s.unit;
          const matchName = s.strippedName || p.name;
          if (amount === null && s.strippedName !== p.name) {
            const tail = p.name.slice(s.strippedName.length).replace(/^[,\s]+/, "");
            const bare = parseFloat(tail.replace(",", "."));
            if (Number.isFinite(bare) && bare > 0.1 && bare <= 5 && !Number.isInteger(bare)) {
              amount = bare;
              sizeUnit = "l";
            }
          }
          // ABSURD-LENGTH guard (receipt-272): no real product name is >80 chars;
          // skip the match outright so a phantom mega-line can't stall the UI.
          const skipMatch = matchName.length > 80;
          if (skipMatch) console.warn(`[match] skipped absurd-length name (${matchName.length} chars)`);
          return { matchName, amount, sizeUnit, skipMatch };
        }
        if (chain === "maxima") {
          // mp.name is already cleaned (size stripped); sizes come from the parser.
          return { matchName: s.strippedName || p.name, amount: p.parsedAmount ?? null, sizeUnit: p.parsedUnit ?? null };
        }
        if (chain === "norfa") {
          return { matchName: s.strippedName || p.name, amount: p.parsedAmount ?? s.amount, sizeUnit: p.parsedUnit ?? s.unit };
        }
        // lidl: name-parse only (parser sizes feed the headless queue path, not here).
        return { matchName: s.strippedName || p.name, amount: s.amount, sizeUnit: s.unit };
      });

      footer = {
        total: parsed.footer.total,
        date: parsed.footer.date,
        time: parsed.footer.time,
        receiptNo: parsed.footer.receiptNo,
        receiptNos: parsed.footer.receiptNos,
        totalSavings: parsed.footer.totalSavings,
        comboDiscount: null,
        rawText: parsed.footer.rawText,
        region: parsed.footer.region,
        // lineRegions deliberately omitted — see the header note above.
      };
    } else if (chain === "iki") {
      // Capture the exact per-WORD lines the IKI column engine consumes, so a
      // failing receipt can be reproduced 1:1 in a jest fixture. wordsDump
      // ships in staging+prod, so it MUST be PII-safe: redact any word inside
      // a mask band (or that LOOKS like a card/loyalty number) to '[•••]'.
      const buildWordsDump = (ls: LineWithFrame[]) => ls.map((l) => ({
        t: redactReceiptText(l.text),
        x: [Math.round(l.xLeft), Math.round(l.xRight)],
        y: [Math.round(l.yTop), Math.round(l.yBottom)],
        c: l.yLeftTop != null
          ? [Math.round(l.yLeftTop), Math.round(l.yRightTop ?? l.yTop), Math.round(l.yLeftBottom ?? l.yBottom), Math.round(l.yRightBottom ?? l.yBottom)]
          : undefined,
        w: l.words?.map((w) => {
          const pii = wordCentreInMaskBand(w as any, detectedMaskBands) || looksLikePiiText(w.text);
          return [
            pii ? "[•••]" : w.text, Math.round(w.xLeft), Math.round(w.xRight), Math.round(w.yTop), Math.round(w.yBottom),
            w.cornerPoints?.length ? w.cornerPoints.flatMap((pt) => [Math.round(pt.x), Math.round(pt.y)]) : undefined,
          ];
        }),
      }));
      wordsDump = buildWordsDump(mergedLines);
      wordsSrc = "scan";

      // The user-facing ensure* gates run BETWEEN the ensemble and the
      // whole-section re-OCR (their historical position) via beforeIkiReocr.
      let ikiGateBailed = false;
      const flow = await parseChainReceipt("iki", {
        ...scanFlowArgs,
        reportIkiReocr: true,
        beforeIkiReocr: async (p: any) => {
          if (!(await ensureHasProducts(p.products, "IKI"))) { ikiGateBailed = true; return false; }
          if (!(await ensureKeyReceiptFields(p.footer))) { ikiGateBailed = true; return false; }
          return true;
        },
      });
      if (!isCurrentSession(sessionId)) return;
      const parsed = flow.parsed;
      console.log(
        `[parse] IKI → ${parsed.products.length} product(s), total=${parsed.footer.total}, ` +
        `date=${parsed.footer.date}, receiptNo=${parsed.footer.receiptNo}`,
      );
      logParsedReview("IKI", parsed);
      // A stored wordsDump must reproduce the STORED parse — re-emit it from
      // the winning engine's lines when the ensemble flipped to ML Kit.
      if (flow.secondOcr) {
        wordsDump = buildWordsDump(flow.secondOcr.mergedLines as any);
      }
      if (flow.ikiGateFailed || ikiGateBailed) return; // bail already published

      skippedRegions = parsed.skippedRegions ?? [];

      const chainId = 3;
      const store = await resolveChainStore(sessionId, opts, chainId, "IKI", parsed.header);
      if (!store) {
        await bailWithLog(sessionId, "store_unrecognized", {
          detectedChainName: "IKI",
          extractedStoreAddress: parsed.header.storeAddress || null,
        });
        return;
      }
      if (store.manualPick) {
        // MANUAL pick ⇒ the OCR address was wrong or absent — its band is noise
        // at best and lands on a PRODUCT row at worst (receipt-297). Drop the
        // address band from display AND the persisted blob.
        parsed.header.lineRegions = (parsed.header.lineRegions ?? []).filter(
          (r: any) => r?.kind !== "storeAddress",
        );
      }

      header = {
        chainName: "IKI",
        chainId,
        storeCode: parsed.header.storeCode,
        storeAddress: parsed.header.storeAddress,
        storeId: store.storeId,
        // Prefer DB-matched name, fall back to OCR-extracted so the header card
        // shows something identifiable even when the store isn't in the DB yet.
        storeName: store.storeName ?? (parsed.header.storeName || null),
        storeAddressMatched: store.storeAddressMatched,
        matchConfidence: store.matchConfidence,
        matchLoading: false,
        rawText: parsed.header.rawText,
        region: parsed.header.region,
        lineRegions: parsed.header.lineRegions,
        regionsVersion: REGIONS_VERSION,
      };

      products = await matchChainProducts(sessionId, chainId, parsed.products as IkiProduct[], (p: any, s) => ({
        matchName: s.strippedName || p.name,
        amount: s.amount,
        sizeUnit: s.unit,
      }));

      footer = {
        total: parsed.footer.total,
        date: parsed.footer.date,
        time: parsed.footer.time,
        receiptNo: parsed.footer.receiptNo,
        receiptNos: parsed.footer.receiptNos,
        totalSavings: parsed.footer.totalSavings,
        comboDiscount: parsed.footer.comboDiscount ?? null,
        rawText: parsed.footer.rawText,
        region: parsed.footer.region,
        lineRegions: parsed.footer.lineRegions,
      };
    } else {
      await bailWithLog(sessionId, "chain_unrecognized", {
        ocrLineCount: lineTexts.length,
        ocrPreview: lineTexts.slice(0, 20).join("\n").slice(0, 500),
      });
      return;
    }

    if (!header || !footer || !isCurrentSession(sessionId)) return;

    // Privacy masks, clamped so they never cover a recognised data band
    // (product / header / footer line) — e.g. the cashier mask creeping over
    // "Kvito Nr.". Used for both the burned upload and the persisted blob.
    const protectedRegions = [
      ...(header.lineRegions ?? []),
      ...(footer.lineRegions ?? []),
      ...products.map((p) => p.region).filter(Boolean),
    ];
    const maskBandsClamped = clampMaskBandsToProtected(detectedMaskBands, protectedRegions as any);

    const parse: ScanParseResult = {
      header,
      products,
      footer,
      skippedRegions,
      pageMetas: collectedPageMetas,
      maskBands: detectedMaskBands,
      imageUri: canonicalImageUri,
      imageDims,
      wordsDump,
      wordsSrc,
    };
    sessionSet(sessionId, { parse });

    if (opts.preview) {
      // Preview mode: OCR + parsing populate the UI, nothing is POSTed.
      sessionSet(sessionId, { phase: "done", completion: { kind: "preview" } });
      return;
    }

    const parsedData = buildParsedData(
      header,
      products,
      footer,
      imageDims ? { uri: canonicalImageUri, ...imageDims } : null,
      null,
      maskBandsClamped,
      wordsDump,
    );
    if (currentRun?.sessionId === sessionId) {
      currentRun.parsedData = parsedData;
      currentRun.maskBandsClamped = maskBandsClamped;
    }

    await runPost(sessionId);
  } catch (error) {
    console.error("OCR error:", error);
    await bailWithLog(sessionId, "ocr_error", {
      ocrPreview: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Step 1: POST the receipt. Publishes `done` with the completion variant;
 *  the photo upload then continues in the background (step 2). */
async function runPost(sessionId: number): Promise<void> {
  const run = currentRun;
  if (!run || run.sessionId !== sessionId || !run.parsedData) return;
  const { opts } = run;
  sessionSet(sessionId, { phase: "saving", stage: "sending", postStatus: "pending", postErr: null });
  run.resumedPhotoPresent = false;
  try {
    const userId = run.userId ?? (await getUserId());
    run.userId = userId;

    // DEV re-OCR: retire the OLD receipt right before creating the fresh one —
    // done HERE (not on entry) so a bail-to-retake earlier leaves the original
    // intact, and so the create isn't rejected as a duplicate (same receiptNo).
    if (opts.reocrReceiptId != null && Number.isFinite(opts.reocrReceiptId)) {
      try {
        await fetch(`${API_BASE_URL}/api/receipts/${opts.reocrReceiptId}`, { method: "DELETE" });
      } catch (e) {
        console.warn("[reocr] old-receipt delete failed (continuing):", e);
      }
    }

    const res = await fetchWithTimeout(`${API_BASE_URL}/api/receipts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, filePath: "", parsedData: run.parsedData }),
      timeoutMs: TIMEOUT_HEAVY_MS,
    });
    const data = await res.json();
    if (res.status === 409) {
      // SAME-ACCOUNT duplicate on a FRESH SCAN with the photo still in hand —
      // but ONLY when the existing row is INCOMPLETE (photo never landed, or
      // mandatory swipes still owed) → RESUME the pipeline against it. A
      // COMPLETE duplicate is a deliberate re-scan → honest alert (screen).
      const existingId = Number(data?.existingReceiptId);
      const resumable = data?.photoPending === true || Number(data?.mandatorySwipesPending ?? 0) > 0;
      if (!data?.crossAccount && resumable && Number.isFinite(existingId) && existingId > 0 && run.imageUri) {
        // Swipes-only resume: the server photo EXISTS — the upload step must
        // not replace it with this scan's frame.
        run.resumedPhotoPresent = data?.photoPending !== true;
        run.receiptId = existingId;
        console.log(`[post] duplicate of r${existingId} — resuming pipeline against it (photoPending=${data?.photoPending === true}, swipes=${Number(data?.mandatorySwipesPending ?? 0)})`);
        useReceiptQueueStore.getState().noteReceiptCreated(existingId);
        if (run.linkListId) linkReceiptToList(run.linkListId, existingId);
        clearReceiptDraft().catch(() => {});
        sessionSet(sessionId, {
          phase: "done",
          postStatus: "done",
          completion: {
            kind: "saved",
            receiptId: existingId,
            pendingSwipes: Number(data?.mandatorySwipesPending ?? 0),
            resumedPhotoPresent: run.resumedPhotoPresent,
          },
        });
        void runUpload(sessionId);
        return;
      }
      // Complete duplicate (same- or cross-account): nothing to resume. Drop
      // the local draft — the data lives in someone's receipt list. The screen
      // (or the Analyze card tap) surfaces the alert + navigation.
      clearReceiptDraft().catch(() => {});
      useProfileStore.getState().invalidate();
      const linkedToList = !!(run.linkListId && data?.existingReceiptId && !data?.crossAccount);
      if (linkedToList) linkReceiptToList(run.linkListId!, Number(data.existingReceiptId));
      sessionSet(sessionId, {
        phase: "done",
        postStatus: "done",
        completion: {
          kind: "duplicate",
          existingReceiptId: Number.isFinite(existingId) ? existingId : null,
          crossAccount: data?.crossAccount === true,
          linkedToList,
        },
      });
      return;
    }
    if (!res.ok || !data?.id) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    run.receiptId = data.id;
    // Tell the shared queue store the receipt now exists so the Analyze list
    // refetches immediately and the receipt lands in "Nauji".
    useReceiptQueueStore.getState().noteReceiptCreated(data.id);
    if (run.linkListId) linkReceiptToList(run.linkListId, data.id);
    clearReceiptDraft().catch(() => {});
    // Record store visit for location intelligence (fire-and-forget).
    const header = useScanSession.getState().parse?.header;
    if (useScanSession.getState().sessionId === sessionId && header?.storeId && header?.chainId) {
      fetch(`${API_BASE_URL}/api/stores/${header.storeId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((store) => {
          if (store?.latitude && store?.longitude) {
            recordStoreVisit(header.storeId!, store.latitude, store.longitude, header.chainId!, header.chainName).catch(() => {});
          }
        })
        .catch(() => {});
    }
    sessionSet(sessionId, {
      phase: "done",
      postStatus: "done",
      completion: {
        kind: "saved",
        receiptId: data.id,
        pendingSwipes: data.mandatorySwipesRequired ?? 0,
        resumedPhotoPresent: false,
      },
    });
    void runUpload(sessionId);
  } catch (e: any) {
    console.warn("Receipt POST failed:", e);
    // Retries stay MANUAL/edge-triggered via retryScanPost (the screen's
    // reconnect + interval effects) — a deterministic server rejection must
    // not loop (the garbled-date 500, receipt-242).
    sessionSet(sessionId, { postStatus: "error", postErr: e?.message || i18n.t("receiptProcess.errorSave") });
  }
}

function linkReceiptToList(listId: number, receiptId: number): void {
  // Fire-and-forget — the List-tab card flips to "Kvitas pridėtas" on refresh.
  fetch(`${API_BASE_URL}/api/shopping-lists/${listId}/link-receipt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ receiptId }),
  }).catch(() => {});
}

/** Step 2: burn masks + upload the photo to MinIO, PATCH filePath. Runs after
 *  POST succeeds; failures leave the receipt usable (data is in the DB). */
async function runUpload(sessionId: number): Promise<void> {
  const run = currentRun;
  if (!run || run.sessionId !== sessionId) return;
  if (!run.imageUri || !run.receiptId) return;
  // Duplicate RESUME where the server photo already exists (swipes-only
  // recovery): uploading would overwrite the stored, already-redacted image.
  if (run.resumedPhotoPresent) {
    console.log("[upload] skipped — resumed duplicate already has its photo");
    sessionSet(sessionId, { uploadStatus: "done" });
    return;
  }
  sessionSet(sessionId, { uploadStatus: "pending", uploadErr: null, stage: "uploading" });
  try {
    const urlRes = await fetchWithTimeout(`${API_BASE_URL}/api/receipts/upload-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: `receipt-${run.receiptId}.jpg`, mimeType: "image/jpeg" }),
      timeoutMs: TIMEOUT_STANDARD_MS,
    });
    if (!urlRes.ok) throw new Error(`upload-url HTTP ${urlRes.status}`);
    const { uploadUrl, filePath } = await urlRes.json();
    if (!uploadUrl || !filePath) throw new Error(i18n.t("receiptProcess.errorUploadUrlFields"));

    // Burn the card/loyalty/cashier black boxes into the image BEFORE upload —
    // the raw card data never leaves the device. Fail-closed: if sensitive
    // bands were detected but a clean redaction can't be produced, abort.
    let uploadW = run.imageDims?.width ?? 0;
    let uploadH = run.imageDims?.height ?? 0;
    if (!(uploadW > 0) || !(uploadH > 0)) {
      try {
        // TRUE decoder pixels via ImageManipulator — NOT Image.getSize, which
        // down-samples tall images (an undersized denominator would
        // misposition the burned bands).
        const info = await ImageManipulator.manipulateAsync(run.imageUri, []);
        if (!(uploadW > 0)) uploadW = info.width;
        if (!(uploadH > 0)) uploadH = info.height;
      } catch { /* leave 0 — buildRedactedUploadUri fail-closes if bands exist */ }
    }
    let uploadUri = run.imageUri;
    try {
      uploadUri = await buildRedactedUploadUri(run.imageUri, uploadW, uploadH, run.maskBandsClamped);
    } catch (e: any) {
      console.warn("[mask] redaction failed, aborting upload:", e?.message ?? e);
      fetch(`${API_BASE_URL}/api/receipts/log-fail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: run.userId,
          failReason: "mask_failed",
          shoppingListId: run.linkListId ?? undefined,
        }),
      }).catch(() => {});
      sessionSet(sessionId, { uploadStatus: "error", uploadErr: i18n.t("receiptProcess.errorMaskFailed") });
      return;
    }

    // Local-file blob load is NOT a network call; no timeout needed.
    const imageBlob = await (await fetch(uploadUri)).blob();
    const putRes = await fetchWithTimeout(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: imageBlob,
      timeoutMs: TIMEOUT_HEAVY_MS,
    });
    if (!putRes.ok) throw new Error(`MinIO PUT HTTP ${putRes.status}`);

    const patchRes = await fetchWithTimeout(
      `${API_BASE_URL}/api/receipts/${run.receiptId}/file-path`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath }),
        timeoutMs: TIMEOUT_STANDARD_MS,
      },
    );
    if (!patchRes.ok) throw new Error(`PATCH HTTP ${patchRes.status}`);

    sessionSet(sessionId, { uploadStatus: "done", imageFilePath: filePath });

    // Cache the EXACT redacted bytes we just persisted at the canonical reopen
    // path so a later reopen short-circuits to the local file. Best-effort.
    try {
      const cacheDir = FileSystem.cacheDirectory ?? "";
      if (cacheDir && uploadUri) {
        const dest = `${cacheDir}receipt-${run.receiptId}.jpg`;
        if (uploadUri !== dest) {
          await FileSystem.deleteAsync(dest, { idempotent: true });
          await FileSystem.copyAsync({ from: uploadUri, to: dest });
        }
      }
    } catch { /* non-fatal: the reopen path will just download as before */ }
  } catch (e: any) {
    console.warn("MinIO upload failed:", e);
    sessionSet(sessionId, { uploadStatus: "error", uploadErr: e?.message || i18n.t("receiptProcess.errorUploadPhoto") });
  }
}

/** Screen-driven retry of a failed POST (reconnect / interval / button). */
export function retryScanPost(): void {
  const s = useScanSession.getState();
  if (s.postStatus !== "error") return;
  if (!currentRun || currentRun.sessionId !== s.sessionId) return;
  void runPost(s.sessionId);
}

/** Screen-driven retry of a failed photo upload. */
export function retryScanUpload(): void {
  const s = useScanSession.getState();
  if (s.uploadStatus !== "error") return;
  if (!currentRun || currentRun.sessionId !== s.sessionId) return;
  void runUpload(s.sessionId);
}
