import ExpoModulesCore
import Foundation
import Vision
import ImageIO
import CoreGraphics

// Apple Vision text recognition — the iOS OCR engine (utils/mlkitOcr.ts routes iOS
// here; Android stays on ML Kit). Output matches @react-native-ml-kit/text-recognition
// so the parser is engine-agnostic:
//   { blocks: [ { lines: [ { text, frame:{left,top,width,height},
//                            elements: [ { text, frame, cornerPoints:[{x,y}] } ] } ] } ] }
// Coordinates are TOP-LEFT pixel space of the source image (Vision is normalized,
// bottom-left, so we flip Y and scale by the pixel size). Per-word boxes are
// INTERPOLATED along each line's corner quad by character fraction (Apple's
// boundingBox(for:) drops ~half the words at .accurate, starving band geometry).
//
// NOTE: Apple Vision has no dedicated Lithuanian model (uses its Latin recognizer),
// but product matching folds diacritics server-side so that doesn't hurt matching;
// digits (totals/receipt numbers) are read well.

private struct VisionOcrError: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

public class SouplyVisionOcrModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SouplyVisionOcr")

    AsyncFunction("recognize") { (uri: String) -> [String: Any] in
      return try SouplyVisionOcrModule.recognizeText(uri: uri)
    }
  }

  private static func recognizeText(uri: String) throws -> [String: Any] {
    // Accept both file:// URIs and bare filesystem paths.
    let url: URL
    if let parsed = URL(string: uri), let scheme = parsed.scheme, !scheme.isEmpty {
      url = parsed
    } else {
      url = URL(fileURLWithPath: uri)
    }

    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
      throw VisionOcrError(message: "Could not load image at \(uri)")
    }

    // EXIF orientation so Vision's boxes line up with the stored pixels.
    var cgOrientation: CGImagePropertyOrientation = .up
    if let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
       let raw = props[kCGImagePropertyOrientation] as? UInt32,
       let parsed = CGImagePropertyOrientation(rawValue: raw) {
      cgOrientation = parsed
    }

    let pixelWidth = CGFloat(cgImage.width)
    let pixelHeight = CGFloat(cgImage.height)

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false

    let handler = VNImageRequestHandler(cgImage: cgImage, orientation: cgOrientation, options: [:])
    try handler.perform([request])

    // `as?` cast is defensive: VNRecognizeTextRequest specializes `results` to
    // [VNRecognizedTextObservation]?, but the base VNRequest.results is [VNObservation]?
    // — the cast compiles cleanly under either, so it can't break the build.
    let observations = (request.results as? [VNRecognizedTextObservation]) ?? []

    var lines: [[String: Any]] = []
    for obs in observations {
      guard let candidate = obs.topCandidates(1).first else { continue }
      let text = candidate.string
      if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }

      let lineFrame = pixelFrame(from: obs.boundingBox, width: pixelWidth, height: pixelHeight)

      // Per-WORD boxes by INTERPOLATING along the line's corner quad by character
      // position. Apple's boundingBox(for:) is unreliable at .accurate — it returns
      // nil / a degenerate whole-line box for many sub-ranges, which silently dropped
      // ~half the words and starved the parser's band geometry. The line observation
      // is itself a VNRectangleObservation, so its four corners give the tilted text
      // quad; slicing that quad by each word's character fraction yields a complete,
      // CONSISTENT box for EVERY word. Receipt fonts are ~monospace, so character
      // fraction ≈ true horizontal position.
      var elements: [[String: Any]] = []
      let total = max(1, text.count)
      var idx = text.startIndex
      while idx < text.endIndex {
        while idx < text.endIndex, text[idx].isWhitespace { idx = text.index(after: idx) }
        if idx >= text.endIndex { break }
        let wordStart = idx
        while idx < text.endIndex, !text[idx].isWhitespace { idx = text.index(after: idx) }
        let word = String(text[wordStart..<idx])
        if word.isEmpty { continue }

        let startFrac = CGFloat(text.distance(from: text.startIndex, to: wordStart)) / CGFloat(total)
        let endFrac = CGFloat(text.distance(from: text.startIndex, to: idx)) / CGFloat(total)
        let tl = toPixel(lerp(obs.topLeft, obs.topRight, startFrac), pixelWidth, pixelHeight)
        let tr = toPixel(lerp(obs.topLeft, obs.topRight, endFrac), pixelWidth, pixelHeight)
        let bl = toPixel(lerp(obs.bottomLeft, obs.bottomRight, startFrac), pixelWidth, pixelHeight)
        let br = toPixel(lerp(obs.bottomLeft, obs.bottomRight, endFrac), pixelWidth, pixelHeight)
        let minX = min(tl.x, tr.x, bl.x, br.x), maxX = max(tl.x, tr.x, bl.x, br.x)
        let minY = min(tl.y, tr.y, bl.y, br.y), maxY = max(tl.y, tr.y, bl.y, br.y)
        elements.append([
          "text": word,
          "frame": [
            "left": Double(minX), "top": Double(minY),
            "width": Double(maxX - minX), "height": Double(maxY - minY),
          ],
          // clockwise from top-left [TL, TR, BR, BL], matching the MLKit element order
          "cornerPoints": [
            ["x": Double(tl.x), "y": Double(tl.y)],
            ["x": Double(tr.x), "y": Double(tr.y)],
            ["x": Double(br.x), "y": Double(br.y)],
            ["x": Double(bl.x), "y": Double(bl.y)],
          ],
        ])
      }

      lines.append([
        "text": text,
        "frame": lineFrame,
        "elements": elements,
      ])
    }

    return ["blocks": [["lines": lines]]]
  }

  // Vision rects are normalized [0,1] with a BOTTOM-LEFT origin; the parser pipeline
  // works in TOP-LEFT pixel space. Flip Y and scale by the pixel size.
  private static func pixelFrame(from rect: CGRect, width: CGFloat, height: CGFloat) -> [String: Any] {
    return [
      "left": Double(rect.minX * width),
      "top": Double((1.0 - rect.maxY) * height),
      "width": Double(rect.width * width),
      "height": Double(rect.height * height),
    ]
  }

  // Linear interpolation between two normalized points.
  private static func lerp(_ a: CGPoint, _ b: CGPoint, _ t: CGFloat) -> CGPoint {
    return CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
  }

  // Vision corner points are normalized [0,1] with a BOTTOM-LEFT origin; the parser
  // pipeline works in TOP-LEFT pixel space. Flip Y and scale by the pixel size.
  private static func toPixel(_ p: CGPoint, _ width: CGFloat, _ height: CGFloat) -> CGPoint {
    return CGPoint(x: p.x * width, y: (1.0 - p.y) * height)
  }
}
