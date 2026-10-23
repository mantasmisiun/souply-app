import i18n from '../i18n';
import { API_BASE_URL } from '../config/api';
import { getActiveSessionToken } from '../config/session';
import { reclaimAnonSessionToken } from '../config/user';
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

/**
 * Single-flight anon-token reclaim.
 *
 * A tab switch fires several per-user calls at once (basket, profile, trips).
 * Without this they would each POST /users and the last writer would win,
 * leaving the others holding a token that was already replaced.
 */
let reclaimInFlight: Promise<boolean> | null = null;
function reclaimOnce(): Promise<boolean> {
    if (!reclaimInFlight) {
        reclaimInFlight = reclaimAnonSessionToken().finally(() => {
            reclaimInFlight = null;
        });
    }
    return reclaimInFlight;
}

/** Version-gate signals. Never allowed to break the request it inspects. */
function inspectVersionGate(res: Response): void {
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
}

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
                const callerOwnsAuth = headers.has('authorization') || headers.has('Authorization');
                if (!callerOwnsAuth) {
                    const token = getActiveSessionToken();
                    if (token) headers.set('Authorization', `Bearer ${token}`);
                }
                // Client version signal for the server-side gate (X-Client-*). The server
                // 426s a build below the hard floor or flags a soft nudge via header.
                if (CLIENT_VERSION && !headers.has('X-Client-Version')) {
                    headers.set('X-Client-Platform', CLIENT_PLATFORM);
                    headers.set('X-Client-Version', CLIENT_VERSION);
                }
                // A 401 here means the session token we injected is stale — it predates the
                // auth hardening, expired, or was invalidated by a server secret rotation.
                // Reclaim once and replay. Before this existed only profileStore recovered,
                // so a stale token left the basket permanently dead in production while the
                // rest of the app looked fine (2026-08-28).
                //
                // Retry only when ALL of these hold, so the replay is safe:
                //   - we own the Authorization header (a caller-set one is theirs to manage)
                //   - the request is replayable: a string/URL input with no body, or a
                //     string body. A Request object or a stream cannot be sent twice.
                // reclaimAnonSessionToken() itself returns false for verified users, so a
                // signed-in user whose OAuth session died is never silently downgraded to a
                // fresh anonymous identity.
                const replayable =
                    !callerOwnsAuth &&
                    (typeof input === 'string' || input instanceof URL) &&
                    (init.body === undefined || init.body === null || typeof init.body === 'string');

                return original(input, { ...init, headers }).then(async (res: Response) => {
                    inspectVersionGate(res);
                    if (res.status !== 401 || !replayable) return res;
                    if (!(await reclaimOnce())) return res;
                    const fresh = getActiveSessionToken();
                    if (!fresh) return res;
                    const retryHeaders = new Headers(headers);
                    retryHeaders.set('Authorization', `Bearer ${fresh}`);
                    const retried = await original(input, { ...init, headers: retryHeaders });
                    inspectVersionGate(retried);
                    return retried;
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
