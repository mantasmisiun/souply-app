// PendingSwipesBanner transitively imports the theme → settings store →
// native AsyncStorage. Mock it before the import so the suite can load in
// the node test environment (mirrors locationIntelligence.test.ts).
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
  multiGet: jest.fn(() => Promise.resolve([])),
  multiSet: jest.fn(() => Promise.resolve()),
  mergeItem: jest.fn(() => Promise.resolve()),
  clear: jest.fn(() => Promise.resolve()),
  getAllKeys: jest.fn(() => Promise.resolve([])),
}));

import { pluralProduct } from "../components/PendingSwipesBanner";

/**
 * Lithuanian agreement is non-trivial — and the banner is one of the
 * first user-facing strings after upload, so getting it wrong is highly
 * visible. Locking the rules in tests so we don't regress.
 */
describe("pluralProduct (Lithuanian agreement)", () => {
  it("zero → genitive plural (prekių)", () => {
    expect(pluralProduct(0)).toBe("prekių");
  });

  it("one → nominative singular (prekė)", () => {
    expect(pluralProduct(1)).toBe("prekė");
  });

  it.each([2, 3, 4, 5, 6, 7, 8, 9])(
    "%i → nominative plural (prekės)",
    (n) => {
      expect(pluralProduct(n)).toBe("prekės");
    },
  );

  it.each([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])(
    "%i → genitive plural (prekių)",
    (n) => {
      expect(pluralProduct(n)).toBe("prekių");
    },
  );

  it("20 → genitive plural (prekių)", () => {
    expect(pluralProduct(20)).toBe("prekių");
  });

  it("21 → nominative singular (prekė)", () => {
    expect(pluralProduct(21)).toBe("prekė");
  });

  it.each([22, 23, 24, 25, 28, 29])(
    "%i → nominative plural (prekės)",
    (n) => {
      expect(pluralProduct(n)).toBe("prekės");
    },
  );

  it("30 → genitive plural (prekių)", () => {
    expect(pluralProduct(30)).toBe("prekių");
  });

  it("111 → genitive plural (teens rule applies to mod-100 too)", () => {
    expect(pluralProduct(111)).toBe("prekių");
  });

  it("119 → genitive plural", () => {
    expect(pluralProduct(119)).toBe("prekių");
  });

  it("121 → nominative singular", () => {
    expect(pluralProduct(121)).toBe("prekė");
  });

  it("100 → genitive plural", () => {
    expect(pluralProduct(100)).toBe("prekių");
  });
});
