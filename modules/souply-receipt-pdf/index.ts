// Native registration only (iOS on-device PDF → OCR-ready images).
// Autolinked into the iOS build via expo-module.config.json (platforms: apple).
// The JS that consumes the native module lives in `utils/receiptPdf.ts` (so it can
// gracefully no-op on Android and on dev clients that predate the native build,
// exactly like utils/visionOcr.ts does for souply-vision-ocr).
// Nothing to export here.
export {};
