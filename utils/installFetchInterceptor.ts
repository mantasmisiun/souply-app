import i18n from '../i18n';
import { API_BASE_URL } from '../config/api';
import { getActiveSessionToken } from '../config/session';
import { CLIENT_PLATFORM, CLIENT_VERSION, useVersionGate } from '../state/versionGate';

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
                // Session bearer for the now-authenticated per-user routes (receipts,
                // swipe votes). Verified token wins, else the anonymous token. Never
                // overwrite an Authorization the caller set explicitly (e.g. authedFetch).
                if (!headers.has('authorization') && !headers.has('Authorization')) {
                    const token = getActiveSessionToken();
                    if (token) headers.set('Authorization', `Bearer ${token}`);
                }
                // Client version signal for the server-side gate (X-Client-*). The server
                // 426s a build below the hard floor or flags a soft nudge via header.
                if (CLIENT_VERSION && !headers.has('X-Client-Version')) {
                    headers.set('X-Client-Platform', CLIENT_PLATFORM);
                    headers.set('X-Client-Version', CLIENT_VERSION);
                }
                // Inspect the response for the gate signals WITHOUT consuming the body the
                // caller will read (clone for the 426 body). Fail-safe: any error here is
                // swallowed so gate-detection can never break a real request.
                return original(input, { ...init, headers }).then((res: Response) => {
                    try {
                        if (res.status === 426) {
                            res.clone().json().then((b: any) => {
                                useVersionGate.getState().triggerHard(b?.storeUrl ?? null, b?.message ?? null);
                            }).catch(() => {
                                useVersionGate.getState().triggerHard(null, null);
                            });
                        } else if (res.headers.get('X-Client-Update') === 'recommended') {
                            useVersionGate.getState().triggerSoft(res.headers.get('X-Client-Store-Url'), null);
                        }
                    } catch { /* never break the request over gate detection */ }
                    return res;
                });
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
