import TextRecognition from "@react-native-ml-kit/text-recognition";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import { Image } from "react-native";
import { API_BASE_URL } from "../config/api";

/**
 * Per-page OCR context needed to render a band crop correctly for both
 * single-image scans and multi-page PDFs. Regions carry yTop/yBottom in the
 * merged-scaled OCR space; this maps them back to page-local image pixels.
 *
 * Shared by the receipt-detail "Items" tab (receipt-process) and the swipe
 * Card-B OCR crop so both render the SAME parallelogram crop.
 */
export interface PageMeta {
  uri: string;
  pixelWidth: number;
  pixelHeight: number;
  /** scale applied to MLKit coords when populating lines/regions */
  frameScale: number;
  /** start of this page in merged-y space */
  yOffsetScaled: number;
  /** how much merged-y this page occupies (excludes +50 buffer) */
  pageMaxYScaled: number;
  /** horizontal bounds of the receipt text on this page, in merged/scaled space */
  receiptXLeftScaled: number;
  receiptXRightScaled: number;
}

/**
 * Camera photos of receipts often land in landscape (user holding phone
 * sideways, EXIF auto-rotation already baked into the bitmap). The downstream
 * parser + region preview assume a portrait receipt — horizontal rows from
 * different parts of the receipt otherwise merge on the same y and become
 * unparseable. If the image is landscape, try rotating both ±90° and pick
 * the rotation whose OCR produces more lines (the upright one always wins
 * because letters are legible). Returns the URI to use downstream (original
 * if already portrait, rotated variant otherwise).
 */
export async function ensurePortraitOrientation(uri: string): Promise<string> {
  const dims = await new Promise<{ width: number; height: number }>(
    (resolve, reject) => {
      Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
    },
  );
  if (dims.height >= dims.width) return uri;

  const [rotatedCW, rotatedCCW] = await Promise.all([
    ImageManipulator.manipulateAsync(
      uri,
      [{ rotate: 90 }],
      { compress: 1, format: ImageManipulator.SaveFormat.JPEG },
    ),
    ImageManipulator.manipulateAsync(
      uri,
      [{ rotate: -90 }],
      { compress: 1, format: ImageManipulator.SaveFormat.JPEG },
    ),
  ]);

  const [ocrCW, ocrCCW] = await Promise.all([
    TextRecognition.recognize(rotatedCW.uri),
    TextRecognition.recognize(rotatedCCW.uri),
  ]);
  const scoreLines = (r: { blocks: { lines: { text: string }[] }[] }) =>
    r.blocks.reduce((sum, b) => sum + b.lines.length, 0);
  const cwScore = scoreLines(ocrCW);
  const ccwScore = scoreLines(ocrCCW);
  console.log(
    `[ensurePortraitOrientation] landscape ${dims.width}x${dims.height} -> CW lines=${cwScore}, CCW lines=${ccwScore}`,
  );
  return cwScore >= ccwScore ? rotatedCW.uri : rotatedCCW.uri;
}

/**
 * Re-project a saved receipt's stored image back into the coordinate space its
 * parsed regions live in. The OCR pipeline rotates every capture to PORTRAIT (and
 * records the region geometry + parsed.image dims in that space), but the image
 * uploaded/stored can be the pre-rotation LANDSCAPE original — or a different
 * scale. Displayed/cropped as-is, every band lands in the wrong place and the
 * per-band crops fall outside the image ("crop failed … rectangle inside source
 * image"). This rotates to portrait the SAME way the OCR did (line-count vote) and
 * resizes to the exact parsed pixel dims, so regions align 1:1 again. A no-op when
 * the stored image already matches (the common, freshly-scanned case).
 */
export async function normalizeLoadedImage(
  uri: string,
  parsedW: number,
  parsedH: number,
): Promise<{ uri: string; width: number; height: number }> {
  try {
    // ROTATE the stored image to portrait, then RESIZE it to the exact parsed
    // pixel dims. EVERY stored region (products + masks + header + footer) lives
    // in parsed.image space, so the displayed image content must occupy that exact
    // space for the overlay to line up. Measure with ImageManipulator (the decoder
    // TRUE dims — the same measure OCR used), NOT Image.getSize (which can report a
    // decoder-SAMPLED size). Aspect is ~identical so the resize is near-uniform.
    const portraitUri = await ensurePortraitOrientation(uri);
    if (parsedW > 0 && parsedH > 0) {
      // Fast pre-check: a cheap header read (Image.getSize) that ALREADY reports the
      // parsed dims means no resize is needed — skip the full ImageManipulator measure
      // decode (a decode+re-encode of the whole JPEG, pure overhead on the common
      // freshly-uploaded case where stored dims == parsed dims). We only TRUST getSize
      // when it matches parsedW/H within 1px: if BitmapFactory returns a decoder-SAMPLED
      // (smaller) size it won't match the exact parsed dims, so we fall through to the
      // authoritative measure+resize below — never aligning on a sampled size.
      try {
        const gs = await new Promise<{ width: number; height: number }>((resolve, reject) =>
          Image.getSize(portraitUri, (width, height) => resolve({ width, height }), reject),
        );
        if (Math.abs(gs.width - parsedW) <= 1 && Math.abs(gs.height - parsedH) <= 1) {
          return { uri: portraitUri, width: parsedW, height: parsedH };
        }
      } catch {
        /* getSize failed → fall through to the authoritative measure */
      }
      const info = await ImageManipulator.manipulateAsync(portraitUri, []);
      if (Math.abs(info.width - parsedW) > 1 || Math.abs(info.height - parsedH) > 1) {
        const r = await ImageManipulator.manipulateAsync(
          portraitUri,
          [{ resize: { width: parsedW, height: parsedH } }],
          { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG },
        );
        return { uri: r.uri, width: parsedW, height: parsedH };
      }
      return { uri: portraitUri, width: info.width, height: info.height };
    }
    const info = await ImageManipulator.manipulateAsync(portraitUri, []);
    return { uri: portraitUri, width: info.width, height: info.height };
  } catch {
    return { uri, width: parsedW, height: parsedH };
  }
}

/**
 * Reconstruct the OCR coordinate-space dims (parsed.image.width/height) from the
 * largest x/y across every persisted region + word box. Used as a fallback when
 * a receipt was saved with image:null — losing those dims forces the reopen path
 * into a decoder-SAMPLED re-measure that scales every band + mask by the wrong
 * (and non-deterministic) factor, so bands drift and shift on each reopen.
 * Content rarely reaches the very edge, so a small uniform pad approximates the
 * true image extent and keeps the x/y aspect close to the original.
 */
export function deriveImageDimsFromGeometry(src: {
  header?: { region?: any } | null;
  products?: { region?: any }[] | null;
  footer?: { lineRegions?: any[] | null } | null;
  maskBands?: any[] | null;
  wordsDump?: unknown;
}): { width: number; height: number } | null {
  let maxX = 0;
  let maxY = 0;
  const eatRect = (r: any) => {
    if (!r || typeof r !== 'object') return;
    for (const k of ['xLeft', 'xRight']) {
      const v = Number(r[k]);
      if (Number.isFinite(v) && v > maxX) maxX = v;
    }
    for (const k of ['yTop', 'yBottom', 'yLeftBottom', 'yRightBottom', 'piiBottom']) {
      const v = Number(r[k]);
      if (Number.isFinite(v) && v > maxY) maxY = v;
    }
  };
  eatRect(src.header?.region);
  if (Array.isArray(src.products)) for (const p of src.products) eatRect(p?.region);
  if (Array.isArray(src.footer?.lineRegions)) for (const lr of src.footer!.lineRegions!) eatRect(lr);
  if (Array.isArray(src.maskBands)) for (const b of src.maskBands) eatRect(b);
  if (Array.isArray(src.wordsDump)) {
    for (const line of src.wordsDump as any[]) {
      const xs = line?.x;
      const ys = line?.y;
      if (Array.isArray(xs)) { const v = Number(xs[1]); if (Number.isFinite(v) && v > maxX) maxX = v; }
      if (Array.isArray(ys)) { const v = Number(ys[1]); if (Number.isFinite(v) && v > maxY) maxY = v; }
    }
  }
  if (maxX <= 0 || maxY <= 0) return null;
  const PAD = 24;
  return { width: Math.round(maxX + PAD), height: Math.round(maxY + PAD) };
}

/**
 * Build the single PageMeta for a SAVED receipt so a band crop (BandCropImage)
 * can render off the stored photo — used by the swipe Card-B OCR side, which has
 * no scan context of its own. Mirrors the receipt-detail saved/reopen path:
 *   GET /api/receipts/:id/image → presigned URL → download to a local file
 *   (ImageManipulator rejects HTTPS) → normalizeLoadedImage into parsed (OCR)
 *   space so the persisted region corners align 1:1.
 * `imageWidth`/`imageHeight` are the receipt's parsed.image dims (from the
 * resolve-queue response). Returns null on any failure (caller falls back to the
 * flat server crop).
 */
export async function buildReceiptPageMeta(
  receiptId: string | number,
  imageWidth: number,
  imageHeight: number,
  /** Receipt-strip X extent in parsed/OCR space (union of the receipt's band
   *  regions). Without it the crop spans the FULL page width — on A4 e-receipt
   *  pages (Maxima PDFs) that keeps the huge right whitespace and smooshes the
   *  band text to the left. Ignored when absent/degenerate. */
  regionXBounds?: { left: number; right: number } | null,
): Promise<{ pageMeta: PageMeta | null; error: string | null }> {
  const fail = (error: string) => {
    console.warn('[buildReceiptPageMeta]', { receiptId, error });
    return { pageMeta: null, error };
  };
  try {
    const cacheDir = FileSystem.cacheDirectory ?? '';
    const dest = `${cacheDir}receipt-${receiptId}.jpg`;
    let localUri = '';
    let downloaded = false;
    let lastErr = '';
    // FAST PATH: the redacted upload (runUpload caches it here right after the PUT) or a
    // prior download may already sit at the canonical cache path — reuse it instead of a
    // MinIO round-trip. Makes a same-session reopen instant and guarantees the crop shows
    // the SAME redacted pixels that were persisted.
    try {
      const cached = await FileSystem.getInfoAsync(dest);
      if (cached.exists && (cached.size ?? 0) > 0) { localUri = dest; downloaded = true; }
    } catch { /* fall through to download */ }
    // The receipt photo uploads to MinIO ASYNC, and the receipt row's filePath is PATCHed
    // only AFTER that upload finishes — but the swipe screen opens right after the POST.
    // So an early request can hit either (a) GET /image → 404 "image missing" (filePath
    // still empty) OR (b) the MinIO object not present yet. Retry the WHOLE fetch→download
    // each attempt with backoff (re-fetch /image every time so we pick up the filePath the
    // moment the upload lands; presigned URLs are short-lived anyway). ~14s budget covers a
    // normal LAN upload; the card shows the silly "building crop" loader meanwhile.
    const MAX_RETRIES = 8;
    for (let attempt = 0; attempt <= MAX_RETRIES && !downloaded; attempt++) {
      try {
        const imageRes = await fetch(`${API_BASE_URL}/api/receipts/${receiptId}/image`);
        const imageData = imageRes.ok ? await imageRes.json().catch(() => null) : null;
        const url = imageData?.url as string | undefined;
        if (url) {
          const dl = await FileSystem.downloadAsync(url, dest);
          if (dl?.uri && dl?.status === 200) { localUri = dl.uri; downloaded = true; break; }
          lastErr = `photo download HTTP ${dl?.status}`;
        } else {
          // 404 here is almost always the filePath not being set yet (photo still uploading).
          lastErr = `photo not ready (API HTTP ${imageRes.status})`;
        }
      } catch (e: any) {
        lastErr = `image fetch/download error: ${String(e?.message ?? e)}`;
      }
      if (attempt < MAX_RETRIES) {
        await new Promise<void>((r) => setTimeout(r, Math.min(2000, 600 * (attempt + 1))));
      }
    }
    if (!downloaded) return fail(`${lastErr} after ${MAX_RETRIES + 1} tries (photo upload still pending?)`);

    const hasDims =
      Number.isFinite(imageWidth) && Number.isFinite(imageHeight) && imageWidth > 0 && imageHeight > 0;
    const norm = await normalizeLoadedImage(localUri, hasDims ? imageWidth : 0, hasDims ? imageHeight : 0);
    const w = hasDims ? imageWidth : norm.width;
    const h = hasDims ? imageHeight : norm.height;
    const boundsOk =
      regionXBounds != null &&
      Number.isFinite(regionXBounds.left) && Number.isFinite(regionXBounds.right) &&
      regionXBounds.left >= 0 && regionXBounds.right > regionXBounds.left && regionXBounds.right <= w;
    console.log('[buildReceiptPageMeta] ok', { receiptId, dims: `${w}x${h}`, xBounds: boundsOk ? `${Math.round(regionXBounds!.left)}-${Math.round(regionXBounds!.right)}` : 'full', uri: norm.uri });
    return {
      pageMeta: {
        uri: norm.uri,
        pixelWidth: w,
        pixelHeight: h,
        frameScale: 1,
        yOffsetScaled: 0,
        pageMaxYScaled: h,
        receiptXLeftScaled: boundsOk ? regionXBounds!.left : 0,
        receiptXRightScaled: boundsOk ? regionXBounds!.right : w,
      },
      error: null,
    };
  } catch (e: any) {
    return fail(`build error: ${String(e?.message ?? e)}`);
  }
}
