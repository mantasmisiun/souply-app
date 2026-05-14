import { API_BASE_URL } from '../config/api';
import { getUserId, setUserId } from '../config/user';
import { getDeviceFingerprint } from './deviceFingerprint';

/**
 * Client wrapper around POST /api/users/recover.
 *
 * Three submitted receipts, each carrying the strict match key
 * (receiptNo + date + total). The server runs the match algorithm,
 * applies the rate limit, merges any fresh-install activity into the
 * recovered account, and returns one of three outcomes.
 *
 * Generic failure copy is the only thing surfaced to the user (per
 * spec) — reason codes stay server-side for telemetry.
 */

export interface SubmittedReceipt {
    receiptNo: string;
    date: string;   // YYYY-MM-DD
    total: number;
}

export type RestoreOutcome =
    | { status: 'success'; recoveredUserId: string }
    | { status: 'failed' }
    | { status: 'locked' };

/**
 * Submits the 3 receipts to the recover endpoint and, on success,
 * adopts the recovered UUID locally. Caller is expected to trigger
 * an app reload right after — see _layout's force-restart helper.
 */
export async function attemptRestore(receipts: SubmittedReceipt[]): Promise<RestoreOutcome> {
    if (receipts.length !== 3) {
        return { status: 'failed' };
    }

    const [freshUserId, deviceFingerprint] = await Promise.all([
        getUserId(),
        getDeviceFingerprint(),
    ]);

    const res = await fetch(`${API_BASE_URL}/api/users/recover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceFingerprint, freshUserId, receipts }),
    });

    if (!res.ok) {
        // 400/500 → present as generic failure to the user. The server
        // logs the actual reason; no need to leak details here.
        return { status: 'failed' };
    }

    const body = await res.json() as RestoreOutcome;

    if (body.status === 'success' && body.recoveredUserId) {
        await setUserId(body.recoveredUserId);
    }

    return body;
}
