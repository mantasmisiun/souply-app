import { useEffect, useReducer, useRef } from 'react';
import { Image, PixelRatio, View } from 'react-native';
import ViewShot, { captureRef } from 'react-native-view-shot';
import type { MaskBand } from '@shared/parsers/cardMaskDetection';
import { bandsForUploadedImage, maskBoxPercent, maskRenderSize } from '../utils/maskRedaction';

/**
 * Globally-mounted, clipped image-redaction surface.
 *
 * The background receipt-queue pipeline is HEADLESS — it has no React view to
 * capture from. This host lives in the root layout so any flow can burn the
 * black redaction boxes onto an image before upload via `redactImageViaHost`.
 *
 * Android specifics that matter here:
 *   - The surface is kept ON-screen (1×1 clip in the top-left corner, covered
 *     by the app) rather than positioned far off-screen — far-off-screen views
 *     get culled and never load/paint, so the capture hangs.
 *   - `collapsable={false}` stops Android from flattening the views away.
 *   - Capture fires on the image's onLoad AND a fallback timer (cached images
 *     don't always re-fire onLoad), guarded to run once.
 *
 * SECURITY: a rejected promise means "could not redact" — callers MUST NOT
 * upload the original (fail-closed).
 */

interface Req {
    uri: string;
    width: number;
    height: number;
    bands: MaskBand[];
    resolve: (uri: string) => void;
    reject: (e: unknown) => void;
}

let active: Req | null = null;
let notify: (() => void) | null = null;

/**
 * SINGLE SOURCE OF TRUTH for turning a freshly-OCR'd receipt page into the
 * bytes to upload. EVERY entry point (interactive take-photo / upload, and the
 * headless shopping-list + Analyze queue) MUST go through here so the privacy
 * guarantee can never diverge between flows — change masking once, here, and it
 * applies everywhere.
 *
 * Contract (fail-CLOSED):
 *   - No sensitive bands detected            → return the original uri as-is.
 *   - Bands detected but image dims invalid  → THROW (caller must abort/skip
 *     the upload; we must never PUT an original that still shows a card no.).
 *   - Bands detected on the uploaded page-0  → burn them in and return the
 *     redacted file uri; a host failure THROWS (again, caller fail-closes).
 *   - Bands detected only on later PDF pages → return the original (nothing
 *     sensitive is on the page-0 bitmap we upload).
 */
export async function buildRedactedUploadUri(
    uri: string,
    width: number,
    height: number,
    maskBands: MaskBand[],
): Promise<string> {
    if (!maskBands || maskBands.length === 0) return uri;
    // We DID detect sensitive content — from here on, anything that prevents a
    // clean redaction is fatal (fail-closed), never a silent original upload.
    if (!(width > 0) || !(height > 0)) {
        throw new Error(`redaction: invalid image dims ${width}x${height} with ${maskBands.length} band(s)`);
    }
    const bands = bandsForUploadedImage(maskBands, height);
    if (bands.length === 0) return uri; // all bands belong to later pages
    return await redactImageViaHost(uri, width, height, bands);
}

export function redactImageViaHost(
    uri: string,
    width: number,
    height: number,
    bands: MaskBand[],
): Promise<string> {
    return new Promise((resolve, reject) => {
        if (!notify) { reject(new Error('redaction host not mounted')); return; }
        if (active) { reject(new Error('redaction host busy')); return; }
        const settle = { done: false };
        const timer = setTimeout(() => {
            if (!settle.done) {
                settle.done = true;
                active = null;
                notify?.();
                reject(new Error('redaction timeout'));
            }
        }, 5000);
        active = {
            uri, width, height, bands,
            resolve: (u) => { if (!settle.done) { settle.done = true; clearTimeout(timer); resolve(u); } },
            reject: (e) => { if (!settle.done) { settle.done = true; clearTimeout(timer); reject(e); } },
        };
        notify();
    });
}

export function MaskRedactionHost() {
    const [, force] = useReducer((x: number) => x + 1, 0);
    const shotRef = useRef<ViewShot>(null);
    const capturedRef = useRef(false);

    useEffect(() => {
        notify = () => { capturedRef.current = false; force(); };
        return () => { notify = null; };
    }, []);

    const req = active;
    // Output = ORIGINAL pixel dims (so the upload matches stored dims +
    // region coords); render the surface at dims ÷ pixelRatio to bound memory.
    const render = req ? maskRenderSize(req.width, req.height, PixelRatio.get()) : null;

    const runCapture = async () => {
        if (capturedRef.current || !active || !req) return;
        capturedRef.current = true;
        const r = active;
        try {
            let out = await captureRef(shotRef, {
                format: 'jpg', quality: 0.92, result: 'tmpfile',
                width: r.width, height: r.height,
            });
            if (out && out.startsWith('/')) out = `file://${out}`;
            console.log('[MASK] host captured ->', out);
            active = null;
            force();
            r.resolve(out);
        } catch (e) {
            console.warn('[MASK] host capture failed:', e);
            active = null;
            force();
            r.reject(e);
        }
    };

    // Fallback trigger in case the Image's onLoad doesn't fire (cached file).
    useEffect(() => {
        if (!req) return;
        const id = setTimeout(() => { runCapture(); }, 900);
        return () => clearTimeout(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [req?.uri]);

    if (!req || !render) return null;
    const onPageBands = bandsForUploadedImage(req.bands, req.height);

    return (
        <View
            collapsable={false}
            pointerEvents="none"
            style={{ position: 'absolute', top: 0, left: 0, width: 1, height: 1, overflow: 'hidden' }}
        >
            <ViewShot
                ref={shotRef}
                options={{ format: 'jpg', quality: 0.92, result: 'tmpfile', width: req.width, height: req.height }}
                style={{ width: render.width, height: render.height }}
            >
                <Image
                    source={{ uri: req.uri }}
                    style={{ width: '100%', height: '100%' }}
                    resizeMode="stretch"
                    fadeDuration={0}
                    onLoad={() => { runCapture(); }}
                />
                {onPageBands.map((b, i) => {
                    const p = maskBoxPercent(b, req.width, req.height);
                    return (
                        <View
                            key={i}
                            pointerEvents="none"
                            style={{
                                position: 'absolute',
                                left: `${p.left}%`,
                                top: `${p.top}%`,
                                width: `${p.width}%`,
                                height: `${p.height}%`,
                                backgroundColor: '#000',
                            }}
                        />
                    );
                })}
            </ViewShot>
        </View>
    );
}
