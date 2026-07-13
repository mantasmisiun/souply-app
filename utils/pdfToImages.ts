import * as FileSystem from "expo-file-system/legacy";
import { API_BASE_URL } from "../config/api";
import { convertPdfOnDevice, devicePdfAvailable } from "./receiptPdf";

/**
 * PDF → OCR-ready page images, shared by every entry point (Analyze file
 * pick via the background queue, list-upload scan session, share sheet).
 * Extracted from app/_layout.tsx's ShareHandler so conversion can run as a
 * background pipeline STAGE instead of a blocking modal.
 *
 * ON-DEVICE first (native souply-receipt-pdf module: lossless wrapper
 * extraction + enhancement, PDFKit render fallback) — the raw PDF carries
 * unmasked PII, so it should not leave the phone, and this also works
 * offline. The server /api/receipts/pdf-to-image endpoint remains the
 * fallback for Android and dev clients predating the native build.
 */

/**
 * Copy a content:// or file:// URI into the app cache and return the
 * resulting file:// path. Share-intent URIs can expire once the intent is
 * handled — callers should normalize BEFORE deferring work.
 */
export async function normalizeToLocalUri(uri: string, ext = ".tmp"): Promise<string> {
  const dest = `${FileSystem.cacheDirectory}share_input_${Date.now()}${ext}`;
  await FileSystem.copyAsync({ from: uri, to: dest });
  return dest;
}

/** Convert a PDF path to PNG page files; returns one file:// URI per page. */
export async function pdfToImageUris(pdfPath: string): Promise<string[]> {
  const localPath = await normalizeToLocalUri(pdfPath, ".pdf");
  if (devicePdfAvailable()) {
    try {
      const { pages, method } = await convertPdfOnDevice(localPath);
      console.log(`[pdfToImages] converted on-device (${method}, ${pages.length} page(s))`);
      // Move out of the temp dir — downstream keeps these URIs through OCR,
      // upload and the ensemble second pass; tmp can be purged by the OS.
      const uris: string[] = [];
      for (let i = 0; i < pages.length; i++) {
        const dest = `${FileSystem.cacheDirectory}share_pdf_page_${Date.now()}_${i}.png`;
        await FileSystem.moveAsync({ from: pages[i], to: dest });
        uris.push(dest);
      }
      return uris;
    } catch (e) {
      console.log("[pdfToImages] on-device convert failed → server fallback:", e);
    }
  }
  const base64 = await FileSystem.readAsStringAsync(localPath, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const res = await fetch(`${API_BASE_URL}/api/receipts/pdf-to-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pdfBase64: base64 }),
  });
  if (!res.ok) throw new Error(`pdf-to-image ${res.status}`);
  const { images } = await res.json() as { images: string[] };
  const uris: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const dest = `${FileSystem.cacheDirectory}share_pdf_page_${Date.now()}_${i}.png`;
    await FileSystem.writeAsStringAsync(dest, images[i], {
      encoding: FileSystem.EncodingType.Base64,
    });
    uris.push(dest);
  }
  return uris;
}

/** True when the picked/shared file is a PDF (mime or extension). */
export function looksLikePdf(uri: string, mimeType?: string | null, name?: string | null): boolean {
  if (mimeType === "application/pdf") return true;
  const n = (name ?? uri).toLowerCase();
  return n.endsWith(".pdf");
}
