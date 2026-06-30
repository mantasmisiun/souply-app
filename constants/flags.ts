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
 *
 * Default false: every dev install pins the `00000000-…` user so test data
 * is always under one known id (turn on ONLY to test account-recovery — the
 * 000 pin makes getUserId ignore setUserId, so recovery can't adopt the
 * recovered id; flip true for that test, then back to false).
 */
export const DEV_RANDOM_USER_UUID = false;

/**
 * When true, the receipt Items tab drives each row's display off the server's
 * per-line confidence band (`itemConfidence.band`) instead of the legacy
 * `matchConfirmed` state: S1 ⇒ show SP canonical name + image, S2 ⇒ show OCR
 * name with a "patikrinti" review badge + SP preview, S3 ⇒ raw OCR only.
 *
 * Default false: the band scoring ships as a tunable default and must be
 * CALIBRATED against real receipts before it gates what users see. While false,
 * the display is unchanged and the band is visible only via the dev badge
 * (gated by `__DEV__`) + the server MATCH SUMMARY log. Flip true to dogfood the
 * band-driven switch once the thresholds in `recognitionConfig.ts` are tuned.
 */
export const CONFIDENCE_BAND_DISPLAY = false;

/**
 * Phase 1 PRODUCT-region re-OCR (IKI, Android only). When a parsed product comes
 * back with a dropped name ("?"), crop+upscale+re-OCR its image strip in isolation,
 * splice the recovered boxes back into the line stream, re-run the whole parse, and
 * keep it only if it strictly improves (fewer garbage, reconciliation no worse,
 * footer total unchanged) — see utils/productReocr.ts + project_roadmap_product_reocr.
 *
 * Default false: the splice+gate core is unit-tested, but the on-device pixel re-OCR
 * needs golden-set validation (real MLKit data isn't in jest). Flip true to dogfood;
 * it adds ~1-2s per degraded receipt (Android), zero cost on clean receipts (gate
 * fires nothing), and is fail-safe (any error/reject keeps the original parse).
 */
export const PRODUCT_REOCR_ENABLED = false;
