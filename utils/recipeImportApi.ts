import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';

/**
 * Recipe import — POST /api/recipes/import.
 *
 * PREVIEW ONLY: the server reads a public recipe page and proposes a title, a
 * cover emoji and a product list. Nothing is written until the shopper confirms
 * and the app creates the template through the existing
 * `POST /api/basket-templates` with `items[]`.
 */

export interface RecipeImportItem {
    /** Position in the published ingredient list — the app's stable row key. */
    index: number;
    /** The published line, so the shopper can see what the recipe actually said. */
    raw: string;
    /** Ingredient as the recipe means it ("kvietiniai miltai"). */
    name: string;
    /** What the RECIPE asks for, converted: "≈21 g", "150 ml", "2 vnt.". */
    amountText: string | null;
    /** Probably in the cupboard already (salt, pepper, oil) — grouped apart. */
    pantry: boolean;

    productId: number | null;
    productName: string | null;
    imageUrl: string | null;
    isWeighable: boolean;
    /** How much to BUY, in the product's own unit. */
    quantity: number;
    unit: 'kg' | 'vnt';
    confidence: number;
    /** Matched, but not confidently — ask before trusting it. */
    needsReview: boolean;
    alternatives: { productId: number; name: string; imageUrl: string | null; confidence: number }[];
}

export interface RecipeImportPreview {
    title: string;
    sourceUrl: string;
    site: string;
    imageUrl: string | null;
    servings: number | null;
    lang: 'lt' | 'en';
    /** Which rung of the server's extraction ladder answered — diagnostics only. */
    extractor: string;
    /** Prefill for the cover sheet. */
    suggestedEmoji: string;
    items: RecipeImportItem[];
    /** Lines that produced no product — shown so nothing vanishes silently. */
    skipped: { raw: string; name: string; amountText: string | null; reason: 'unmatched' | 'not_an_ingredient' }[];
    counts: { matched: number; needsReview: number; pantry: number; skipped: number };
}

/** Failure the UI has to phrase. One code → one human sentence. */
export type RecipeImportErrorCode =
    | 'bad_url'        // 400 — not a URL we can even try
    | 'blocked_host'   // 400 — private/loopback address, refused outright
    | 'no_recipe'      // 422 — page fetched, no ingredient list in it
    | 'rate_limited'   // 429 — the caller is hammering the endpoint
    | 'fetch_failed'   // 502 / offline — the page couldn't be read at all
    | 'unknown';

export type RecipeImportResult =
    | { ok: true; preview: RecipeImportPreview }
    | { ok: false; code: RecipeImportErrorCode };

/** `retryFromDevice` mirrors the server's `fetchBlocked` — internal, never shown. */
type PostResult =
    | { ok: true; preview: RecipeImportPreview }
    | { ok: false; code: RecipeImportErrorCode; retryFromDevice?: boolean };

/** A page bigger than this isn't an article — and the server caps at 3 MB. */
const MAX_HTML_BYTES = 2.5 * 1024 * 1024;
/** The device fetch is a courtesy retry, not a hang: give up and report. */
const DEVICE_FETCH_TIMEOUT_MS = 15000;

/**
 * fetch tagged with the caller's device userId (X-User-Id) — same helper shape
 * as basketTemplatesApi's `tfetch`. The route is behind `requireUser`; the
 * global fetch interceptor adds the session Bearer, and X-User-Id covers the
 * non-prod dev-auth shim.
 */
async function tfetch(input: string, init: RequestInit = {}): Promise<Response> {
    const uid = await getUserId();
    const headers = new Headers(init.headers);
    headers.set('X-User-Id', uid);
    headers.set('Content-Type', 'application/json');
    return fetch(input, { ...init, headers });
}

async function post(body: { url: string; html?: string }): Promise<PostResult> {
    let res: Response;
    try {
        res = await tfetch(`${API_BASE_URL}/api/recipes/import`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    } catch {
        return { ok: false, code: 'fetch_failed' };
    }

    if (res.ok) {
        try {
            return { ok: true, preview: await res.json() as RecipeImportPreview };
        } catch {
            return { ok: false, code: 'unknown' };
        }
    }

    let payload: { error?: string; fetchBlocked?: boolean } = {};
    try { payload = await res.json(); } catch {}

    if (res.status === 429) return { ok: false, code: 'rate_limited' };
    if (res.status === 422) return { ok: false, code: 'no_recipe' };
    if (res.status === 400) {
        return { ok: false, code: payload.error === 'blocked_host' ? 'blocked_host' : 'bad_url' };
    }
    // 502 + fetchBlocked is the one failure we can still recover from.
    if (payload.fetchBlocked) return { ok: false, code: 'fetch_failed', retryFromDevice: true };
    if (res.status === 502) return { ok: false, code: 'fetch_failed' };
    return { ok: false, code: 'unknown' };
}

/**
 * Fetch the page from the DEVICE — the last resort, not the first.
 *
 * A handful of large publishers (allrecipes.com and the rest of the Dotdash
 * Meredith network) refuse the server with a 402/403 challenge. This was
 * originally attributed to the server's datacentre IP; that was measured and is
 * WRONG — the same refusal arrives from a residential connection, and what the
 * publisher is actually fingerprinting is the HTTP client's TLS handshake. The
 * server now retries those in a real Chromium and usually wins, so this path
 * fires far more rarely than it used to.
 *
 * It still earns its place: the phone is a different client on a different
 * network, so it can succeed where both server attempts failed. The parsing
 * stays in ONE place — the device only lends its network stack.
 */
async function fetchPageOnDevice(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEVICE_FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: {
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'lt-LT,lt;q=0.9,en;q=0.8',
                // Without this the platform sends its own (OkHttp on Android),
                // which is exactly the kind of tell that got the server refused.
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    + ' (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            },
            signal: controller.signal,
        });
        if (!res.ok) return null;
        // Refuse an oversized body before reading it where the header tells us.
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared > MAX_HTML_BYTES) return null;
        const html = await res.text();
        // Belt-and-braces for chunked responses with no content-length. Truncating
        // costs little: the metadata the extractor wants (JSON-LD, microdata) sits
        // in the head, and the alternative is a request the server will reject.
        return html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Import a recipe page into a preview, retrying from the device when the
 *  server's own fetch was refused by the publisher. */
export async function importRecipe(url: string): Promise<RecipeImportResult> {
    const first = await post({ url });
    if (first.ok || !first.retryFromDevice) return first;

    const html = await fetchPageOnDevice(url);
    if (html == null) return { ok: false, code: 'fetch_failed' };
    const second = await post({ url, html });
    // The server never fetches when html is supplied, so a second block can't
    // happen — drop the flag and report whatever the parse produced.
    return second.ok ? second : { ok: false, code: second.code };
}
