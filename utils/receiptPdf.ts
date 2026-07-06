import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

/**
 * On-device receipt-PDF conversion (native module `souply-receipt-pdf`).
 * iOS-only; on Android and on dev clients that PREDATE the native build the
 * optional-module lookup returns null and `devicePdfAvailable()` is false, so
 * callers fall back to the server /api/receipts/pdf-to-image endpoint (same
 * gate pattern as utils/visionOcr.ts).
 *
 * Why device-side: the raw share-PDF carries unmasked PII — converting locally
 * keeps it on the phone until the normal on-device masking runs; it also works
 * offline. The native module mirrors the server pipeline: image-wrapper PDFs
 * (Rimi app-share: one 346px JPEG per page, no fonts) get LOSSLESS embedded-
 * image extraction + Core Image enhancement (greyscale → median → LANCZOS
 * upscale → unsharp); vector PDFs (Maxima) render via PDFKit at target width.
 */

export interface DevicePdfResult {
    /** file:// URIs, one OCR-ready PNG per page (temp dir — copy if you need them to persist). */
    pages: string[];
    /** 'extract' = lossless wrapper path (enhanced); 'render' = PDFKit raster. */
    method: 'extract' | 'render';
}

interface ReceiptPdfNativeModule {
    convert: (uri: string, targetWidth: number) => Promise<DevicePdfResult>;
}

let native: ReceiptPdfNativeModule | null = null;
try {
    native = requireOptionalNativeModule<ReceiptPdfNativeModule>('SouplyReceiptPdf');
} catch {
    native = null;
}

/** Matches the server-side ENHANCE_TARGET_WIDTH and the document-mode OCR floor. */
export const DEVICE_PDF_TARGET_WIDTH = 2000;

/** True only when the native module is compiled into THIS iOS build. */
export function devicePdfAvailable(): boolean {
    return Platform.OS === 'ios' && native != null;
}

/** Convert a local PDF to OCR-ready page images entirely on device. */
export async function convertPdfOnDevice(
    uri: string,
    targetWidth: number = DEVICE_PDF_TARGET_WIDTH,
): Promise<DevicePdfResult> {
    if (!native) {
        throw new Error('SouplyReceiptPdf native module is not present in this build (iOS-only)');
    }
    return native.convert(uri, targetWidth);
}
