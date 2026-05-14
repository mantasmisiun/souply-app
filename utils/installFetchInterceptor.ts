import i18n from '../i18n';
import { API_BASE_URL } from '../config/api';

/**
 * One-shot patch of `globalThis.fetch` to inject `Accept-Language` on
 * every API call to our own backend.
 *
 * Why patch globally: most of the app calls `fetch()` directly rather
 * than going through `fetchWithTimeout`. Maintaining two paths to keep
 * locale-aware would mean auditing every call site. A single shim at
 * the bottom of the stack means every API call — wrapped or not — sees
 * the right header.
 *
 * Why only our API: third-party requests (CDN images, MinIO uploads,
 * Google geocoder) are sensitive to extraneous headers (CORS preflight
 * triggers, signature mismatches) and don't care about our locale
 * anyway.
 *
 * Idempotent: re-calls are no-ops because the patched function is
 * tagged. Safe to import from a screen that hot-reloads.
 */

const TAG = '__souplyFetchLocalePatched__';

export function installFetchInterceptor(): void {
    const g = globalThis as any;
    if (g.fetch?.[TAG]) return;
    const original = g.fetch.bind(globalThis);

    const patched = (input: RequestInfo | URL, init: RequestInit = {}) => {
        try {
            const urlStr = typeof input === 'string'
                ? input
                : input instanceof URL
                    ? input.toString()
                    : (input as Request).url;
            if (urlStr && urlStr.startsWith(API_BASE_URL)) {
                const headers = new Headers(init.headers ?? {});
                if (!headers.has('Accept-Language')) {
                    headers.set('Accept-Language', i18n.language || 'lt');
                }
                return original(input, { ...init, headers });
            }
        } catch {
            // Fall through to the unmodified call if anything goes
            // sideways — never let header-injection break a fetch.
        }
        return original(input, init);
    };

    (patched as any)[TAG] = true;
    g.fetch = patched;
}
