import Foundation
import ImageIO
import WebKit

private final class ThumbnailMessageHandler: NSObject, WKScriptMessageHandler {
    weak var owner: ThumbnailRenderer?
    init(_ owner: ThumbnailRenderer) { self.owner = owner }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.receive(message)
    }
}

/// Owns a single bounded render. The WebView is deliberately never attached to a window.
/// All WebKit state and completion delivery stay on the main thread.
final class ThumbnailRenderer: NSObject, WKNavigationDelegate {
    private var webView: WKWebView?
    private var scheme: PreviewSchemeHandler?
    private var completion: ((Result<CGImage, Error>) -> Void)?
    private var deadline: DispatchWorkItem?
    private var didBoot = false
    private let id = UUID().uuidString
    private let pixels: Int
    private let resourceRoot: URL

    init(pixels: Int, resourceRoot: URL) {
        self.pixels = pixels
        self.resourceRoot = resourceRoot
    }

    func start(document: PreviewDocument, completion: @escaping (Result<CGImage, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard self.completion == nil, (1...1024).contains(pixels) else {
            completion(.failure(PreviewFailure.tooLarge))
            return
        }
        self.completion = completion
        let timeout = DispatchWorkItem { [weak self] in self?.finish(.failure(PreviewFailure.timedOut)) }
        deadline = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: timeout)
        let scheme = PreviewSchemeHandler(root: resourceRoot, document: document)
        self.scheme = scheme
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(scheme, forURLScheme: "trivor-preview")
        config.userContentController.add(ThumbnailMessageHandler(self), name: "thumbnail")
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: pixels, height: pixels), configuration: config)
        web.navigationDelegate = self
        webView = web
        web.load(URLRequest(url: URL(string: "trivor-preview://bundle/thumbnail.html")!))
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        guard completion != nil, message.webView === webView, message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "boot" {
            guard !didBoot, let web = webView else { return }
            didBoot = true
            let request: [String: Any] = ["url": "trivor-preview://bundle/model.glb", "name": "model.glb", "requestId": id, "size": pixels]
            web.callAsyncJavaScript("window.trivorThumbnail.render(request)", arguments: ["request": request], in: nil, in: .page) { [weak self] result in
                if case .failure = result { self?.finish(.failure(PreviewFailure.renderFailed)) }
            }
            return
        }
        guard body["requestId"] as? String == id else { return }
        if type == "error" {
            finish(.failure((body["code"] as? String).flatMap(PreviewFailure.init(rawValue:)) ?? .renderFailed))
        } else if type == "ready" {
            guard let base64 = body["png"] as? String else { finish(.failure(PreviewFailure.renderFailed)); return }
            do { finish(.success(try ThumbnailImage.decode(base64, pixels: pixels))) }
            catch { finish(.failure(error)) }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(webView === self.webView && navigationAction.targetFrame?.isMainFrame == true &&
            navigationAction.navigationType == .other &&
            navigationAction.request.url?.absoluteString == "trivor-preview://bundle/thumbnail.html" ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish(.failure(PreviewFailure.renderFailed)) }

    func cancel() { finish(.failure(PreviewFailure.cancelled)) }

    private func finish(_ result: Result<CGImage, Error>) {
        guard let callback = completion else { return }
        completion = nil
        deadline?.cancel()
        deadline = nil
        scheme?.cancelAll()
        scheme = nil
        let old = webView
        webView = nil
        old?.navigationDelegate = nil
        old?.configuration.userContentController.removeScriptMessageHandler(forName: "thumbnail")
        old?.stopLoading()
        callback(result)
    }
}
