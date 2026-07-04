import AsyncStorage from "@react-native-async-storage/async-storage";
import { useReceiptQueueStore } from "../state/receiptQueueStore";

/**
 * The store reaches into AsyncStorage on every mutation. We swap in an
 * in-memory mock so tests stay isolated and so `persist` doesn't throw
 * inside jest-expo's default environment.
 */
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

// Helper: drop the test-only escape hatch onto a typed surface.
const asyncStorageMock = AsyncStorage as unknown as {
  __reset: () => void;
  setItem: jest.Mock;
};

function resetStore() {
  useReceiptQueueStore.setState({
    items: [],
    recentIds: [],
    lastCompletedAt: null,
    initialized: false,
  });
}

beforeEach(() => {
  resetStore();
  asyncStorageMock.__reset();
  asyncStorageMock.setItem.mockClear();
});

describe("receiptQueueStore — addItems", () => {
  it("appends pending items with stable shape", () => {
    useReceiptQueueStore.getState().addItems([
      { uris: ["file://a.jpg"], name: "a.jpg" },
      { uris: ["file://b.jpg", "file://b2.jpg"] }, // multi-page, no name
    ]);

    const items = useReceiptQueueStore.getState().items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      uris: ["file://a.jpg"],
      name: "a.jpg",
      status: "pending",
    });
    expect(items[0].id).toEqual(expect.any(String));
    expect(items[0].addedAt).toEqual(expect.any(Number));
    expect(items[1]).toMatchObject({
      uris: ["file://b.jpg", "file://b2.jpg"],
      status: "pending",
    });
    expect(items[1].name).toBeUndefined();
  });

  it("preserves order across multiple addItems calls", () => {
    const { addItems } = useReceiptQueueStore.getState();
    addItems([{ uris: ["a"] }]);
    addItems([{ uris: ["b"] }, { uris: ["c"] }]);
    const ids = useReceiptQueueStore.getState().items.map((i) => i.uris[0]);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("assigns unique ids", () => {
    useReceiptQueueStore
      .getState()
      .addItems([{ uris: ["a"] }, { uris: ["b"] }, { uris: ["c"] }]);
    const ids = useReceiptQueueStore.getState().items.map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("persists the new items to AsyncStorage", () => {
    useReceiptQueueStore.getState().addItems([{ uris: ["a"] }]);
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      "receipt_queue_v1",
      expect.stringContaining('"status":"pending"'),
    );
  });
});

describe("receiptQueueStore — markProcessing / updateProgress", () => {
  it("flips a pending item to processing and stamps the progress label", () => {
    useReceiptQueueStore.getState().addItems([{ uris: ["a"] }]);
    const id = useReceiptQueueStore.getState().items[0].id;

    useReceiptQueueStore.getState().markProcessing(id, "Nuskaitoma...");
    const item = useReceiptQueueStore.getState().items[0];
    expect(item.status).toBe("processing");
    expect(item.progress).toBe("Nuskaitoma...");
  });

  it("clears stale progress numbers when transitioning to processing", () => {
    useReceiptQueueStore.getState().addItems([{ uris: ["a"] }]);
    const id = useReceiptQueueStore.getState().items[0].id;
    useReceiptQueueStore.getState().markProcessing(id, "Nuskaitoma...");
    // Pretend a previous run had set partial progress
    useReceiptQueueStore.getState().updateProgress(id, "3/8 prekės", 3, 8);
    // Re-entering processing (e.g., after awaiting_network resume) should
    // reset the counts so the bar restarts from zero.
    useReceiptQueueStore.getState().markProcessing(id, "Nuskaitoma...");
    const item = useReceiptQueueStore.getState().items[0];
    expect(item.progressDone).toBeUndefined();
    expect(item.progressTotal).toBeUndefined();
  });

  it("updateProgress records done/total without changing status", () => {
    useReceiptQueueStore.getState().addItems([{ uris: ["a"] }]);
    const id = useReceiptQueueStore.getState().items[0].id;
    useReceiptQueueStore.getState().markProcessing(id, "Atpažįstama...");
    useReceiptQueueStore.getState().updateProgress(id, "3/8 prekės", 3, 8);
    const item = useReceiptQueueStore.getState().items[0];
    expect(item.status).toBe("processing");
    expect(item.progress).toBe("3/8 prekės");
    expect(item.progressDone).toBe(3);
    expect(item.progressTotal).toBe(8);
  });

  it("updateProgress does NOT persist to AsyncStorage (avoids disk thrash)", () => {
    useReceiptQueueStore.getState().addItems([{ uris: ["a"] }]);
    const id = useReceiptQueueStore.getState().items[0].id;
    useReceiptQueueStore.getState().markProcessing(id, "x"); // baseline persist
    asyncStorageMock.setItem.mockClear();
    useReceiptQueueStore.getState().updateProgress(id, "1/8", 1, 8);
    useReceiptQueueStore.getState().updateProgress(id, "2/8", 2, 8);
    useReceiptQueueStore.getState().updateProgress(id, "3/8", 3, 8);
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled();
  });
});

describe("receiptQueueStore — markAwaitingNetwork / resumeAwaitingNetwork", () => {
  it("marks an item as awaiting_network and clears its progress", () => {
    useReceiptQueueStore.getState().addItems([{ uris: ["a"] }]);
    const id = useReceiptQueueStore.getState().items[0].id;
    useReceiptQueueStore.getState().markProcessing(id, "Nuskaitoma...");
    useReceiptQueueStore.getState().updateProgress(id, "3/8", 3, 8);

    useReceiptQueueStore.getState().markAwaitingNetwork(id);
    const item = useReceiptQueueStore.getState().items[0];
    expect(item.status).toBe("awaiting_network");
    expect(item.progress).toBeUndefined();
    expect(item.progressDone).toBeUndefined();
    expect(item.progressTotal).toBeUndefined();
  });

  it("resumeAwaitingNetwork flips every awaiting item back to pending", () => {
    useReceiptQueueStore.getState().addItems([
      { uris: ["a"] },
      { uris: ["b"] },
      { uris: ["c"] },
    ]);
    const ids = useReceiptQueueStore.getState().items.map((i) => i.id);
    useReceiptQueueStore.getState().markAwaitingNetwork(ids[0]);
    useReceiptQueueStore.getState().markAwaitingNetwork(ids[2]);

    useReceiptQueueStore.getState().resumeAwaitingNetwork();
    const items = useReceiptQueueStore.getState().items;
    expect(items.map((i) => i.status)).toEqual(["pending", "pending", "pending"]);
  });

  it("resumeAwaitingNetwork is a no-op when there's nothing to resume", () => {
    useReceiptQueueStore.getState().addItems([{ uris: ["a"] }]);
    asyncStorageMock.setItem.mockClear();
    useReceiptQueueStore.getState().resumeAwaitingNetwork();
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled();
  });

  it("resumeAwaitingNetwork leaves error items untouched", () => {
    useReceiptQueueStore.getState().addItems([
      { uris: ["a"] },
      { uris: ["b"] },
    ]);
    const ids = useReceiptQueueStore.getState().items.map((i) => i.id);
    useReceiptQueueStore.getState().markError(ids[0], "Nepavyko");
    useReceiptQueueStore.getState().markAwaitingNetwork(ids[1]);

    useReceiptQueueStore.getState().resumeAwaitingNetwork();
    const items = useReceiptQueueStore.getState().items;
    expect(items[0].status).toBe("error");
    expect(items[1].status).toBe("pending");
  });
});

describe("receiptQueueStore — markDone / recentIds", () => {
  it("removes the item and appends receiptId to recentIds", () => {
    useReceiptQueueStore.getState().addItems([{ uris: ["a"] }]);
    const id = useReceiptQueueStore.getState().items[0].id;
    useReceiptQueueStore.getState().markDone(id, 42);

    const state = useReceiptQueueStore.getState();
    expect(state.items).toHaveLength(0);
    expect(state.recentIds).toEqual([42]);
    expect(state.lastCompletedAt).toEqual(expect.any(Number));
  });

  it("dedupes recentIds when the same id finishes twice", () => {
    useReceiptQueueStore.getState().addItems([{ uris: ["a"] }, { uris: ["b"] }]);
    const [id1, id2] = useReceiptQueueStore.getState().items.map((i) => i.id);
    useReceiptQueueStore.getState().markDone(id1, 42);
    useReceiptQueueStore.getState().markDone(id2, 42); // same server id (shouldn't happen, but defensive)
    expect(useReceiptQueueStore.getState().recentIds).toEqual([42]);
  });

  it("preserves insertion order in recentIds", () => {
    useReceiptQueueStore
      .getState()
      .addItems([{ uris: ["a"] }, { uris: ["b"] }, { uris: ["c"] }]);
    const [i1, i2, i3] = useReceiptQueueStore.getState().items.map((i) => i.id);
    useReceiptQueueStore.getState().markDone(i2, 200);
    useReceiptQueueStore.getState().markDone(i1, 100);
    useReceiptQueueStore.getState().markDone(i3, 300);
    expect(useReceiptQueueStore.getState().recentIds).toEqual([200, 100, 300]);
  });
});

describe("receiptQueueStore — noteReceiptCreated (fresh-scan parity)", () => {
  // A camera scan is created by receipt-process directly, bypassing the batch runner
  // (the only caller of markDone). Without this signal the Analyze list wouldn't refetch
  // until the tab regains focus and the receipt would never appear in "Nauji".
  it("bumps lastCompletedAt and registers the id in recentIds", () => {
    expect(useReceiptQueueStore.getState().lastCompletedAt).toBeNull();
    useReceiptQueueStore.getState().noteReceiptCreated(221);

    const state = useReceiptQueueStore.getState();
    expect(state.recentIds).toEqual([221]);
    expect(state.lastCompletedAt).toEqual(expect.any(Number));
  });

  it("does NOT touch the processing items list", () => {
    useReceiptQueueStore.getState().addItems([{ uris: ["a"] }]);
    const before = useReceiptQueueStore.getState().items;
    useReceiptQueueStore.getState().noteReceiptCreated(99);
    // Same array reference — the scan notify only writes session state, so an in-flight
    // batch item mid-processing is never disturbed.
    expect(useReceiptQueueStore.getState().items).toBe(before);
  });

  it("dedupes when the same receipt is noted twice", () => {
    useReceiptQueueStore.getState().noteReceiptCreated(42);
    useReceiptQueueStore.getState().noteReceiptCreated(42);
    expect(useReceiptQueueStore.getState().recentIds).toEqual([42]);
  });

  it("does not persist to AsyncStorage (items are unchanged)", () => {
    asyncStorageMock.setItem.mockClear();
    useReceiptQueueStore.getState().noteReceiptCreated(7);
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled();
  });
});

describe("receiptQueueStore — markError", () => {
  it("transitions to error with a message and clears progress", () => {
    useReceiptQueueStore.getState().addItems([{ uris: ["a"] }]);
    const id = useReceiptQueueStore.getState().items[0].id;
    useReceiptQueueStore.getState().markProcessing(id, "Nuskaitoma...");
    useReceiptQueueStore.getState().updateProgress(id, "3/8", 3, 8);

    useReceiptQueueStore.getState().markError(id, "Parduotuvė neatpažinta");

    const item = useReceiptQueueStore.getState().items[0];
    expect(item.status).toBe("error");
    expect(item.error).toBe("Parduotuvė neatpažinta");
    expect(item.progress).toBeUndefined();
    expect(item.progressDone).toBeUndefined();
  });
});

describe("receiptQueueStore — removeItem", () => {
  it("removes only the targeted item", () => {
    useReceiptQueueStore
      .getState()
      .addItems([{ uris: ["a"] }, { uris: ["b"] }, { uris: ["c"] }]);
    const ids = useReceiptQueueStore.getState().items.map((i) => i.id);
    useReceiptQueueStore.getState().removeItem(ids[1]);

    const remaining = useReceiptQueueStore.getState().items;
    expect(remaining).toHaveLength(2);
    expect(remaining.map((i) => i.uris[0])).toEqual(["a", "c"]);
  });
});

describe("receiptQueueStore — pruneRecentIds", () => {
  beforeEach(() => {
    useReceiptQueueStore.setState({ recentIds: [10, 20, 30, 40] });
  });

  it("keeps only the listed ids, preserving order", () => {
    useReceiptQueueStore.getState().pruneRecentIds([30, 10]);
    expect(useReceiptQueueStore.getState().recentIds).toEqual([10, 30]);
  });

  it("pruneRecentIds([]) clears everything", () => {
    useReceiptQueueStore.getState().pruneRecentIds([]);
    expect(useReceiptQueueStore.getState().recentIds).toEqual([]);
  });

  it("is a no-op when the filter matches the current set", () => {
    useReceiptQueueStore.getState().pruneRecentIds([10, 20, 30, 40]);
    // Reference equality on no-op is an implementation guarantee that
    // protects downstream useEffect deps from spurious re-fires.
    expect(useReceiptQueueStore.getState().recentIds).toEqual([10, 20, 30, 40]);
  });
});

describe("receiptQueueStore — initialize", () => {
  it("loads persisted items and resets processing → pending", async () => {
    // Seed AsyncStorage as if a previous session had two items, one of
    // which was mid-processing when the app was killed.
    await AsyncStorage.setItem(
      "receipt_queue_v1",
      JSON.stringify([
        {
          id: "x1",
          uris: ["a"],
          status: "processing",
          progress: "3/8",
          progressDone: 3,
          progressTotal: 8,
          addedAt: 1,
        },
        {
          id: "x2",
          uris: ["b"],
          status: "awaiting_network",
          addedAt: 2,
        },
      ]),
    );

    await useReceiptQueueStore.getState().initialize();

    const state = useReceiptQueueStore.getState();
    expect(state.initialized).toBe(true);
    expect(state.items).toHaveLength(2);

    const processingItem = state.items.find((i) => i.id === "x1");
    expect(processingItem?.status).toBe("pending");
    expect(processingItem?.progress).toBeUndefined();
    expect(processingItem?.progressDone).toBeUndefined();

    // awaiting_network is NOT reset to pending — the network resumer
    // owns that transition. Reset here would cause the runner to spin
    // on offline retries instead of waiting for connectivity.
    const awaitingItem = state.items.find((i) => i.id === "x2");
    expect(awaitingItem?.status).toBe("awaiting_network");
  });

  it("is idempotent (second call is a no-op)", async () => {
    await useReceiptQueueStore.getState().initialize();
    const state1 = useReceiptQueueStore.getState();
    await useReceiptQueueStore.getState().initialize();
    const state2 = useReceiptQueueStore.getState();
    expect(state2).toBe(state1); // same reference proves the no-op
  });

  it("survives malformed AsyncStorage data without crashing", async () => {
    // The store warns on parse failure — silence it so the test output
    // stays clean while still asserting the recovery behaviour.
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    await AsyncStorage.setItem("receipt_queue_v1", "{ not json ]");
    await useReceiptQueueStore.getState().initialize();
    expect(useReceiptQueueStore.getState().initialized).toBe(true);
    expect(useReceiptQueueStore.getState().items).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
