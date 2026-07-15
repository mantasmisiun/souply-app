package lt.souply.receiptpdf

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * On-device receipt-PDF → OCR-ready page images — ANDROID twin of the iOS
 * SouplyReceiptPdfModule (see its Swift header for the full rationale).
 *
 *   1. IMAGE-WRAPPER PDFs (Rimi app-share e-receipts: no fonts, exactly one
 *      page-sized JPEG per page): the embedded JPEG is extracted LOSSLESSLY
 *      from the raw PDF byte stream (a /DCTDecode stream IS a complete JPEG
 *      file) and enhanced with the same recipe as the iOS Core Image chain:
 *      grayscale → 3×3 median → single Lanczos-3 upscale to the target width
 *      → unsharp mask. All math runs on plain sRGB pixel values — the iOS
 *      build's "linear working space erodes 346px glyph strokes" trap cannot
 *      happen here (Android bitmaps are sRGB by default and we never convert).
 *
 *   2. Everything else (vector e-receipts like Maxima): android.graphics.pdf
 *      PdfRenderer draws the page at the target width. One resample, crisp
 *      text, no enhancement.
 *
 * Falls back from (1) to (2) on ANY doubt, mirroring iOS: page/image count
 * mismatch, non-JPEG sample data, image dims not matching the page box, or a
 * failed decode. Android has no CGPDF-style object-graph API, so the wrapper
 * signature is verified differently but just as strictly: PdfRenderer supplies
 * the page count + per-page point sizes, the DCT streams are pulled from the
 * raw bytes in document order, and every JPEG's SOF dimensions must match its
 * page's box within ±2.5% (a rotated /Rotate page fails this naturally —
 * PdfRenderer reports post-rotate sizes, the raw samples are pre-rotate).
 */

private class ReceiptPdfException(message: String) : CodedException(message)

class SouplyReceiptPdfModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SouplyReceiptPdf")

    // convert(pdfUri, targetWidth, stepsCsv, unsharpRadius, unsharpIntensity)
    //   → { pages: [file://…png], method: "extract" | "render" }
    // stepsCsv: comma-separated subset of "grayscale,median,unsharp" applied in
    // that fixed order on the extraction path ("" = pure Lanczos upscale only).
    AsyncFunction("convert") { uri: String, targetWidth: Int, stepsCsv: String, unsharpRadius: Double, unsharpIntensity: Double ->
      val steps = stepsCsv.split(',').map { it.trim() }.filter { it.isNotEmpty() }.toSet()
      convert(uri, max(targetWidth, 346), steps, unsharpRadius, unsharpIntensity)
    }
  }

  // ── Entry ──────────────────────────────────────────────────────────────────

  private fun convert(
    uri: String,
    targetWidth: Int,
    steps: Set<String>,
    unsharpRadius: Double,
    unsharpIntensity: Double,
  ): Map<String, Any> {
    val file = resolveFile(uri)
    if (!file.exists()) throw ReceiptPdfException("Could not open PDF at $uri")

    // Structure info via PdfRenderer (count + per-page point sizes).
    val pageSizes = pdfPageSizes(file)
    if (pageSizes.isEmpty()) throw ReceiptPdfException("PDF has no pages")
    if (pageSizes.size > 12) throw ReceiptPdfException("PDF has ${pageSizes.size} pages (max 12)")

    // Path 1 — wrapper extraction. All-or-nothing (multi-page receipts never
    // mix pixel provenances).
    val extracted = try {
      extractAllPages(file.readBytes(), pageSizes, targetWidth, steps, unsharpRadius, unsharpIntensity)
    } catch (_: Throwable) {
      null
    }
    if (extracted != null) return mapOf("pages" to extracted, "method" to "extract")

    // Path 2 — PdfRenderer at target width (single resample).
    return mapOf("pages" to renderAllPages(file, targetWidth), "method" to "render")
  }

  private fun resolveFile(uri: String): File {
    return if (uri.startsWith("file://")) File(Uri.parse(uri).path ?: uri.removePrefix("file://"))
    else File(uri)
  }

  private fun pdfPageSizes(file: File): List<Pair<Int, Int>> =
    ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { pfd ->
      PdfRenderer(pfd).use { renderer ->
        (0 until renderer.pageCount).map { i ->
          renderer.openPage(i).use { page -> page.width to page.height }
        }
      }
    }

  // ── Path 1: lossless embedded-JPEG extraction + enhancement ───────────────

  private fun extractAllPages(
    bytes: ByteArray,
    pageSizes: List<Pair<Int, Int>>,
    targetWidth: Int,
    steps: Set<String>,
    unsharpRadius: Double,
    unsharpIntensity: Double,
  ): List<String>? {
    val jpegs = extractDctStreams(bytes) ?: return null
    // Wrapper signature: exactly one page-sized JPEG per page, document order.
    if (jpegs.size != pageSizes.size) return null
    for ((i, jpeg) in jpegs.withIndex()) {
      val dims = jpegDimensions(jpeg) ?: return null
      val (pw, ph) = pageSizes[i]
      if (pw <= 0 || ph <= 0) return null
      if (abs(dims.first - pw).toFloat() / pw > 0.025f) return null
      if (abs(dims.second - ph).toFloat() / ph > 0.025f) return null
    }
    return jpegs.map { jpeg ->
      writeTemp(enhanceForOcr(jpeg, targetWidth, steps, unsharpRadius, unsharpIntensity), "jpg")
    }
  }

  /**
   * Every /Subtype /Image + /DCTDecode stream's raw bytes, in document order —
   * or null when any DCT image stream can't be cleanly extracted (doubt → the
   * caller falls back to the renderer). ISO-8859-1 keeps char index == byte
   * offset, so string scanning addresses the raw bytes directly.
   */
  private fun extractDctStreams(bytes: ByteArray): List<ByteArray>? {
    val s = String(bytes, Charsets.ISO_8859_1)
    val out = ArrayList<ByteArray>()
    var idx = 0
    while (true) {
      val kw = s.indexOf("stream", idx)
      if (kw < 0) break
      idx = kw + 6
      // Token check: not the tail of "endstream", followed by an EOL.
      if (kw >= 3 && s.regionMatches(kw - 3, "end", 0, 3)) continue
      val afterIdx = kw + 6
      if (afterIdx >= s.length || (s[afterIdx] != '\r' && s[afterIdx] != '\n')) continue

      // The stream's dict sits immediately before the keyword: ws… ">>".
      var q = kw - 1
      while (q >= 0 && s[q].isWhitespace()) q--
      if (q < 1 || s[q] != '>' || s[q - 1] != '>') continue
      // Walk back to the matching "<<" (dicts nest, e.g. /DecodeParms <<…>>).
      var depth = 1
      var pos = q - 2
      var dictStart = -1
      while (pos >= 1) {
        if (s[pos] == '>' && s[pos - 1] == '>') { depth++; pos -= 2 }
        else if (s[pos] == '<' && s[pos - 1] == '<') {
          depth--
          if (depth == 0) { dictStart = pos - 1; break }
          pos -= 2
        } else pos--
      }
      if (dictStart < 0) continue
      val dict = s.substring(dictStart, q + 1)
      if (!Regex("""/Subtype\s*/Image""").containsMatchIn(dict)) continue
      if (!dict.contains("/DCTDecode")) return null // image stream in another format → renderer

      val dataStart = when {
        s.startsWith("\r\n", afterIdx) -> afterIdx + 2
        else -> afterIdx + 1 // single \r or \n
      }
      // Prefer the literal /Length; "/Length 8 0 R" (indirect) falls through
      // to the endstream-boundary scan.
      val litLen = Regex("""/Length\s+(\d+)(?!\s+\d+\s+R)""").find(dict)?.groupValues?.get(1)?.toIntOrNull()
      var data: ByteArray? = null
      if (litLen != null && litLen > 0 && dataStart + litLen <= bytes.size) {
        data = bytes.copyOfRange(dataStart, dataStart + litLen)
      } else {
        val end = s.indexOf("endstream", dataStart)
        if (end > dataStart) {
          var trimmed = end
          while (trimmed > dataStart && (bytes[trimmed - 1] == '\n'.code.toByte() || bytes[trimmed - 1] == '\r'.code.toByte())) trimmed--
          data = bytes.copyOfRange(dataStart, trimmed)
        }
      }
      // A DCT stream that doesn't start with the JPEG SOI marker is corrupt
      // or mis-sliced — doubt disqualifies the whole document.
      if (data == null || data.size < 4 ||
        data[0] != 0xFF.toByte() || data[1] != 0xD8.toByte()
      ) return null
      out.add(data)
      idx = dataStart + data.size
    }
    return out
  }

  /** JPEG pixel dimensions from the SOF marker (w × h), or null. */
  private fun jpegDimensions(d: ByteArray): Pair<Int, Int>? {
    if (d.size < 10 || d[0] != 0xFF.toByte() || d[1] != 0xD8.toByte()) return null
    var p = 2
    while (p + 9 < d.size) {
      if (d[p] != 0xFF.toByte()) { p++; continue }
      val marker = d[p + 1].toInt() and 0xFF
      if (marker == 0xFF) { p++; continue }
      if (marker == 0xD8 || marker == 0x01 || (marker in 0xD0..0xD7)) { p += 2; continue }
      val len = ((d[p + 2].toInt() and 0xFF) shl 8) or (d[p + 3].toInt() and 0xFF)
      if (marker == 0xC0 || marker == 0xC1 || marker == 0xC2 || marker == 0xC3) {
        val h = ((d[p + 5].toInt() and 0xFF) shl 8) or (d[p + 6].toInt() and 0xFF)
        val w = ((d[p + 7].toInt() and 0xFF) shl 8) or (d[p + 8].toInt() and 0xFF)
        return w to h
      }
      if (marker == 0xDA) return null // scan data reached without a SOF
      p += 2 + len
    }
    return null
  }

  // ── Enhancement (sRGB pixel math, mirroring the CI chain) ─────────────────

  private fun enhanceForOcr(
    jpeg: ByteArray,
    targetWidth: Int,
    steps: Set<String>,
    unsharpRadius: Double,
    unsharpIntensity: Double,
  ): ByteArray {
    val src = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
      ?: throw ReceiptPdfException("Could not decode embedded image")
    val sw = src.width
    val sh = src.height
    if (sw <= 0 || sh <= 0) throw ReceiptPdfException("Embedded image has zero width")
    if (sw >= targetWidth) return jpeg // already at/above target — pass through untouched

    val px = IntArray(sw * sh)
    src.getPixels(px, 0, sw, 0, 0, sw, sh)
    src.recycle()

    val scale = min(targetWidth.toFloat() / sw, 6f)
    val dw = (sw * scale).roundToInt()
    val dh = (sh * scale).roundToInt()

    // Grayscale collapses the pipeline to ONE channel (Rec.601 luma) — the
    // default recipe, and 3× cheaper than per-channel processing.
    var channels: Array<FloatArray> = if (steps.contains("grayscale")) {
      arrayOf(FloatArray(sw * sh) {
        val p = px[it]
        0.299f * ((p shr 16) and 0xFF) + 0.587f * ((p shr 8) and 0xFF) + 0.114f * (p and 0xFF)
      })
    } else {
      arrayOf(
        FloatArray(sw * sh) { ((px[it] shr 16) and 0xFF).toFloat() },
        FloatArray(sw * sh) { ((px[it] shr 8) and 0xFF).toFloat() },
        FloatArray(sw * sh) { (px[it] and 0xFF).toFloat() },
      )
    }

    if (steps.contains("median")) channels = Array(channels.size) { median3x3(channels[it], sw, sh) }
    channels = Array(channels.size) { lanczosResize(channels[it], sw, sh, dw, dh) }
    if (steps.contains("unsharp")) {
      channels = Array(channels.size) {
        unsharpMask(channels[it], dw, dh, unsharpRadius.toFloat(), unsharpIntensity.toFloat())
      }
    }

    val out = IntArray(dw * dh)
    if (channels.size == 1) {
      val g = channels[0]
      for (i in out.indices) {
        val v = clamp255(g[i])
        out[i] = (0xFF shl 24) or (v shl 16) or (v shl 8) or v
      }
    } else {
      val (r, g, b) = channels
      for (i in out.indices) {
        out[i] = (0xFF shl 24) or (clamp255(r[i]) shl 16) or (clamp255(g[i]) shl 8) or clamp255(b[i])
      }
    }
    val bmp = Bitmap.createBitmap(out, dw, dh, Bitmap.Config.ARGB_8888)
    val encoded = jpegBytes(bmp)
    bmp.recycle()
    return encoded
  }

  private fun clamp255(v: Float): Int = if (v <= 0f) 0 else if (v >= 255f) 255 else (v + 0.5f).toInt()

  /** 3×3 median (the CIMedianFilter neighborhood), edge-clamped. */
  private fun median3x3(chan: FloatArray, w: Int, h: Int): FloatArray {
    val out = FloatArray(w * h)
    val win = FloatArray(9)
    for (y in 0 until h) {
      val y0 = max(y - 1, 0) * w
      val y1 = y * w
      val y2 = min(y + 1, h - 1) * w
      for (x in 0 until w) {
        val x0 = max(x - 1, 0)
        val x2 = min(x + 1, w - 1)
        win[0] = chan[y0 + x0]; win[1] = chan[y0 + x]; win[2] = chan[y0 + x2]
        win[3] = chan[y1 + x0]; win[4] = chan[y1 + x]; win[5] = chan[y1 + x2]
        win[6] = chan[y2 + x0]; win[7] = chan[y2 + x]; win[8] = chan[y2 + x2]
        win.sort()
        out[y1 + x] = win[4]
      }
    }
    return out
  }

  private fun lanczos3(x: Float): Float {
    if (x == 0f) return 1f
    val ax = abs(x)
    if (ax >= 3f) return 0f
    val pix = (PI * x).toFloat()
    return 3f * sin(pix) * sin(pix / 3f) / (pix * pix)
  }

  private class Taps(val start: IntArray, val weights: Array<FloatArray>)

  /** Per-destination-index Lanczos-3 taps (upscale: support = ±3 source px). */
  private fun buildTaps(srcN: Int, dstN: Int): Taps {
    val scale = dstN.toFloat() / srcN
    val start = IntArray(dstN)
    val weights = arrayOfNulls<FloatArray>(dstN)
    for (d in 0 until dstN) {
      val center = (d + 0.5f) / scale - 0.5f
      val lo = ceil(center - 3f).toInt()
      val hi = floor(center + 3f).toInt()
      val n = hi - lo + 1
      val wts = FloatArray(n)
      var sum = 0f
      for (j in 0 until n) {
        val wv = lanczos3(center - (lo + j))
        wts[j] = wv
        sum += wv
      }
      if (sum != 0f) for (j in 0 until n) wts[j] /= sum
      start[d] = lo
      weights[d] = wts
    }
    @Suppress("UNCHECKED_CAST")
    return Taps(start, weights as Array<FloatArray>)
  }

  /** Separable Lanczos-3 resize of one channel (horizontal, then vertical). */
  private fun lanczosResize(chan: FloatArray, sw: Int, sh: Int, dw: Int, dh: Int): FloatArray {
    val tx = buildTaps(sw, dw)
    val mid = FloatArray(dw * sh)
    for (y in 0 until sh) {
      val row = y * sw
      val out = y * dw
      for (x in 0 until dw) {
        val wts = tx.weights[x]
        val lo = tx.start[x]
        var acc = 0f
        for (j in wts.indices) {
          val sx = min(max(lo + j, 0), sw - 1)
          acc += wts[j] * chan[row + sx]
        }
        mid[out + x] = acc
      }
    }
    val ty = buildTaps(sh, dh)
    val out = FloatArray(dw * dh)
    for (y in 0 until dh) {
      val wts = ty.weights[y]
      val lo = ty.start[y]
      val outRow = y * dw
      for (j in wts.indices) {
        val sy = min(max(lo + j, 0), sh - 1)
        val w = wts[j]
        val midRow = sy * dw
        for (x in 0 until dw) out[outRow + x] += w * mid[midRow + x]
      }
    }
    return out
  }

  /** out = src + intensity · (src − gaussian(src, σ=radius)) — CIUnsharpMask. */
  private fun unsharpMask(chan: FloatArray, w: Int, h: Int, radius: Float, intensity: Float): FloatArray {
    if (radius <= 0f || intensity == 0f) return chan
    val blurred = gaussianBlur(chan, w, h, radius)
    val out = FloatArray(w * h)
    for (i in out.indices) out[i] = chan[i] + intensity * (chan[i] - blurred[i])
    return out
  }

  private fun gaussianBlur(chan: FloatArray, w: Int, h: Int, sigma: Float): FloatArray {
    val half = max(1, ceil(sigma * 3f).toInt())
    val kernel = FloatArray(half * 2 + 1)
    var sum = 0f
    for (i in kernel.indices) {
      val x = (i - half).toFloat()
      kernel[i] = exp(-(x * x) / (2f * sigma * sigma))
      sum += kernel[i]
    }
    for (i in kernel.indices) kernel[i] /= sum

    val mid = FloatArray(w * h)
    for (y in 0 until h) {
      val row = y * w
      for (x in 0 until w) {
        var acc = 0f
        for (k in kernel.indices) {
          val sx = min(max(x + k - half, 0), w - 1)
          acc += kernel[k] * chan[row + sx]
        }
        mid[row + x] = acc
      }
    }
    val out = FloatArray(w * h)
    for (y in 0 until h) {
      val outRow = y * w
      for (k in kernel.indices) {
        val sy = min(max(y + k - half, 0), h - 1)
        val kw = kernel[k]
        val midRow = sy * w
        for (x in 0 until w) out[outRow + x] += kw * mid[midRow + x]
      }
    }
    return out
  }

  // ── Path 2: PdfRenderer (vector receipts / any wrapper doubt) ─────────────

  private fun renderAllPages(file: File, targetWidth: Int): List<String> =
    ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { pfd ->
      PdfRenderer(pfd).use { renderer ->
        (0 until renderer.pageCount).map { i ->
          renderer.openPage(i).use { page ->
            if (page.width <= 0 || page.height <= 0) throw ReceiptPdfException("empty page box")
            val s = targetWidth.toFloat() / page.width
            val bmp = Bitmap.createBitmap(targetWidth, (page.height * s).roundToInt(), Bitmap.Config.ARGB_8888)
            // White fill: receipts assume paper-white behind transparent ink.
            bmp.eraseColor(Color.WHITE)
            val m = Matrix().apply { setScale(s, s) }
            page.render(bmp, null, m, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            val uri = writeTemp(jpegBytes(bmp), "jpg")
            bmp.recycle()
            uri
          }
        }
      }
    }

  // ── Helpers ────────────────────────────────────────────────────────────────

  // JPEG q92, NOT PNG: Android's PNG encoder takes SECONDS on a ~2000×4500
  // enhanced page (zlib over 9Mpx), and every downstream OCR step (tile
  // crops, upscales) then re-decodes the heavy file. The wrapper's source is
  // a JPEG to begin with and enhancement is done by encode time, so q92 costs
  // no OCR-visible fidelity — it cut the device-convert leg from multi-second
  // to sub-second. (iOS keeps PNG: its encoder is fast enough not to matter.)
  private fun jpegBytes(bmp: Bitmap): ByteArray {
    val bos = ByteArrayOutputStream()
    bmp.compress(Bitmap.CompressFormat.JPEG, 92, bos)
    return bos.toByteArray()
  }

  private fun writeTemp(data: ByteArray, ext: String): String {
    val dir = appContext.reactContext?.cacheDir
      ?: throw ReceiptPdfException("No cache directory available")
    val f = File(dir, "receiptpdf-${UUID.randomUUID()}.$ext")
    f.writeBytes(data)
    return "file://${f.absolutePath}"
  }
}
