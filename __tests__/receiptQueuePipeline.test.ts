/**
 * Pipeline-level tests for the receipt-batch flow.
 *
 * Strategy: rather than mounting `useReceiptQueueRunner` (which would
 * require a React-renderer + native-module dance for AppState, NetInfo,
 * and reanimated), we test the two things that drive the pipeline:
 *
 *   1. `routeQueueError` — the runner's error-routing decision, which
 *      is the centrepiece of the new logic (ProcessingError vs NetworkError
 *      vs offline). Pure function.
 *
 *   2. End-to-end *state* progression by driving the store through the
 *      exact action sequences the runner would emit — pending →
 *      processing → done/error/awaiting → resume → pending → done.
 *      This proves the contract between runner and store holds.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  NetworkError,
  ProcessingError,
} from "../services/receiptProcessingService";
import { routeQueueError } from "../hooks/useReceiptQueueRunner";
import { useReceiptQueueStore } from "../state/receiptQueueStore";

// --- AsyncStorage in-memory mock (same as the store-only test) ---------------
jest.mock("@react-native-async-storage/async-storage", () => {
  let storage: Record<string, string> = {};
  return {
    __esModule: true,
    default: {
      setItem: jest.fn((k: string, v: string) => {
        storage[k] = v;
        return Promise.resolve();
      }),
      getItem: jest.fn((k: string) => Promise.resolve(storage[k] ?? null)),
      removeItem: jest.fn((k: string) => {
        delete storage[k];
        return Promise.resolve();
      }),
      __reset: () => {
        storage = {};
      },
    },
  };
});

// Native modules pulled in via service → keep import-time happy.
jest.mock("@react-native-ml-kit/text-recognition", () => ({
  __esModule: true,
  default: { recognize: jest.fn() },
}));
jest.mock("expo-image-manipulator", () => ({
  manipulateAsync: jest.fn(),
  SaveFormat: { JPEG: "jpeg" },
}));
jest.mock("expo-crypto", () => ({ randomUUID: () => "test-uuid" }));

const asyncStorageMock = AsyncStorage as unknown as {
  __reset: () => void;
};

beforeEach(() => {
  asyncStorageMock.__reset();
  useReceiptQueueStore.setState({
    items: [],
    recentIds: [],
    lastCompletedAt: null,
    initialized: false,
  });
});

// =============================================================================
// 1. routeQueueError — the new error-routing decision
// =============================================================================

describe("routeQueueError", () => {
  it("ProcessingError → error with message and isDuplicate=false", () => {
    const result = routeQueueError(
      new ProcessingError("store_unrecognized", "Parduotuvė neatpažinta"),
      true,
    );
    expect(result).toEqual({
      kind: "error",
      message: "Parduotuvė neatpažinta",
      isDuplicate: false,
    });
  });

  it("ProcessingError post_failed 'Kvitas jau įkeltas' → error with isDuplicate=true", () => {
    const result = routeQueueError(
      new ProcessingError("post_failed", "Kvitas jau įkeltas"),
      true,
    );
    expect(result).toEqual({
      kind: "error",
      message: "Kvitas jau įkeltas",
      isDuplicate: true,
    });
  });

  it("NetworkError → awaiting_network (regardless of isOnline)", () => {
    const onlineCase = routeQueueError(new NetworkError("Network request failed"), true);
    const offlineCase = routeQueueError(new NetworkError("Network request failed"), false);
    expect(onlineCase).toEqual({ kind: "awaiting_network" });
    expect(offlineCase).toEqual({ kind: "awaiting_network" });
  });

  it("ProcessingError while offline → STILL error (deterministic failure wins over connectivity)", () => {
    // This is the bug I caught during the audit: if we checked offline
    // before ProcessingError, a bad-OCR receipt would keep being marked
    // awaiting_network and retried forever on reconnect.
    const result = routeQueueError(
      new ProcessingError("ocr_no_text", "Nepavyko nuskaityti teksto"),
      false,
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toBe("Nepavyko nuskaityti teksto");
    }
  });

  it("Unknown error while offline → awaiting_network", () => {
    const result = routeQueueError(new Error("???"), false);
    expect(result).toEqual({ kind: "awaiting_network" });
  });

  it("Unknown error while online → generic error message", () => {
    const result = routeQueueError(new Error("anything"), true);
    expect(result).toEqual({
      kind: "error",
      message: "Nepavyko apdoroti kvito",
      isDuplicate: false,
    });
  });
});

// =============================================================================
// 2. End-to-end state progressions
// =============================================================================

/** Mirrors what the runner does on a successful service call. */
function simulateSuccess(itemId: string, receiptId: number) {
  const s = useReceiptQueueStore.getState();
  s.markProcessing(itemId, "Nuskaitoma...");
  s.updateProgress(itemId, "Atpažįstama...");
  s.updateProgress(itemId, "3/8 prekės", 3, 8);
  s.updateProgress(itemId, "8/8 prekės", 8, 8);
  s.updateProgress(itemId, "Išsaugoma...");
  s.markDone(itemId, receiptId);
}

/** Mirrors what the runner does on a service failure (with routing). */
function simulateFailure(itemId: string, error: unknown, isOnline: boolean) {
  const s = useReceiptQueueStore.getState();
  s.markProcessing(itemId, "Nuskaitoma...");
  const routing = routeQueueError(error, isOnline);
  if (routing.kind === "awaiting_network") {
    s.markAwaitingNetwork(itemId);
  } else {
    s.markError(itemId, routing.message);
  }
  return routing;
}

describe("pipeline — happy path (single receipt)", () => {
  it("pending → processing → done; recentIds picks up the receiptId; lastCompletedAt bumps", () => {
    useReceiptQueueStore.getState().addItems([{ uris: ["file://a.jpg"], name: "a.jpg" }]);
    expect(useReceiptQueueStore.getState().items[0].status).toBe("pending");

    const itemId = useReceiptQueueStore.getState().items[0].id;
    const beforeTs = Date.now() - 1;
    simulateSuccess(itemId, 42);

    const state = useReceiptQueueStore.getState();
    expect(state.items).toHaveLength(0);
    expect(state.recentIds).toEqual([42]);
    expect(state.lastCompletedAt).toBeGreaterThan(beforeTs);
  });
});

describe("pipeline — batch upload (multiple receipts)", () => {
  it("processes items sequentially, accumulating recentIds in completion order", () => {
    useReceiptQueueStore.getState().addItems([
      { uris: ["a"], name: "a.jpg" },
      { uris: ["b"], name: "b.jpg" },
      { uris: ["c"], name: "c.jpg" },
    ]);
    const ids = useReceiptQueueStore.getState().items.map((i) => i.id);

    // Runner picks pending in FIFO order, completes one at a time
    simulateSuccess(ids[0], 100);
    simulateSuccess(ids[1], 200);
    simulateSuccess(ids[2], 300);

    const state = useReceiptQueueStore.getState();
    expect(state.items).toHaveLength(0);
    expect(state.recentIds).toEqual([100, 200, 300]);
  });

  it("a mid-batch ProcessingError leaves the error card while siblings still complete", () => {
    useReceiptQueueStore.getState().addItems([
      { uris: ["a"] },
      { uris: ["b"], name: "blurry.jpg" },
      { uris: ["c"] },
    ]);
    const ids = useReceiptQueueStore.getState().items.map((i) => i.id);

    simulateSuccess(ids[0], 1);
    simulateFailure(
      ids[1],
      new ProcessingError("chain_unrecognized", "Parduotuvės tinklas neatpažintas"),
      true,
    );
    simulateSuccess(ids[2], 3);

    const state = useReceiptQueueStore.getState();
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      status: "error",
      error: "Parduotuvės tinklas neatpažintas",
      name: "blurry.jpg",
    });
    expect(state.recentIds).toEqual([1, 3]);
  });
});

describe("pipeline — offline pause + resume", () => {
  it("NetworkError → awaiting_network; resumeAwaitingNetwork → pending → done", () => {
    useReceiptQueueStore.getState().addItems([{ uris: ["a"] }]);
    const id = useReceiptQueueStore.getState().items[0].id;

    // Phase 1: network drops mid-pipeline
    simulateFailure(id, new NetworkError("Network request failed"), false);
    expect(useReceiptQueueStore.getState().items[0].status).toBe("awaiting_network");
    expect(useReceiptQueueStore.getState().recentIds).toEqual([]);

    // Phase 2: NetInfo flips back to online; runner resumes
    useReceiptQueueStore.getState().resumeAwaitingNetwork();
    expect(useReceiptQueueStore.getState().items[0].status).toBe("pending");

    // Phase 3: re-run from scratch succeeds
    simulateSuccess(id, 99);
    const state = useReceiptQueueStore.getState();
    expect(state.items).toHaveLength(0);
    expect(state.recentIds).toEqual([99]);
  });

  it("offline + ProcessingError → error (NOT awaiting_network)", () => {
    // Regression guard for the bug caught during the audit. If routing
    // checked online state first, an offline parser failure would be
    // marked awaiting_network and the user would never see the error.
    useReceiptQueueStore.getState().addItems([{ uris: ["a"] }]);
    const id = useReceiptQueueStore.getState().items[0].id;
    simulateFailure(
      id,
      new ProcessingError("ocr_no_text", "Nepavyko nuskaityti teksto"),
      false,
    );
    expect(useReceiptQueueStore.getState().items[0].status).toBe("error");
    expect(useReceiptQueueStore.getState().items[0].error).toBe("Nepavyko nuskaityti teksto");
  });
});

describe("pipeline — duplicate detection", () => {
  it("'Kvitas jau įkeltas' is marked as a duplicate by routing", () => {
    useReceiptQueueStore.getState().addItems([{ uris: ["a"] }]);
    const id = useReceiptQueueStore.getState().items[0].id;
    const routing = simulateFailure(
      id,
      new ProcessingError("post_failed", "Kvitas jau įkeltas"),
      true,
    );

    expect(routing).toEqual({
      kind: "error",
      message: "Kvitas jau įkeltas",
      isDuplicate: true,
    });
    // The store still records it as an error — auto-dismiss is the
    // runner's responsibility (setTimeout(removeItem, 4000)).
    expect(useReceiptQueueStore.getState().items[0].status).toBe("error");
  });
});

describe("pipeline — session persistence across app restart", () => {
  it("processing item is restored as pending; awaiting_network item stays", async () => {
    // Seed AsyncStorage as if an earlier session was interrupted.
    await AsyncStorage.setItem(
      "receipt_queue_v1",
      JSON.stringify([
        {
          id: "p1",
          uris: ["a"],
          name: "a.jpg",
          status: "processing",
          progress: "4/8",
          progressDone: 4,
          progressTotal: 8,
          addedAt: 1,
        },
        {
          id: "p2",
          uris: ["b"],
          status: "awaiting_network",
          addedAt: 2,
        },
        {
          id: "p3",
          uris: ["c"],
          status: "error",
          error: "Parduotuvė neatpažinta",
          addedAt: 3,
        },
      ]),
    );

    await useReceiptQueueStore.getState().initialize();
    const items = useReceiptQueueStore.getState().items;

    expect(items.find((i) => i.id === "p1")?.status).toBe("pending");
    expect(items.find((i) => i.id === "p2")?.status).toBe("awaiting_network");
    expect(items.find((i) => i.id === "p3")?.status).toBe("error");

    // Subsequent run completes p1 successfully
    simulateSuccess("p1", 500);
    const state = useReceiptQueueStore.getState();
    expect(state.recentIds).toEqual([500]);
    // p2 (awaiting_network) and p3 (error) remain — they're not part of
    // the same "session" the runner is sequentially walking through.
    expect(state.items.map((i) => i.id).sort()).toEqual(["p2", "p3"]);
  });
});

describe("pipeline — recentIds + pruneRecentIds + 'Nauji' lifecycle", () => {
  it("session of three receipts: recentIds populates, then prune clears it", () => {
    useReceiptQueueStore.getState().addItems([
      { uris: ["a"] },
      { uris: ["b"] },
      { uris: ["c"] },
    ]);
    const ids = useReceiptQueueStore.getState().items.map((i) => i.id);
    simulateSuccess(ids[0], 10);
    simulateSuccess(ids[1], 20);
    simulateSuccess(ids[2], 30);
    expect(useReceiptQueueStore.getState().recentIds).toEqual([10, 20, 30]);

    // User completes all mandatory swipes for the batch → receipts.tsx's
    // pruneRecentIds([]) clears the "Nauji" section.
    useReceiptQueueStore.getState().pruneRecentIds([]);
    expect(useReceiptQueueStore.getState().recentIds).toEqual([]);
  });

  it("partial completion preserves order; pruning a subset keeps order", () => {
    useReceiptQueueStore.setState({ recentIds: [10, 20, 30, 40, 50] });
    useReceiptQueueStore.getState().pruneRecentIds([20, 40, 99]); // 99 not present
    expect(useReceiptQueueStore.getState().recentIds).toEqual([20, 40]);
  });
});
