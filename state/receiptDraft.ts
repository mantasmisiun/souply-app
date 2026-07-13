import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Receipt-draft persistence for the Analize flow.
 *
 * Problem: if the user picks an image/PDF and the app is killed before
 * the Receipt row is POSTed (iOS swipes away, OOM, force-quit), the
 * image cache references are lost and the user has to re-pick the
 * same file. Saving a lightweight draft to AsyncStorage lets us
 * resume where they left off on next app launch.
 *
 * Draft contract:
 *   - imageUris: the paths the screen was going to OCR (comma list
 *     on multi-page PDFs, single path on photos). Phone-cache file://
 *     URIs which may or may not survive an OS cache purge — we check
 *     survival at resume time before prompting.
 *   - startedAt: wall-clock ms for staleness filtering. Drafts older
 *     than ~24h get discarded; the user probably moved on.
 *
 * Cleared on:
 *   - successful POST /api/receipts (Receipt row now lives server-side)
 *   - user declines the resume prompt
 *   - bail-to-Analize paths (OCR/chain/store/duplicate failures)
 */
const KEY = 'analize:draft';
const MAX_DRAFT_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Resume-prompt arm. The Analize tab may show its "resume this scan?" Alert
 * only while armed; claiming disarms it (one prompt per draft), and saving a
 * NEW draft re-arms it — so a scan started mid-session can still be resumed
 * after an interruption, while the prompt can never nag twice for one draft.
 */
let resumePromptArmed = true;

export const armResumePrompt = (): void => {
    resumePromptArmed = true;
};

/** One-shot claim: true exactly once per arm. */
export const claimResumePrompt = (): boolean => {
    if (!resumePromptArmed) return false;
    resumePromptArmed = false;
    return true;
};

/** Give a claim back (claimed but nothing to prompt for). */
export const unclaimResumePrompt = (): void => {
    resumePromptArmed = true;
};

export interface ReceiptDraft {
    imageUris: string[];
    startedAt: number;
}

export const saveReceiptDraft = async (imageUris: string[]): Promise<void> => {
    if (!Array.isArray(imageUris) || imageUris.length === 0) return;
    const draft: ReceiptDraft = {
        imageUris,
        startedAt: Date.now(),
    };
    armResumePrompt(); // a fresh draft may prompt again after an interruption
    try {
        await AsyncStorage.setItem(KEY, JSON.stringify(draft));
    } catch (e) {
        // AsyncStorage write failure is non-fatal — worst case the user
        // has to re-pick the image, same as before this feature existed.
        console.warn('[receiptDraft] save failed:', e);
    }
};

export const loadReceiptDraft = async (): Promise<ReceiptDraft | null> => {
    try {
        const raw = await AsyncStorage.getItem(KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as ReceiptDraft;
        if (
            !parsed ||
            !Array.isArray(parsed.imageUris) ||
            parsed.imageUris.length === 0 ||
            typeof parsed.startedAt !== 'number'
        ) {
            // Malformed — throw it away so we don't re-prompt indefinitely.
            await clearReceiptDraft();
            return null;
        }
        // Stale drafts (> MAX_DRAFT_AGE_MS) auto-expire. The user has
        // almost certainly moved past that receipt by now and a resume
        // prompt would feel stale/broken.
        if (Date.now() - parsed.startedAt > MAX_DRAFT_AGE_MS) {
            await clearReceiptDraft();
            return null;
        }
        return parsed;
    } catch (e) {
        console.warn('[receiptDraft] load failed:', e);
        return null;
    }
};

export const clearReceiptDraft = async (): Promise<void> => {
    try {
        await AsyncStorage.removeItem(KEY);
    } catch (e) {
        console.warn('[receiptDraft] clear failed:', e);
    }
};
