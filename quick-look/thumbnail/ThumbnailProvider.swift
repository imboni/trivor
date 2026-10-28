import Foundation
import QuickLookThumbnailing

@objc(ThumbnailProvider)
final class ThumbnailProvider: QLThumbnailProvider {
    override func provideThumbnail(for request: QLFileThumbnailRequest, _ handler: @escaping (QLThumbnailReply?, Error?) -> Void) {
        DispatchQueue.main.async {
            do {
                let size = try ThumbnailImage.size(maximum: request.maximumSize, minimum: request.minimumSize, scale: request.scale)
                ThumbnailQueue.shared.enqueue(url: request.fileURL, pixels: size.pixels) { result in
                    switch result {
                    case .success(let image):
                        let reply = QLThumbnailReply(contextSize: CGSize(width: size.points, height: size.points)) { context in
                            // Quick Look scales the bitmap's pixel dimensions,
                            // not this Core Graphics drawing block's coordinates.
                            // Use the full bitmap even for Retina/fractional scale.
                            guard context.width > 0, context.height > 0 else { return false }
                            let bounds = context.convertToUserSpace(CGRect(x: 0, y: 0, width: context.width, height: context.height))
                            context.interpolationQuality = .high
                            context.draw(image, in: bounds)
                            return true
                        }
                        handler(reply, nil)
                    case .failure(let error): handler(nil, error)
                    }
                }
            } catch { handler(nil, error) }
        }
    }
}

extension ThumbnailRenderer: ThumbnailRenderOperation {}

private extension ThumbnailQueue {
    static let shared = ThumbnailQueue { pixels in
        guard let root = Bundle(for: ThumbnailProvider.self).resourceURL?.appendingPathComponent("web", isDirectory: true) else {
            throw PreviewFailure.renderFailed
        }
        return ThumbnailRenderer(pixels: pixels, resourceRoot: root)
    }
}
