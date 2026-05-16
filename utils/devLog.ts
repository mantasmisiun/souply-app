import Constants from 'expo-constants';
import { API_BASE_URL } from '../config/api';

const ENABLED =
    __DEV__ || Constants.expoConfig?.name === 'Souply (DEV)';

/**
 * Fire-and-forget POST to /api/dev-log so diagnostics from iOS DEV
 * builds (no Metro, no logcat) land in a file on the laptop. Mirrors
 * the OCR batch-test logging pattern. Production builds are a no-op.
 */
export function devLog(tag: string, payload?: unknown): void {
    if (!ENABLED) return;
    try {
        void fetch(`${API_BASE_URL}/api/dev-log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag, payload }),
        }).catch(() => {});
    } catch {
        // Never let logging crash the caller.
    }
}
