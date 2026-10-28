import Foundation
import CoreGraphics
import ImageIO

enum ThumbnailTestFailure: Error, CustomStringConvertible {
    case failed(String)
    var description: String { switch self { case .failed(let message): return message } }
}

func thumbnailRequire(_ condition: Bool, _ message: String) throws {
    if !condition { throw ThumbnailTestFailure.failed(message) }
}

/// Read normalized RGBA bytes rather than treating a nonempty PNG as success.
func thumbnailPixels(_ image: CGImage, expectedSize: Int? = nil) throws -> [String: Any] {
    let width = image.width, height = image.height
    try thumbnailRequire(width > 0 && height > 0 && width <= 1024 && height <= 1024, "Unexpected thumbnail dimensions: \(width)x\(height)")
    if let expectedSize { try thumbnailRequire(width == expectedSize && height == expectedSize, "Expected \(expectedSize)x\(expectedSize), got \(width)x\(height)") }
    var data = [UInt8](repeating: 0, count: width * height * 4)
    let valid = data.withUnsafeMutableBytes { bytes -> Bool in
        guard let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return true
    }
    try thumbnailRequire(valid, "Cannot read thumbnail pixels")
    var colored = 0, transparent = 0, opaque = 0
    var minX = width, minY = height, maxX = -1, maxY = -1
    for i in stride(from: 0, to: data.count, by: 4) {
        let alpha = data[i + 3]
        if alpha == 0 { transparent += 1 }
        if alpha > 200 { opaque += 1 }
        if alpha > 100 {
            let x = (i / 4) % width, y = (i / 4) / width
            minX = min(minX, x); minY = min(minY, y)
            maxX = max(maxX, x); maxY = max(maxY, y)
        }
        if alpha > 100 && Int(max(data[i], data[i + 1], data[i + 2])) - Int(min(data[i], data[i + 1], data[i + 2])) > 35 { colored += 1 }
    }
    try thumbnailRequire(colored > width * height / 100, "Thumbnail has no sufficiently colored model surface: \(colored) pixels")
    try thumbnailRequire(opaque > width * height / 100, "Thumbnail has no opaque model surface")
    try thumbnailRequire(transparent > width * height / 100, "Thumbnail lost its transparent background")
    let corners = [3, (width - 1) * 4 + 3, ((height - 1) * width) * 4 + 3, data.count - 1].map { data[$0] }
    try thumbnailRequire(corners.allSatisfy { $0 == 0 }, "Thumbnail is cropped into a corner: alpha=\(corners)")
    // All fixtures are the same rectangular model in different encodings. Its
    // silhouette must fill and stay centered in the requested output. Merely
    // detecting a colored pixel would miss a Retina points/pixels scale error.
    let bounds = [minX, minY, maxX + 1, maxY + 1]
    try thumbnailRequire(maxX - minX + 1 > width * 3 / 5 && maxY - minY + 1 > height / 2,
        "Model silhouette is too small for output \(width)x\(height): bounds=\(bounds)")
    try thumbnailRequire(abs(Double(minX + maxX + 1) / 2 - Double(width) / 2) < Double(width) * 0.15 &&
        abs(Double(minY + maxY + 1) / 2 - Double(height) / 2) < Double(height) * 0.15,
        "Model silhouette is off center: bounds=\(bounds), output=\(width)x\(height)")
    return ["width": width, "height": height, "coloredPixels": colored, "opaquePixels": opaque, "transparentPixels": transparent, "modelBounds": bounds]
}

func saveThumbnail(_ image: CGImage, to url: URL) throws {
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { throw ThumbnailTestFailure.failed("Cannot create PNG destination") }
    CGImageDestinationAddImage(destination, image, nil)
    try thumbnailRequire(CGImageDestinationFinalize(destination), "Cannot write thumbnail PNG")
}

func writeThumbnailTestReport(_ result: [String: Any], to url: URL) throws {
    try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic)
}
