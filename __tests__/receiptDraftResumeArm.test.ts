/**
 * Resume-prompt arm semantics (state/receiptDraft.ts). The old module flag in
 * the Analyze tab was claimed once at app launch — before any draft existed —
 * so a scan started mid-session could NEVER be resumed. The arm must be:
 * one-shot per claim, re-armed by every saveReceiptDraft, and returnable
 * (unclaim) when a claim found no draft to prompt for.
 */
import {
  armResumePrompt,
  claimResumePrompt,
  saveReceiptDraft,
  unclaimResumePrompt,
} from "../state/receiptDraft";

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: { setItem: jest.fn(async () => {}), getItem: jest.fn(async () => null), removeItem: jest.fn(async () => {}) },
}));

describe("resume-prompt arm", () => {
  beforeEach(() => armResumePrompt());

  it("claims exactly once per arm", () => {
    expect(claimResumePrompt()).toBe(true);
    expect(claimResumePrompt()).toBe(false);
    expect(claimResumePrompt()).toBe(false);
  });

  it("unclaim gives the single claim back", () => {
    expect(claimResumePrompt()).toBe(true);
    unclaimResumePrompt();
    expect(claimResumePrompt()).toBe(true);
    expect(claimResumePrompt()).toBe(false);
  });

  it("saving a NEW draft re-arms a spent claim", async () => {
    expect(claimResumePrompt()).toBe(true);
    expect(claimResumePrompt()).toBe(false);
    await saveReceiptDraft(["file:///scan.jpg"]);
    expect(claimResumePrompt()).toBe(true);
  });

  it("an empty save (no uris) does not re-arm", async () => {
    expect(claimResumePrompt()).toBe(true);
    await saveReceiptDraft([]);
    expect(claimResumePrompt()).toBe(false);
  });
});
