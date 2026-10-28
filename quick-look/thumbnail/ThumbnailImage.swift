import Foundation
import ImageIO

enum ThumbnailImage {
    /// Check dimensions before asking ImageIO to decode untrusted pixel data.
    static func decode(_ base64: String, pixels: Int) throws -> CGImage {
        guard (1...1024).contains(pixels), base64.utf8.count <= 8 * 1024 * 1024,
              let data = Data(base64Encoded: base64), data.count <= 6 * 1024 * 1024,
              data.prefix(8) == Data([137, 80, 78, 71, 13, 10, 26, 10]),
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              (properties[kCGImagePropertyPixelWidth] as? Int) == pixels,
              (properties[kCGImagePropertyPixelHeight] as? Int) == pixels,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw PreviewFailure.renderFailed }
        return image
    }

    static func size(maximum: CGSize, minimum: CGSize, scale: CGFloat) throws -> (points: CGFloat, pixels: Int) {
        let dimensions = [maximum.width, maximum.height, minimum.width, minimum.height, scale]
        guard dimensions.allSatisfy({ $0.isFinite && $0 >= 0 }), scale > 0 else { throw PreviewFailure.invalid }
        let edge = min(maximum.width, maximum.height, 1024 / scale)
        guard edge > 0, edge >= max(minimum.width, minimum.height) else { throw PreviewFailure.tooLarge }
        return (edge, max(1, min(1024, Int(ceil(edge * scale)))))
    }
}
