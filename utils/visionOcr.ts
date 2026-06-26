import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

/**
 * Apple Vision OCR (native module `souply-vision-ocr`), shaped to match
 * @react-native-ml-kit/text-recognition so utils/mlkitOcr.ts can consume either
 * engine unchanged. iOS-only; on Android and on dev clients that PREDATE the
 * native build the optional-module lookup returns null and `visionOcrAvailable()`
 * is false, so callers fall back to ML Kit (same gate pattern as LiquidGlass.tsx).
 */

export interface VisionPoint { x: number; y: number; }
export interface VisionFrame { left: number; top: number; width: number; height: number; }
export interface VisionElement { text: string; frame: VisionFrame; cornerPoints?: VisionPoint[]; }
export interface VisionLine { text: string; frame: VisionFrame; elements: VisionElement[]; }
export interface VisionResult { blocks: { lines: VisionLine[] }[]; }

interface VisionNativeModule { recognize: (uri: string) => Promise<VisionResult>; }

// requireOptionalNativeModule returns null when the module isn't in the build
// (Android, a dev client predating the native build, jest) — same gate pattern as
// components/LiquidGlass.tsx. Guarded anyway so nothing can throw at import time.
let native: VisionNativeModule | null = null;
try {
    native = requireOptionalNativeModule<VisionNativeModule>('SouplyVisionOcr');
} catch {
    native = null;
}

/** True only when the Apple Vision native module is compiled into THIS iOS build. */
export function visionOcrAvailable(): boolean {
    return Platform.OS === 'ios' && native != null;
}

/** Run Apple Vision OCR → same block/line/element shape as the ML Kit recognizer. */
export async function visionRecognize(uri: string): Promise<VisionResult> {
    if (!native) {
        throw new Error('SouplyVisionOcr native module is not present in this build (iOS-only)');
    }
    return native.recognize(uri);
}
