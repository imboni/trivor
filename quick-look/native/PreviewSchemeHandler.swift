import Foundation
import WebKit

/// Task cancellation and completion both run on the main thread, like WKURLSchemeHandler callbacks.
final class PreviewSchemeHandler: NSObject, WKURLSchemeHandler {
    private static let bundledResourceMaximumBytes = 64 * 1024 * 1024
    private let root: URL
    private let document: PreviewDocument
    private let delivery = PreviewTaskDelivery()

    init(root: URL, document: PreviewDocument) {
        self.root = root
        self.document = document
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let identifier = ObjectIdentifier(urlSchemeTask)
        delivery.begin(identifier)
        let request = urlSchemeTask.request
        guard let url = request.url, request.httpMethod == nil || request.httpMethod == "GET" else {
            delivery.fail(identifier) { urlSchemeTask.didFailWithError(URLError(.unsupportedURL)) }
            return
        }
        let root = self.root
        let modelData = document.data
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result: Result<Data, Error> = Result {
                switch try PreviewResource.resolve(url, root: root) {
                case .model: return modelData
                case .bundled(let file):
                    let values = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                    guard values.isRegularFile == true,
                          let size = values.fileSize, size <= Self.bundledResourceMaximumBytes else { throw PreviewFailure.unreadable }
                    return try Data(contentsOf: file)
                }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let data):
                    let headers = [
                        "Content-Type": PreviewResource.mimeType(for: url),
                        "Content-Length": String(data.count),
                        "Access-Control-Allow-Origin": "*",
                        "Cache-Control": "no-store"
                    ]
                    let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
                    self.delivery.send(identifier, data: data,
                        response: { urlSchemeTask.didReceive(response) },
                        receive: { urlSchemeTask.didReceive($0) },
                        finish: { urlSchemeTask.didFinish() })
                case .failure:
                    self.delivery.fail(identifier) { urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)) }
                }
            }
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        delivery.stop(ObjectIdentifier(urlSchemeTask))
    }

    func cancelAll() {
        delivery.cancelAll()
    }
}
