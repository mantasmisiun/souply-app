/**
 * Scan-session store lifecycle — the state machine that lets a receipt scan
 * survive the /receipt-process screen unmounting. Covers the session claim
 * rules (attach vs refuse vs replace), the input request/respond round-trip,
 * sessionId-guarded writes from replaced sessions, and the consume/reset
 * terminal handling the Analyze live card depends on.
 */
import {
  attachableSessionId,
  beginSession,
  consumeSession,
  isSessionLive,
  requestSessionInput,
  resetSession,
  respondSessionInput,
  sameUris,
  sessionSet,
  useScanSession,
  type StartScanOptions,
} from "../state/scanSession";
import { findDoubledScanToken } from "../services/scanSessionService";

// The service module pulls in the whole pipeline (OCR, parsers, i18n). The
// store tests only need findDoubledScanToken, so stub the heavy imports the
// service file loads at module scope.
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }), { virtual: true });
jest.mock("expo-file-system/legacy", () => ({ cacheDirectory: "/cache/" }), { virtual: true });
jest.mock("expo-image-manipulator", () => ({ manipulateAsync: jest.fn() }), { virtual: true });
jest.mock("../i18n", () => ({ t: (k: string) => k }));
jest.mock("../utils/receiptOcrPipeline", () => ({ ocrReceiptPages: jest.fn() }));
jest.mock("../utils/receiptScanFlow", () => ({ detectReceiptChain: jest.fn(), parseChainReceipt: jest.fn() }));
jest.mock("../components/MaskRedactionHost", () => ({ buildRedactedUploadUri: jest.fn() }));
jest.mock("../utils/locationStorage", () => ({ recordStoreVisit: jest.fn() }));
jest.mock("../config/user", () => ({ getUserId: jest.fn(async () => "u1") }));

const opts = (uris: string[]): StartScanOptions => ({
  imageUris: uris,
  pdfUri: null,
  fromPdf: false,
  preview: false,
  linkMap: {},
  fallbackLinkId: null,
  reocrReceiptId: null,
  entryParams: { uri: uris[0] },
});

const state = () => useScanSession.getState();

beforeEach(() => {
  // Hard-reset the singleton between cases.
  const sid = state().sessionId;
  if (sid) {
    consumeSession(sid);
    resetSession(sid);
  }
});

describe("beginSession claim rules", () => {
  it("starts a fresh session in phase processing", () => {
    const sid = beginSession(opts(["a.jpg"]));
    expect(sid).not.toBeNull();
    expect(state().phase).toBe("processing");
    expect(state().opts?.imageUris).toEqual(["a.jpg"]);
    expect(isSessionLive()).toBe(true);
  });

  it("re-attaches (same id) when the SAME uris are started again mid-flight", () => {
    const sid1 = beginSession(opts(["a.jpg"]));
    const sid2 = beginSession(opts(["a.jpg"]));
    expect(sid2).toBe(sid1);
  });

  it("refuses while a DIFFERENT scan is mid-flight", () => {
    beginSession(opts(["a.jpg"]));
    expect(beginSession(opts(["b.jpg"]))).toBeNull();
  });

  it("refuses during a healthy save, but allows replacement once the POST is in error", () => {
    const sid = beginSession(opts(["a.jpg"]))!;
    sessionSet(sid, { phase: "saving", postStatus: "pending" });
    expect(beginSession(opts(["b.jpg"]))).toBeNull();
    // Deterministic server rejection (e.g. a 500 on every retry) must NOT
    // wedge scanning for the whole app session — the old in-screen pipeline
    // let the user simply start a new scan.
    sessionSet(sid, { postStatus: "error", postErr: "HTTP 500" });
    const sid2 = beginSession(opts(["b.jpg"]));
    expect(sid2).not.toBeNull();
    expect(sid2).not.toBe(sid);
  });

  it("replaces a consumed terminal session", () => {
    const sid1 = beginSession(opts(["a.jpg"]))!;
    sessionSet(sid1, { phase: "failed", failMessage: "x" });
    consumeSession(sid1);
    const sid2 = beginSession(opts(["b.jpg"]));
    expect(sid2).not.toBeNull();
    expect(sid2).not.toBe(sid1);
    expect(state().phase).toBe("processing");
  });

  it("replaces an UNconsumed done session too (user moved on without opening it)", () => {
    // done-but-unconsumed is not "active" — refusing here would wedge new scans
    // behind a card the user may never tap. The receipt is already saved.
    const sid1 = beginSession(opts(["a.jpg"]))!;
    sessionSet(sid1, { phase: "done" });
    const sid2 = beginSession(opts(["b.jpg"]));
    expect(sid2).not.toBeNull();
    expect(sid2).not.toBe(sid1);
  });
});

describe("input request/respond round-trip", () => {
  it("parks on input and resumes with the responded value", async () => {
    const sid = beginSession(opts(["a.jpg"]))!;
    const pending = requestSessionInput<boolean>(sid, {
      kind: "chainGate",
      detectedChainId: 3,
      expectedChainIds: [2],
    });
    expect(state().phase).toBe("input");
    expect(state().inputRequest).toEqual({ kind: "chainGate", detectedChainId: 3, expectedChainIds: [2] });
    respondSessionInput(true);
    await expect(pending).resolves.toBe(true);
    expect(state().phase).toBe("processing");
    expect(state().inputRequest).toBeNull();
  });

  it("resolves undefined (cancel) when the session is replaced mid-input", async () => {
    const sid1 = beginSession(opts(["a.jpg"]))!;
    const pending = requestSessionInput<Date | null>(sid1, { kind: "date" });
    // Terminal-ise + consume so a new scan may claim the slot.
    sessionSet(sid1, { phase: "failed", failMessage: "x" });
    consumeSession(sid1);
    beginSession(opts(["b.jpg"]));
    await expect(pending).resolves.toBeUndefined();
    // The new session's state is untouched by the dangling resolver.
    expect(state().phase).toBe("processing");
  });

  it("respond with no open request is a no-op", () => {
    beginSession(opts(["a.jpg"]));
    expect(() => respondSessionInput(null)).not.toThrow();
    expect(state().phase).toBe("processing");
  });
});

describe("sessionId-guarded writes", () => {
  it("a replaced session's late writes are dropped", () => {
    const sid1 = beginSession(opts(["a.jpg"]))!;
    sessionSet(sid1, { phase: "failed", failMessage: "old" });
    consumeSession(sid1);
    const sid2 = beginSession(opts(["b.jpg"]))!;
    sessionSet(sid1, { phase: "done" }); // stale write from the old pipeline
    expect(state().sessionId).toBe(sid2);
    expect(state().phase).toBe("processing");
  });
});

describe("terminal handling (Analyze live card contract)", () => {
  it("done + unconsumed is live; consuming ends liveness; reset clears", () => {
    const sid = beginSession(opts(["a.jpg"]))!;
    sessionSet(sid, {
      phase: "done",
      completion: { kind: "saved", receiptId: 7, pendingSwipes: 2, resumedPhotoPresent: false },
    });
    expect(isSessionLive()).toBe(true);
    expect(attachableSessionId({ imageUris: ["a.jpg"] })).toBe(sid);
    expect(attachableSessionId({ imageUris: ["other.jpg"] })).toBeNull();
    consumeSession(sid);
    expect(isSessionLive()).toBe(false);
    expect(attachableSessionId({ imageUris: ["a.jpg"] })).toBeNull();
    resetSession(sid);
    expect(state().phase).toBe("idle");
    expect(state().completion).toBeNull();
  });
});

describe("pdf source identity", () => {
  it("a PDF session stays attachable after conversion swaps its imageUris", () => {
    const o = { ...opts([]), pdfUri: "file:///r.pdf" };
    const sid = beginSession(o)!;
    // conversion finished — pipeline publishes updated opts with page uris
    sessionSet(sid, { opts: { ...o, imageUris: ["p1.png", "p2.png"], fromPdf: true } });
    expect(attachableSessionId({ pdfUri: "file:///r.pdf", imageUris: [] })).toBe(sid);
    expect(attachableSessionId({ imageUris: ["p1.png", "p2.png"] })).toBeNull(); // pages ≠ source
  });
});

describe("sameUris", () => {
  it("matches only identical ordered lists", () => {
    expect(sameUris(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameUris(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameUris(["a"], ["a", "b"])).toBe(false);
    expect(sameUris(undefined, ["a"])).toBe(false);
  });
});

describe("findDoubledScanToken", () => {
  it("flags the IKI/Rimi full slashed id printed twice", () => {
    const hit = findDoubledScanToken([
      "IKI kvitas", "71/612/114973", "Pienas 1,09", "71/612/114973", "Viso 1,09",
    ]);
    expect(hit).toEqual({ token: "71/612/114973", count: 2 });
  });

  it("flags a doubled Maxima labelled id", () => {
    expect(findDoubledScanToken(["Kvito Nr. 1234567", "x", "Kvito Nr. 1234567"]))
      .toEqual({ token: "1234567", count: 2 });
  });

  it("flags a doubled Norfa labelled id", () => {
    expect(findDoubledScanToken(["# Kvito numeris 123456 #", "# Kvito numeris 123456 #"]))
      .toEqual({ token: "123456", count: 2 });
  });

  it("passes a single receipt (token printed once)", () => {
    expect(findDoubledScanToken(["71/612/114973", "Pienas 1,09", "Viso 1,09"])).toBeNull();
  });

  it("ignores Lidl's bare #00NNNNN form, which legitimately prints twice", () => {
    expect(findDoubledScanToken(["#0012345", "products", "#0012345"])).toBeNull();
  });

  it("does not cross-match different tokens", () => {
    expect(findDoubledScanToken(["71/612/114973", "0429/0022/802"])).toBeNull();
  });
});
