/**
 * Centralised fetch wrapper with per-call timeouts and a one-shot
 * extended timeout for the very first request of the app session.
 *
 * Why timeouts: native fetch on React Native has no default deadline.
 * A dropped Wi-Fi mid-request can leave `Promise.all` hanging for
 * minutes while the user stares at a spinner. For the Analize flow
 * that's 30 parallel product-match requests all frozen simultaneously
 * if one radio packet gets lost during handoff.
 *
 * Why a longer FIRST timeout: when the server container cold-starts
 * after idle (common on a home OMV box that sleeps), the first HTTP
 * request takes 15-30s to return. We'd rather eat that one long wait
 * than erroneously mark every first use as "broken". All subsequent
 * calls in the session use the tight per-call timeout.
 *
 * `AbortController` is the actual mechanism — we spawn one per call
 * and `.abort()` it on the timeout. Callers that want to cancel for
 * their own reasons (component unmount, user back-press) can supply
 * an `externalSignal` and we'll link both.
 */

// Tuned defaults by endpoint type. Can be overridden per call via the
// `timeoutMs` option on the fetchWithTimeout call sites.
export const TIMEOUT_FAST_MS = 10_000;   // per-product match calls
export const TIMEOUT_STANDARD_MS = 15_000; // store lookup, comparison, everything else
export const TIMEOUT_HEAVY_MS = 30_000;  // POST receipt, image PUT to MinIO
export const TIMEOUT_COLD_START_MS = 30_000; // applied to the first call of the session

let firstCallDone = false;

export interface FetchWithTimeoutOptions extends RequestInit {
    /** Override the default timeout for this call. Defaults vary by
     *  endpoint type — see the constants above. */
    timeoutMs?: number;
    /** Caller-owned AbortSignal (e.g., component-unmount). If set,
     *  aborts from EITHER source (timeout OR external) will cancel. */
    externalSignal?: AbortSignal;
}

export class FetchTimeoutError extends Error {
    constructor(url: string, timeoutMs: number) {
        super(`Request timed out after ${timeoutMs}ms: ${url}`);
        this.name = 'FetchTimeoutError';
    }
}

/**
 * Fetch with enforced timeout. Throws `FetchTimeoutError` on timeout,
 * re-throws caller's AbortError if `externalSignal` fires first, and
 * forwards the underlying network error otherwise.
 */
export async function fetchWithTimeout(
    input: RequestInfo | URL,
    init: FetchWithTimeoutOptions = {},
): Promise<Response> {
    const { timeoutMs, externalSignal, ...rest } = init;

    // First-call pad: stretch the timeout once so a cold-starting
    // server doesn't get nuked by a 10s deadline on its first HTTP
    // response. The marker flips on the FIRST successful OR failed
    // return of this function, so subsequent calls use normal
    // timeouts even if the first one failed.
    const effectiveTimeoutMs = firstCallDone
        ? (timeoutMs ?? TIMEOUT_STANDARD_MS)
        : Math.max(timeoutMs ?? TIMEOUT_STANDARD_MS, TIMEOUT_COLD_START_MS);

    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(new FetchTimeoutError(String(input), effectiveTimeoutMs)),
        effectiveTimeoutMs,
    );
    // Wire externalSignal → controller if supplied.
    const externalHandler = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
        if (externalSignal.aborted) {
            clearTimeout(timer);
            throw externalSignal.reason ?? new Error('aborted');
        }
        externalSignal.addEventListener('abort', externalHandler);
    }

    try {
        const response = await fetch(input, { ...rest, signal: controller.signal });
        firstCallDone = true;
        return response;
    } catch (e) {
        firstCallDone = true;
        // AbortError from a timeout becomes a clearer FetchTimeoutError.
        if (controller.signal.aborted && controller.signal.reason instanceof FetchTimeoutError) {
            throw controller.signal.reason;
        }
        throw e;
    } finally {
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', externalHandler);
    }
}

/**
 * Reset the "first call" marker. Intended for tests; real app code
 * should let it flip naturally on first use.
 */
export function __resetFirstCallMarker() {
    firstCallDone = false;
}
