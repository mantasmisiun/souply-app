import { create } from "zustand";
import type { MaskBand } from "@shared/parsers/cardMaskDetection";
import type { LabeledRegion } from "@shared/parsers/rimiParser";
import type { PageMeta } from "../utils/receiptImage";
import type { HeaderData, ProductLine, FooterData } from "../utils/receiptParsedData";

/**
 * App-level scan-session store — the single source of truth for a fresh
 * receipt scan's processing state.
 *
 * The pipeline itself runs in services/scanSessionService.ts, OUTSIDE any
 * screen, so navigating away from /receipt-process no longer kills an
 * in-flight scan (the reported bug: tab-switch mid-processing unmounted the
 * screen, every setState was discarded and the POST-gating effect never
 * fired). The screen is a subscriber: it renders the loader/gates from this
 * store and hydrates its local detail state once the session completes. The
 * Analyze tab renders a live "processing" card from the same store.
 *
 * One session at a time (mirrors the old reality: starting a new scan
 * abandoned the previous screen instance). Every service-side write is
 * guarded by sessionId so a replaced session's in-flight async work becomes
 * a harmless no-op instead of corrupting the new session's state.
 */

export type ScanSessionPhase =
  | "idle"
  | "processing"   // OCR / parse / match in flight
  | "input"        // waiting on the user (date / chain gate / store map)
  | "saving"       // POST /api/receipts in flight
  | "done"         // completion published (see completion.kind)
  | "failed";      // bail — failMessage holds the user-facing text

export type ScanInputRequest =
  | { kind: "date" }
  | { kind: "chainGate"; detectedChainId: number; expectedChainIds: number[] }
  | { kind: "store"; chainId: number; chainName: string; prefill: string | null };

export type ScanStage = "scanning" | "matching" | "sending" | "uploading";

/** Everything the screen needs to render the detail after processing. */
export interface ScanParseResult {
  header: HeaderData;
  products: ProductLine[];
  footer: FooterData;
  skippedRegions: LabeledRegion[];
  pageMetas: PageMeta[];
  maskBands: MaskBand[];
  imageUri: string | null;
  imageDims: { width: number; height: number } | null;
  wordsDump: unknown;
  wordsSrc: string;
}

export type ScanCompletion =
  /** Receipt row exists (fresh create, or a resumable duplicate we recovered). */
  | {
      kind: "saved";
      receiptId: number;
      /** Mandatory swipe cards owed before the comparison shows (0 = none). */
      pendingSwipes: number;
      /** Duplicate-resume where the server photo already exists — upload skipped. */
      resumedPhotoPresent: boolean;
    }
  /** Preview mode — parsed only, nothing persisted. */
  | { kind: "preview" }
  /** Complete duplicate (nothing to resume). Screen shows the honest alert + navigates. */
  | { kind: "duplicate"; existingReceiptId: number | null; crossAccount: boolean; linkedToList: boolean }
  /** Chain-gate declined on a list upload — screen navigates back to the list tab. */
  | { kind: "cancelled_list" };

export type AsyncStatus = "idle" | "pending" | "done" | "error";

export interface StartScanOptions {
  imageUris: string[];
  fromPdf: boolean;
  preview: boolean;
  /** chainId→listId map for the list-upload flow ({} when free scan). */
  linkMap: Record<number, number>;
  /** Single-store list with unknown chain: link unconditionally. */
  fallbackLinkId: number | null;
  /** DEV re-OCR: existing receipt id to retire right before the fresh POST. */
  reocrReceiptId: number | null;
  /** The exact /receipt-process query params that opened this scan — the
   *  Analyze live card re-navigates with these to re-attach. */
  entryParams: Record<string, string>;
}

interface ScanSessionState {
  sessionId: number; // 0 = no session ever started
  phase: ScanSessionPhase;
  opts: StartScanOptions | null;
  stage: ScanStage;
  matchProgress: { done: number; total: number } | null;
  inputRequest: ScanInputRequest | null;
  parse: ScanParseResult | null;
  completion: ScanCompletion | null;
  postStatus: AsyncStatus;
  postErr: string | null;
  uploadStatus: AsyncStatus;
  uploadErr: string | null;
  imageFilePath: string | null;
  failMessage: string | null;
  /** The attached screen hydrated this session's terminal state (one-shot). */
  consumed: boolean;
}

const INITIAL: Omit<ScanSessionState, "sessionId"> = {
  phase: "idle",
  opts: null,
  stage: "scanning",
  matchProgress: null,
  inputRequest: null,
  parse: null,
  completion: null,
  postStatus: "idle",
  postErr: null,
  uploadStatus: "idle",
  uploadErr: null,
  imageFilePath: null,
  failMessage: null,
  consumed: false,
};

export const useScanSession = create<ScanSessionState>(() => ({
  sessionId: 0,
  ...INITIAL,
}));

let nextSessionId = 1;
let inputResolver: { sessionId: number; resolve: (value: unknown) => void } | null = null;

/** True while the session still owns work or unseen results. */
export function isSessionLive(s: ScanSessionState = useScanSession.getState()): boolean {
  if (s.sessionId === 0) return false;
  if (isSessionActive(s)) return true;
  return (s.phase === "done" || s.phase === "failed") && !s.consumed;
}

/**
 * Mid-flight = must not be silently replaced by a new scan. A 'saving' session
 * whose POST is in ERROR is deliberately NOT active: a deterministic server
 * rejection would otherwise wedge scanning for the whole app session (retries
 * are screen-driven and fail identically) — the old in-screen pipeline let the
 * user simply start over, so replacement must stay possible.
 */
function isSessionActive(s: ScanSessionState): boolean {
  if (s.phase === "processing" || s.phase === "input") return true;
  return s.phase === "saving" && s.postStatus !== "error";
}

/**
 * Claim a fresh session slot. Refuses (returns null) while a live session is
 * mid-flight for DIFFERENT images — the caller should attach to that one via
 * the Analyze card instead of silently killing an unsaved receipt.
 */
export function beginSession(opts: StartScanOptions): number | null {
  const s = useScanSession.getState();
  const active = isSessionActive(s);
  if (active && sameUris(s.opts?.imageUris, opts.imageUris)) return s.sessionId; // re-attach
  if (active) return null;
  // Cancel a dangling input resolver from a replaced session (it would leak the await).
  if (inputResolver) {
    const r = inputResolver;
    inputResolver = null;
    r.resolve(undefined);
  }
  const sessionId = nextSessionId++;
  useScanSession.setState({ sessionId, ...INITIAL, phase: "processing", opts });
  return sessionId;
}

export function sameUris(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((u, i) => u === b[i]);
}

/** Find the session to attach to for these entry uris (live or unconsumed-terminal). */
export function attachableSessionId(imageUris: string[]): number | null {
  const s = useScanSession.getState();
  if (!isSessionLive(s)) return null;
  return sameUris(s.opts?.imageUris, imageUris) ? s.sessionId : null;
}

/** sessionId-guarded setState — a replaced session's late writes are no-ops. */
export function sessionSet(sessionId: number, patch: Partial<ScanSessionState>): void {
  if (useScanSession.getState().sessionId !== sessionId) return;
  useScanSession.setState(patch);
}

export function isCurrentSession(sessionId: number): boolean {
  return useScanSession.getState().sessionId === sessionId;
}

/**
 * Pipeline-side: park the session on a user-input request. Resolves when an
 * attached screen answers via respondSessionInput. If the session gets
 * replaced meanwhile, resolves undefined (callers treat it as a cancel).
 */
export function requestSessionInput<T>(sessionId: number, req: ScanInputRequest): Promise<T | undefined> {
  if (!isCurrentSession(sessionId)) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve) => {
    inputResolver = { sessionId, resolve: resolve as (value: unknown) => void };
    sessionSet(sessionId, { inputRequest: req, phase: "input" });
  });
}

/** Screen-side: answer the open input request. */
export function respondSessionInput(value: unknown): void {
  const r = inputResolver;
  if (!r) return;
  inputResolver = null;
  sessionSet(r.sessionId, { inputRequest: null, phase: "processing" });
  r.resolve(value);
}

/** Screen-side: mark the terminal state as hydrated (one-shot). */
export function consumeSession(sessionId: number): void {
  sessionSet(sessionId, { consumed: true });
}

/** Drop the session entirely (failed + acknowledged, or done + consumed + uploads settled). */
export function resetSession(sessionId: number): void {
  if (!isCurrentSession(sessionId)) return;
  useScanSession.setState({ sessionId, ...INITIAL });
}
