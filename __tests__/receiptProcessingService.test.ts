// The service transitively imports AsyncStorage (via config/user) and a
// pile of native-only modules. We're only exercising pure helpers here,
// so we stub the native surface to keep jest from blowing up on import.
import {
  isNetworkLikeError,
  NetworkError,
  ProcessingError,
} from "../services/receiptProcessingService";

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    setItem: jest.fn().mockResolvedValue(undefined),
    getItem: jest.fn().mockResolvedValue(null),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("@react-native-ml-kit/text-recognition", () => ({
  __esModule: true,
  default: { recognize: jest.fn() },
}));
jest.mock("expo-image-manipulator", () => ({
  manipulateAsync: jest.fn(),
  SaveFormat: { JPEG: "jpeg" },
}));
jest.mock("expo-crypto", () => ({
  randomUUID: () => "test-uuid",
}));

describe("ProcessingError", () => {
  it("preserves the reason on the instance", () => {
    const err = new ProcessingError("ocr_no_text", "Nepavyko nuskaityti");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProcessingError);
    expect(err.reason).toBe("ocr_no_text");
    expect(err.message).toBe("Nepavyko nuskaityti");
    expect(err.name).toBe("ProcessingError");
  });

  it("supports all the documented reason codes", () => {
    const reasons = [
      "ocr_no_text",
      "ocr_error",
      "chain_unrecognized",
      "store_unrecognized",
      "post_failed",
    ] as const;
    for (const r of reasons) {
      const e = new ProcessingError(r, "msg");
      expect(e.reason).toBe(r);
    }
  });
});

describe("NetworkError", () => {
  it("identifies as a NetworkError instance with name=NetworkError", () => {
    const err = new NetworkError("Network request failed");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.name).toBe("NetworkError");
    expect(err.message).toBe("Network request failed");
  });

  it("is distinguishable from ProcessingError", () => {
    const net = new NetworkError("x");
    const proc = new ProcessingError("ocr_error", "x");
    expect(net instanceof ProcessingError).toBe(false);
    expect(proc instanceof NetworkError).toBe(false);
  });
});

describe("isNetworkLikeError", () => {
  it.each([
    ["Network request failed", true],
    ["Failed to fetch", true],
    ["timeout exceeded", true],
    ["request timeout after 5000ms", true],
    ["ECONNREFUSED 127.0.0.1:443", true],
    ["ECONNRESET", true],
  ])("treats %p as a network-like error", (msg, expected) => {
    expect(isNetworkLikeError(new Error(msg))).toBe(expected);
  });

  it.each([
    ["Parduotuvė neatpažinta"],
    ["HTTP 500"],
    ["Kvitas jau įkeltas"],
    ["Unexpected JSON token at position 0"],
  ])("treats %p as NOT a network-like error", (msg) => {
    expect(isNetworkLikeError(new Error(msg))).toBe(false);
  });

  it("treats AbortError by name, regardless of message", () => {
    const err = new Error("aborted by user — message unrelated");
    err.name = "AbortError";
    expect(isNetworkLikeError(err)).toBe(true);
  });

  it("ignores non-Error values", () => {
    expect(isNetworkLikeError(null)).toBe(false);
    expect(isNetworkLikeError(undefined)).toBe(false);
    expect(isNetworkLikeError("Network request failed")).toBe(false); // plain string
    expect(isNetworkLikeError({ message: "Network request failed" })).toBe(false);
    expect(isNetworkLikeError(42)).toBe(false);
  });
});
