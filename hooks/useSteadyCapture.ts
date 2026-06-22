import { useEffect, useRef } from 'react';
import { DeviceMotion } from 'expo-sensors';

/**
 * Auto-capture trigger for the guided receipt scanner.
 *
 * Watches device motion and fires `onFire()` when the phone has been held STILL
 * for a short moment — but only AFTER it has moved since the last capture. That
 * "move → settle → fire" cycle is what lets the user slide down the receipt and
 * have each section captured automatically the instant they pause, without ever
 * re-firing on the same spot.
 *
 * Capturing only when still also guarantees SHARP frames (no motion blur), which
 * is what makes the downstream OCR + seam-merge reliable.
 */

// Thresholds are on an EMA-SMOOTHED motion level (so hand tremor while holding
// still doesn't keep resetting the steadiness timer). Tuned for the
// gravity-delta fallback; if auto-capture mis-fires on your device, read the
// `[steady] motion=` log: pick STILL just above the held-still value and MOVE
// below the sliding value.
// Held hand-held, a body NEVER goes perfectly still — there's a constant
// low-amplitude tremor/sway (~0.1–0.25 on the gravity-delta scale). The old
// 0.12 "still" gate sat right inside that band, so the timer kept resetting and
// auto-capture almost never armed. These looser gates treat "hand-held steady"
// (not "tripod still") as good enough: capture the instant the user pauses,
// since OCR + the tolerant seam-merge don't need a perfectly motionless frame.
/** Smoothed motion below which we consider the phone "still (hand-held)". */
const STILL_THRESHOLD = 0.28;
/** …and above which the user has "moved" (re-arms after a capture). Kept well
 *  above STILL so the deliberate slide-down to the next section clearly re-arms
 *  without the resting tremor doing it. */
const MOVE_THRESHOLD = 0.55;
/** How long it must stay still before firing (shorter = snappier). */
const STILL_MS = 280;
/** Motion sampling interval. */
const INTERVAL_MS = 60;
/** EMA weight for the new sample (higher = snappier, lower = smoother). */
const EMA_ALPHA = 0.45;

export function useSteadyCapture(opts: {
    enabled: boolean;
    onFire: () => void;
    /** Called when the phone starts/stops being "held still" (arming the shot) —
     *  drives the on-screen "hold still" cue. */
    onArming?: (arming: boolean) => void;
}) {
    const { enabled, onFire, onArming } = opts;
    const onFireRef = useRef(onFire);
    onFireRef.current = onFire;
    const onArmingRef = useRef(onArming);
    onArmingRef.current = onArming;

    // `cooldown` = waiting for the user to move before we'll arm again.
    const cooldownRef = useRef(false);
    const stillSinceRef = useRef<number | null>(null);
    // Fallback motion baseline (gravity-inclusive accel) for devices that don't
    // report gravity-excluded linear acceleration.
    const lastGravMagRef = useRef<number | null>(null);
    const loggedRef = useRef(false);
    const motionRef = useRef(0);       // EMA-smoothed motion level
    const lastLogRef = useRef(0);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;

        (async () => {
            // iOS needs motion permission; Android grants it implicitly.
            try { await DeviceMotion.requestPermissionsAsync(); } catch { /* best effort */ }
            if (cancelled) return;
            DeviceMotion.setUpdateInterval(INTERVAL_MS);
        })();

        const sub = DeviceMotion.addListener((data) => {
            if (!loggedRef.current) {
                loggedRef.current = true;
                console.log('[steady] DeviceMotion active; linear-accel=', !!data.acceleration);
            }
            // Motion magnitude: prefer gravity-EXCLUDED linear acceleration; many
            // Android devices report it as null, so fall back to the per-sample
            // CHANGE in gravity-INCLUSIVE accel (≈0 when still, spikes on move).
            const a = data.acceleration;
            let mag: number;
            if (a && (a.x != null || a.y != null || a.z != null)) {
                mag = Math.sqrt((a.x ?? 0) ** 2 + (a.y ?? 0) ** 2 + (a.z ?? 0) ** 2);
            } else {
                const g = data.accelerationIncludingGravity;
                if (!g) return;
                const gm = Math.sqrt((g.x ?? 0) ** 2 + (g.y ?? 0) ** 2 + (g.z ?? 0) ** 2);
                if (lastGravMagRef.current == null) { lastGravMagRef.current = gm; return; }
                mag = Math.abs(gm - lastGravMagRef.current);
                lastGravMagRef.current = gm;
            }

            // Smooth out hand tremor so "still" is detected reliably hand-held.
            motionRef.current = motionRef.current * (1 - EMA_ALPHA) + mag * EMA_ALPHA;
            const motion = motionRef.current;

            const now = Date.now();
            if (now - lastLogRef.current > 700) {
                lastLogRef.current = now;
                console.log(`[steady] motion=${motion.toFixed(3)} cooldown=${cooldownRef.current} arming=${stillSinceRef.current != null}`);
            }

            if (cooldownRef.current) {
                // Re-arm only once the user has clearly moved (slid to the next part).
                if (motion > MOVE_THRESHOLD) {
                    cooldownRef.current = false;
                    stillSinceRef.current = null;
                }
                return;
            }

            if (motion < STILL_THRESHOLD) {
                if (stillSinceRef.current == null) { stillSinceRef.current = now; onArmingRef.current?.(true); }
                else if (now - stillSinceRef.current >= STILL_MS) {
                    stillSinceRef.current = null;
                    cooldownRef.current = true; // capture now; wait for movement before next
                    onArmingRef.current?.(false);
                    onFireRef.current();
                }
            } else {
                if (stillSinceRef.current != null) { stillSinceRef.current = null; onArmingRef.current?.(false); } // moved
            }
        });

        return () => { cancelled = true; sub.remove(); };
    }, [enabled]);

    /** Force the cooldown so a just-captured frame won't immediately re-fire while
     *  the OCR check runs and the user hasn't moved yet. */
    const armAfterMove = () => { cooldownRef.current = true; stillSinceRef.current = null; };
    return { armAfterMove };
}
