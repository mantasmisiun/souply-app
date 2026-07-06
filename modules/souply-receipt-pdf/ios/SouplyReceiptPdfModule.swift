import ExpoModulesCore
import Foundation
import CoreGraphics
import CoreImage
import PDFKit
import UIKit

// On-device receipt-PDF → OCR-ready page images. Mirrors the server pipeline
// (souply-api pdfService) so a share-PDF converted on the phone produces the
// same class of input the batch harness stages:
//
//   1. IMAGE-WRAPPER PDFs (Rimi app-share e-receipts: NO fonts, exactly one
//      page-sized raster per page — a 346×780 JPEG @72ppi): the embedded JPEG
//      is extracted LOSSLESSLY from the PDF object graph (CGPDFDocument →
//      Resources → XObject → CGPDFStreamCopyData; a DCTDecode stream IS the
//      raw JPEG bytes) and enhanced with a Core Image chain equivalent to the
//      server's sharp recipe: greyscale → median denoise → single LANCZOS
//      upscale to the target width → unsharp mask. Rasterizing such a page
//      would only interpolate; extraction operates on the true source.
//      (Apple first-party guidance endorses exactly this preprocessing before
//      Vision: WWDC20 session 10673 — CIMedianFilter, CILanczosScaleTransform.)
//
//   2. Everything else (vector e-receipts like Maxima — real embedded fonts):
//      PDFKit renders the page at the target width. One resample, crisp text,
//      no enhancement needed (sharpening crisp vector output only adds halos).
//
// Falls back from (1) to (2) on ANY doubt: fonts present, multiple images on
// a page, non-JPEG sample formats, image dims not matching the page box, or
// a failed decode. The method actually used is reported back to JS.

private struct ReceiptPdfError: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

public class SouplyReceiptPdfModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SouplyReceiptPdf")

    // convert(pdfUri, targetWidth) → { pages: [file://…png], method: "extract" | "render" }
    AsyncFunction("convert") { (uri: String, targetWidth: Int) -> [String: Any] in
      return try SouplyReceiptPdfModule.convert(uri: uri, targetWidth: CGFloat(max(targetWidth, 346)))
    }
  }

  // MARK: - Entry

  private static func convert(uri: String, targetWidth: CGFloat) throws -> [String: Any] {
    let url: URL
    if let parsed = URL(string: uri), let scheme = parsed.scheme, !scheme.isEmpty {
      url = parsed
    } else {
      url = URL(fileURLWithPath: uri)
    }

    guard let cgDoc = CGPDFDocument(url as CFURL) else {
      throw ReceiptPdfError(message: "Could not open PDF at \(uri)")
    }
    let pageCount = cgDoc.numberOfPages
    guard pageCount >= 1 else { throw ReceiptPdfError(message: "PDF has no pages") }
    // Receipt PDFs are 1–3 pages; a page-bomb has no business here (same cap
    // class as the server endpoint's DoS guards).
    guard pageCount <= 12 else { throw ReceiptPdfError(message: "PDF has \(pageCount) pages (max 12)") }

    // Path 1 — wrapper extraction. All-or-nothing: every page must extract,
    // otherwise the whole document goes through the renderer so multi-page
    // receipts never mix pixel provenances.
    if let extracted = try? extractAllPages(cgDoc, pageCount: pageCount, targetWidth: targetWidth) {
      return ["pages": extracted, "method": "extract"]
    }

    // Path 2 — PDFKit render at target width (single resample).
    let rendered = try renderAllPages(url: url, pageCount: pageCount, targetWidth: targetWidth)
    return ["pages": rendered, "method": "render"]
  }

  // MARK: - Path 1: lossless embedded-image extraction + enhancement

  private static func extractAllPages(_ doc: CGPDFDocument, pageCount: Int, targetWidth: CGFloat) throws -> [String] {
    var uris: [String] = []
    for pageNo in 1...pageCount {
      guard let page = doc.page(at: pageNo) else { throw ReceiptPdfError(message: "missing page \(pageNo)") }
      guard let jpeg = try singlePageSizedImage(page) else {
        throw ReceiptPdfError(message: "page \(pageNo) is not a clean image wrapper")
      }
      let enhanced = try enhanceForOcr(jpeg, targetWidth: targetWidth)
      uris.append(try writeTemp(enhanced, ext: "png"))
    }
    return uris
  }

  /// The page's single page-sized embedded image as raw JPEG bytes, or nil
  /// when the page doesn't match the wrapper signature.
  private static func singlePageSizedImage(_ page: CGPDFPage) throws -> Data? {
    guard let pageDict = page.dictionary else { return nil }

    var resourcesRef: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(pageDict, "Resources", &resourcesRef), let resources = resourcesRef else { return nil }
    var xObjectRef: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(resources, "XObject", &xObjectRef), let xObject = xObjectRef else { return nil }

    // Collect every Image XObject on the page. `count > 1` or a non-JPEG
    // sample format disqualifies the page (raw/Flate samples would need
    // colorspace reconstruction — the renderer handles those correctly).
    final class Collector {
      var images: [(data: Data?, width: Int, height: Int)] = []
    }
    let collector = Collector()
    let info = Unmanaged.passUnretained(collector).toOpaque()

    CGPDFDictionaryApplyBlock(xObject, { _, object, rawInfo in
      let collector = Unmanaged<Collector>.fromOpaque(rawInfo!).takeUnretainedValue()
      var streamRef: CGPDFStreamRef?
      guard CGPDFObjectGetValue(object, .stream, &streamRef), let stream = streamRef else { return true }
      guard let streamDict = CGPDFStreamGetDictionary(stream) else { return true }
      var subtypePtr: UnsafePointer<Int8>?
      guard CGPDFDictionaryGetName(streamDict, "Subtype", &subtypePtr),
            let subtype = subtypePtr, String(cString: subtype) == "Image" else { return true }
      var width: CGPDFInteger = 0
      var height: CGPDFInteger = 0
      CGPDFDictionaryGetInteger(streamDict, "Width", &width)
      CGPDFDictionaryGetInteger(streamDict, "Height", &height)
      var format = CGPDFDataFormat.raw
      let cfData = CGPDFStreamCopyData(stream, &format)
      // DCTDecode (.jpegEncoded) / JPX streams are complete image files as-is.
      let data: Data? = (format == .jpegEncoded || format == .JPX) ? (cfData as Data?) : nil
      collector.images.append((data: data, width: Int(width), height: Int(height)))
      return true
    }, info)

    guard collector.images.count == 1, let img = collector.images.first, let data = img.data else { return nil }

    // Image must fill the page box (±2.5%) in the same orientation — a
    // rotated or cropped CTM needs the renderer, not raw samples.
    let box = page.getBoxRect(.mediaBox)
    guard box.width > 0, box.height > 0 else { return nil }
    let dw = abs(CGFloat(img.width) - box.width) / box.width
    let dh = abs(CGFloat(img.height) - box.height) / box.height
    guard dw <= 0.025, dh <= 0.025 else { return nil }
    // /Rotate must be a no-op for the raw samples to be upright.
    guard page.rotationAngle % 360 == 0 else { return nil }

    return data
  }

  /// Core Image equivalent of the server's sharp recipe (greyscale → median →
  /// LANCZOS upscale → unsharp). Skipped entirely when the source is already
  /// at/above the target width — then the lossless bytes win as-is.
  private static func enhanceForOcr(_ jpegData: Data, targetWidth: CGFloat) throws -> Data {
    guard var image = CIImage(data: jpegData) else {
      throw ReceiptPdfError(message: "Could not decode embedded image")
    }
    let sourceWidth = image.extent.width
    guard sourceWidth > 0 else { throw ReceiptPdfError(message: "Embedded image has zero width") }
    if sourceWidth >= targetWidth {
      return jpegData
    }

    image = image.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0.0])
    image = image.applyingFilter("CIMedianFilter")
    let scale = min(targetWidth / sourceWidth, 6.0)
    image = image.applyingFilter("CILanczosScaleTransform", parameters: [
      kCIInputScaleKey: scale,
      kCIInputAspectRatioKey: 1.0,
    ])
    image = image.applyingFilter("CIUnsharpMask", parameters: [
      kCIInputRadiusKey: 2.5,
      kCIInputIntensityKey: 0.9,
    ])

    let context = CIContext()
    guard let png = context.pngRepresentation(
      of: image.cropped(to: image.extent),
      format: .RGBA8,
      colorSpace: CGColorSpaceCreateDeviceRGB()
    ) else {
      throw ReceiptPdfError(message: "Could not encode enhanced page")
    }
    return png
  }

  // MARK: - Path 2: PDFKit render (vector receipts / any wrapper doubt)

  private static func renderAllPages(url: URL, pageCount: Int, targetWidth: CGFloat) throws -> [String] {
    guard let doc = PDFDocument(url: url) else {
      throw ReceiptPdfError(message: "PDFKit could not open the document")
    }
    var uris: [String] = []
    for i in 0..<pageCount {
      guard let page = doc.page(at: i) else { throw ReceiptPdfError(message: "missing page \(i + 1)") }
      let bounds = page.bounds(for: .mediaBox)
      guard bounds.width > 0, bounds.height > 0 else { throw ReceiptPdfError(message: "empty page box") }
      // thumbnail(of:for:) honours /Rotate and preserves aspect. White fill is
      // implicit (PDFKit composites onto white for opaque output).
      let size = CGSize(width: targetWidth, height: (bounds.height / bounds.width) * targetWidth)
      let image = page.thumbnail(of: size, for: .mediaBox)
      guard let png = image.pngData() else { throw ReceiptPdfError(message: "could not encode page \(i + 1)") }
      uris.append(try writeTemp(png, ext: "png"))
    }
    return uris
  }

  // MARK: - Helpers

  private static func writeTemp(_ data: Data, ext: String) throws -> String {
    let dir = FileManager.default.temporaryDirectory
    let url = dir.appendingPathComponent("receiptpdf-\(UUID().uuidString).\(ext)")
    try data.write(to: url, options: .atomic)
    return url.absoluteString
  }
}
