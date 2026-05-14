import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

/**
 * Stable device fingerprint for account-recovery rate limiting.
 *
 * V1 uses an install-scoped UUID alone (no native device id), persisted
 * in AsyncStorage and SHA-256'd before going on the wire. The hash keeps
 * the raw seed off the server while still letting the rate-limit query
 * compare against a stable string within one install.
 *
 * Reinstall trade-off (per spec): wiping app data drops the seed, so a
 * full reinstall resets the lockout counter. Acceptable for v1 — full
 * reinstall is high-cost per attempt (60+ sec) and not a scalable abuse
 * vector. Harden with `expo-application` device id once that dep is
 * justified by another feature.
 *
 * Memoised so repeated calls during the recovery flow are O(1).
 */

const FINGERPRINT_SEED_KEY = 'recoveryFingerprintSeed';

let cached: string | null = null;

export async function getDeviceFingerprint(): Promise<string> {
    if (cached) return cached;

    const seed = await getOrCreateSeed();
    cached = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        `recovery::${seed}`,
    );
    return cached;
}

async function getOrCreateSeed(): Promise<string> {
    let seed = await AsyncStorage.getItem(FINGERPRINT_SEED_KEY);
    if (!seed) {
        seed = Crypto.randomUUID();
        await AsyncStorage.setItem(FINGERPRINT_SEED_KEY, seed);
    }
    return seed;
}
