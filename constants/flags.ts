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
 * WHOLE-SECTION PRODUCT re-OCR (IKI, Android only). When a parsed product is a suspect
 * (dropped name "?", no/garbled price, amount-in-name, collapsed band) OR the receipt
 * doesn't reconcile beyond ~€1, crop+upscale+re-OCR the ENTIRE product section in one
 * fresh isolated pass, splice the recovered lines back, re-run the whole parse, and keep
 * it only if it STRICTLY improves (fewer garbage, smaller |Σ−total|, footer total
 * unchanged) — see utils/productReocr.ts + project_roadmap_product_reocr.
 *
 * ENABLED for dogfooding. It adds ~1-3s per *degraded* IKI receipt on Android (zero cost
 * on clean receipts — the gate fires nothing), and is fail-safe: any error / non-improving
 * candidate keeps the original parse. Watch logcat `productReocr.outcome` to see accept/
 * reject + the garbage/gap deltas. Set false to disable (e.g. before a perf-sensitive prod
 * release) once validated.
 */
export const PRODUCT_REOCR_ENABLED = true;
