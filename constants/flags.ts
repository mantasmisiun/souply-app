/**
 * Development-only UI toggles.
 *
 * Flip `DEV_MODE` to true to reveal debug surfaces (raw OCR region previews,
 * internal identifiers, etc). Keep false for end-user builds so these
 * internals stay hidden.
 */
export const DEV_MODE = false;

/**
 * When true, `getUserId()` skips the fixed `DEV_USER_ID` pin and generates
 * a real per-install UUID — same code path as production. Use this to
 * exercise the account-recovery flow on dev builds: install with this
 * flag on, upload a couple of receipts, then reinstall (or call
 * `resetUserId()`) and try the recover screen. Flip back to false for
 * routine dev work so the fixed UUID makes test data easy to find and wipe.
 */
export const DEV_RANDOM_USER_UUID = true;
