import AppKit
import Foundation
import QuickLookUI
import WebKit

private final class PreviewCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return value }
    func cancel() { lock.lock(); value = true; lock.unlock() }
}

private final class WeakPreviewMessageHandler: NSObject, WKScriptMessageHandler {
    weak var owner: PreviewViewController?
    init(owner: PreviewViewController) { self.owner = owner }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.receive(message)
    }
}

@objc(PreviewViewController)
final class PreviewViewController: NSViewController, QLPreviewingController, WKNavigationDelegate {
    private var webView: WKWebView?
    private var scheme: PreviewSchemeHandler?
    private var statusLabel: NSTextField?
    private var completion: ((Error?) -> Void)?
    private var deadline: DispatchWorkItem?
    private var cancellation: PreviewCancellation?
    private var requestID: String?
    private var pressureObserver: UUID?
    private(set) var isPreparing = false
    private(set) var currentBudget: PreviewBudgetSnapshot?
    private(set) var limitFailure: PreviewLimitFailure?
    var preparationPhase: String {
        guard isPreparing else { return "settled" }
        return webView == nil ? "reading" : didBoot ? "loading" : "boot"
    }
    // Native tests can inject an isolated environment before the first request.
    var environment: PreviewEnvironmentProviding = PreviewEnvironment.shared {
        didSet { precondition(pressureObserver == nil, "Set the environment before preparing a preview") }
    }
    private var name = ""
    private var didBoot = false
    private var locale: String { Locale.preferredLanguages.first ?? "en" }

    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        view.wantsLayer = true
        preferredContentSize = NSSize(width: 800, height: 600)
        showStatus(locale.hasPrefix("zh") ? "正在准备模型预览…" : "Preparing model preview…")
    }

    func preparePreviewOfFile(at url: URL, completionHandler handler: @escaping (Error?) -> Void) {
        _ = view
        cancelCurrent()
        if pressureObserver == nil {
            pressureObserver = environment.observePressure { [weak self] pressure in
                guard let self, pressure == .critical, self.isPreparing else { return }
                self.fail(.memoryPressure)
            }
        }
        let id = UUID().uuidString
        let token = PreviewCancellation()
        requestID = id
        cancellation = token
        completion = handler
        isPreparing = true
        didBoot = false
        showStatus(locale.hasPrefix("zh") ? "正在准备模型预览…" : "Preparing model preview…")
        let budget: PreviewBudgetSnapshot
        do { budget = try environment.budgetForNewRequest() }
        catch { fail(error as? PreviewFailure ?? .memoryPressure); return }
        currentBudget = budget
        let timeout = DispatchWorkItem { [weak self] in
            guard let self, self.requestID == id, self.isPreparing else { return }
            self.fail(.timedOut)
        }
        deadline = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Result { try PreviewDocument.read(url, budget: budget, isCancelled: { token.isCancelled }) }
            DispatchQueue.main.async {
                guard let self, self.requestID == id, !token.isCancelled else { return }
                switch result {
                case .success(let document): self.installWebView(document)
                case .failure(let error):
                    if let limit = error as? PreviewLimitFailure { self.fail(limit) }
                    else { self.fail(error as? PreviewFailure ?? .unreadable) }
                }
            }
        }
        // Quick Look does not present this controller until its completion is called.
        // Publish the native progress view now: WebKit's first animation frame requires
        // a presented view, so waiting for rendered-ready here would prevent progress.
        // The separate rendering deadline remains active until ready, failure or replacement.
        completePreparation(nil)
    }

    private func installWebView(_ document: PreviewDocument) {
        guard let resourceRoot = Bundle(for: Self.self).resourceURL?.appendingPathComponent("web", isDirectory: true),
              FileManager.default.fileExists(atPath: resourceRoot.appendingPathComponent("index.html").path) else {
            fail(.renderFailed)
            return
        }
        name = document.name
        let handler = PreviewSchemeHandler(root: resourceRoot, document: document)
        scheme = handler
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(handler, forURLScheme: "trivor-preview")
        configuration.userContentController.add(WeakPreviewMessageHandler(owner: self), name: "preview")
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let web = WKWebView(frame: view.bounds, configuration: configuration)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        // WebKit/model-viewer must remain visible so intersection observers and RAF can produce the first frame.
        // The native status label stays above it until the rendered-ready message arrives.
        web.isHidden = false
        view.addSubview(web, positioned: .below, relativeTo: statusLabel)
        webView = web
        web.load(URLRequest(url: URL(string: "trivor-preview://bundle/index.html")!))
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        guard message.webView === webView, message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any], let type = body["type"] as? String,
              let id = requestID, cancellation?.isCancelled == false else { return }
        if type == "boot" {
            guard !didBoot, let web = webView, let budget = currentBudget else { return }
            didBoot = true
            let model: [String: Any] = ["url": "trivor-preview://bundle/model.glb", "name": name, "locale": locale, "requestId": id, "budget": budget.bridgeValue]
            web.callAsyncJavaScript("window.trivorQuickLook.loadModel(model)", arguments: ["model": model], in: nil, in: .page) { [weak self] result in
                guard let self, self.requestID == id, self.isPreparing, self.cancellation?.isCancelled == false else { return }
                if case .failure = result { self.fail(.renderFailed) }
            }
        } else if body["requestId"] as? String == id {
            if type == "ready" {
                statusLabel?.isHidden = true
                webView?.isHidden = false
                finish(nil)
            } else if type == "error" {
                let failure = (body["code"] as? String).flatMap(PreviewFailure.init(rawValue:)) ?? .renderFailed
                if let limit = PreviewLimitFailure(bridge: body) { fail(limit) }
                else { fail(failure) }
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard webView === self.webView,
              navigationAction.targetFrame?.isMainFrame == true,
              navigationAction.request.url?.absoluteString == "trivor-preview://bundle/index.html",
              navigationAction.navigationType == .other else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if webView === self.webView { fail(.renderFailed) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if webView === self.webView { fail(.renderFailed) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === self.webView { fail(.renderFailed) }
    }

    private func showStatus(_ text: String) {
        let label: NSTextField
        if let existing = statusLabel { label = existing } else {
            label = NSTextField(wrappingLabelWithString: text)
            label.translatesAutoresizingMaskIntoConstraints = false
            label.alignment = .center
            label.font = .systemFont(ofSize: 15)
            label.textColor = .secondaryLabelColor
            label.setAccessibilityIdentifier("quick-look-status")
            view.addSubview(label)
            NSLayoutConstraint.activate([
                label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
                label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
                label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -32),
                label.widthAnchor.constraint(lessThanOrEqualToConstant: 480)
            ])
            statusLabel = label
        }
        label.stringValue = text
        label.isHidden = false
    }

    private func fail(_ failure: PreviewFailure) {
        showFailure(failure.message(locale: locale))
    }

    private func fail(_ failure: PreviewLimitFailure) {
        limitFailure = failure
        showFailure(failure.message(locale: locale))
    }

    private func showFailure(_ message: String) {
        cancellation?.cancel()
        removeWebView()
        showStatus(message)
        // A completed native error view gives Quick Look useful localized guidance.
        finish(nil)
    }

    private func finish(_ error: Error?) {
        isPreparing = false
        deadline?.cancel()
        deadline = nil
        completePreparation(error)
    }

    private func completePreparation(_ error: Error?) {
        let callback = completion
        completion = nil
        callback?(error)
    }

    private func removeWebView() {
        scheme?.cancelAll()
        scheme = nil
        let old = webView
        webView = nil
        old?.navigationDelegate = nil
        old?.configuration.userContentController.removeScriptMessageHandler(forName: "preview")
        old?.stopLoading()
        old?.removeFromSuperview()
    }

    private func cancelCurrent() {
        requestID = nil
        currentBudget = nil
        limitFailure = nil
        cancellation?.cancel()
        cancellation = nil
        removeWebView()
        finish(CocoaError(.userCancelled))
    }

    // Quick Look can temporarily detach this view and show the same controller again without
    // another prepare callback. Keep its content until replacement or deallocation; WebKit's
    // visibility handling suspends the hidden view, and unfinished loads retain the 30s deadline.
    deinit {
        cancellation?.cancel()
        deadline?.cancel()
        completion?(CocoaError(.userCancelled))
        let oldWebView = webView
        let oldScheme = scheme
        let observer = pressureObserver
        let environment = environment
        DispatchQueue.main.async {
            if let observer { environment.removePressureObserver(observer) }
            oldScheme?.cancelAll()
            oldWebView?.navigationDelegate = nil
            oldWebView?.configuration.userContentController.removeScriptMessageHandler(forName: "preview")
            oldWebView?.stopLoading()
        }
    }
}
