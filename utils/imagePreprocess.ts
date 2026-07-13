import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

/**
 * Whole-receipt OCR preprocessing variants (Android / ML Kit only).
 *
 * ML Kit has no accuracy knobs, so the only lever is the pixels. A BLUE ink
 * stain is bright in the RED channel while black thermal print is dark in every
 * channel — so broadcasting the red channel renders the stain near-white
 * (erased) while the date/product text survives. This is the on-device version
 * of what Apple Vision does internally and is why Vision read a stained date the
 * raw-pixel ML Kit path dropped.
 *
 * Implemented with @shopify/react-native-skia (offscreen GPU image filters).
 * Skia is a NATIVE module: this helper is GUARDED so it returns nothing until
 * Skia is installed AND in the build — on the current dev client / Android
 * without the rebuild, `preprocessAvailable()` is false and the OCR layer simply
 * skips the extra variants (no behaviour change, no regression). iOS uses Apple
 * Vision and never calls this.
 */

let Skia: any = null;
try {
    // Guarded require: resolves to null when the package isn't installed (now)
    // or its native side isn't loaded (build predating Skia). Never throws.
    // @ts-ignore — optional native dep; not resolvable until `expo install`ed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@shopify/react-native-skia');
    Skia = mod?.Skia ?? null;
} catch {
    Skia = null;
}

/** True only when Skia is installed AND its native side is in THIS build (Android). */
export function preprocessAvailable(): boolean {
    return Platform.OS === 'android' && Skia != null && typeof Skia.Surface?.MakeOffscreen === 'function';
}

// Broadcast the RED channel into R, G and B (and keep alpha). Erases blue/cyan
// stains; black print stays black, white paper stays white.
const RED_BROADCAST = [
    1, 0, 0, 0, 0,
    1, 0, 0, 0, 0,
    1, 0, 0, 0, 0,
    0, 0, 0, 1, 0,
];

// Linear contrast stretch around mid-gray (helps faded thermal print).
const CONTRAST = 1.35;
const CONTRAST_MATRIX = [
    CONTRAST, 0, 0, 0, (1 - CONTRAST) * 128 / 255,
    0, CONTRAST, 0, 0, (1 - CONTRAST) * 128 / 255,
    0, 0, CONTRAST, 0, (1 - CONTRAST) * 128 / 255,
    0, 0, 0, 1, 0,
];

async function renderWithMatrix(uri: string, matrix: number[], tag: string): Promise<string | null> {
    try {
        const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
        const data = Skia.Data.fromBase64(b64);
        const img = Skia.Image.MakeImageFromEncoded(data);
        if (!img) return null;
        const w = img.width();
        const h = img.height();
        const surface = Skia.Surface.MakeOffscreen(w, h);
        if (!surface) return null;
        const canvas = surface.getCanvas();
        const paint = Skia.Paint();
        paint.setColorFilter(Skia.ColorFilter.MakeMatrix(matrix));
        canvas.drawImage(img, 0, 0, paint);
        surface.flush();
        const snap = surface.makeImageSnapshot();
        // PNG keeps the recolor lossless (JPEG would re-introduce colour noise).
        const bytes = snap.encodeToBase64(Skia.ImageFormat.PNG, 100);
        const out = `${FileSystem.cacheDirectory}ocr-${tag}-${w}x${h}.png`;
        await FileSystem.writeAsStringAsync(out, bytes, { encoding: FileSystem.EncodingType.Base64 });
        return out;
    } catch {
        return null;
    }
}

/**
 * Build the extra OCR input variants for a degraded receipt page. Returns file
 * URIs (same pixel dimensions as the source, so OCR coords line up 1:1 for
 * fusion). Empty when Skia isn't in the build. NEVER throws.
 */
export async function makeOcrVariants(uri: string): Promise<string[]> {
    if (!preprocessAvailable()) return [];
    const variants = await Promise.all([
        renderWithMatrix(uri, RED_BROADCAST, 'destain'),
        renderWithMatrix(uri, CONTRAST_MATRIX, 'contrast'),
    ]);
    return variants.filter((v): v is string => !!v);
}
