import { API_BASE_URL } from '../config/api';
import { APP_ENV } from '../config/env';

/**
 * TEMP debug: fire-and-forget a client-side log line to the API so app id
 * values land in the same staging container log as the server's. No-op in
 * prod. Remove after the template-identity bug is diagnosed.
 */
export function dbg(msg: string): void {
    if (APP_ENV === 'prod') return;
    try {
        fetch(`${API_BASE_URL}/api/debug/log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ msg }),
        }).catch(() => {});
    } catch { /* never throw from a log */ }
}
