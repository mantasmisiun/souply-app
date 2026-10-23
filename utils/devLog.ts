import Constants from 'expo-constants';
import { API_BASE_URL } from '../config/api';

// The test suite must NOT post here: a jest run would otherwise write real rows
// into the dev log a live investigation is reading (it did — queue traces from a
// test run sat next to the device's own during a receipt bug hunt).
const IS_TEST = process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;
const ENABLED =
    !IS_TEST && (__DEV__ || Constants.expoConfig?.name === 'Souply (DEV)');

/**
 * Fire-and-forget logging to /api/dev-log so diagnostics from iOS DEV
 * builds (no Metro, no logcat) land in a file on the laptop. Mirrors
 * the OCR batch-test logging pattern. Production builds are a no-op.
 *
 * BATCHED (perf audit finding 19): with 56 call sites, one POST per call
 * meant hot paths (queue processing, per-render logs) fired network
 * requests in bursts, distorting the dev builds the owner actually tests
 * on. Now:
 *   - an ISOLATED call still posts immediately with the original
 *     `{tag, payload}` body, so the server log line is byte-identical
 *     to before (one line per entry, greppable by tag);
 *   - calls arriving within FLUSH_MS of the last send are buffered and
 *     shipped as ONE `{tag:'batch', payload:{n, entries}}` POST — each
 *     entry keeps its own client `ts`, `tag` and `payload`, so ordering
 *     and grep-by-tag survive inside the batch line;
 *   - the buffer is hard-capped (oldest dropped, drop count reported in
 *     the next flush) so a pathological log loop can't grow unbounded;
 *   - `crash.*` tags flush the whole buffer immediately — the app may
 *     be dying, a trailing timer would lose the report.
 */
const FLUSH_MS = 400;
const MAX_BUFFER = 300;

interface Entry { ts: string; tag: string; payload: unknown }

let buffer: Entry[] = [];
let droppedCount = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastSendAt = 0;

function post(body: unknown): void {
    try {
        void fetch(`${API_BASE_URL}/api/dev-log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).catch(() => {});
    } catch {
        // Never let logging crash the caller.
    }
}

function flush(): void {
    if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
    if (buffer.length === 0) return;
    lastSendAt = Date.now();
    const entries = buffer;
    buffer = [];
    const dropped = droppedCount;
    droppedCount = 0;
    if (entries.length === 1 && dropped === 0) {
        // Single entry → the pre-batching wire shape, so trickle-rate logs
        // produce exactly the log lines they always did.
        post({ tag: entries[0].tag, payload: entries[0].payload });
    } else {
        post({
            tag: 'batch',
            payload: { n: entries.length, ...(dropped > 0 ? { dropped } : {}), entries },
        });
    }
}

export function devLog(tag: string, payload?: unknown): void {
    if (!ENABLED) return;
    if (buffer.length >= MAX_BUFFER) { buffer.shift(); droppedCount++; }
    buffer.push({ ts: new Date().toISOString(), tag, payload });
    if (tag.startsWith('crash')) { flush(); return; }
    if (flushTimer != null) return; // a trailing flush is already scheduled
    const sinceLast = Date.now() - lastSendAt;
    if (sinceLast >= FLUSH_MS) {
        flush(); // leading edge: an isolated log posts immediately, as before
    } else {
        flushTimer = setTimeout(flush, FLUSH_MS - sinceLast);
    }
}
