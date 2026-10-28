import AppKit
import Foundation
import WebKit

@MainActor
final class NativeThumbnailTests {
    private let resources = Bundle.main.resourceURL!
    private let output = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("TrivorThumbnailNativeTests", isDirectory: true)
    private var checks: [[String: Any]] = []
    private var released: [WeakRenderer] = []
    private var inspectedRenderers = 0
    private var rendererWindowErrors: [String] = []
    private final class WeakRenderer { weak var value: ThumbnailRenderer?; init(_ value: ThumbnailRenderer) { self.value = value } }
    private func wait(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
    private func document(_ name: String) throws -> PreviewDocument { try PreviewDocument.read(resources.appendingPathComponent("fixtures/\(name).glb")) }

    private func render(_ name: String, pixels: Int) async throws -> CGImage {
        let document = try document(name)
        let renderer = ThumbnailRenderer(pixels: pixels, resourceRoot: resources.appendingPathComponent("web"))
        released.append(WeakRenderer(renderer))
        return try await withCheckedThrowingContinuation { continuation in
            // Retain only until completion; the production renderer itself is not its owner.
            retained.append(renderer)
            renderer.start(document: document) { result in continuation.resume(with: result) }
            inspectWindow(renderer)
        }
    }
    private func inspectWindow(_ renderer: ThumbnailRenderer) {
        // Observe the production renderer's private stored view without changing
        // product visibility or attaching a test-only rendering window.
        guard let storage = Mirror(reflecting: renderer).children.first(where: { $0.label == "webView" }),
              let view = Mirror(reflecting: storage.value).children.first?.value as? WKWebView else {
            rendererWindowErrors.append("No live production WKWebView immediately after start")
            return
        }
        inspectedRenderers += 1
        if view.window != nil { rendererWindowErrors.append("Production WKWebView has a window") }
    }
    private var retained: [ThumbnailRenderer] = []
    private func releaseFinished() {
        retained.removeAll()
    }

    private func record(_ check: [String: Any]) throws {
        checks.append(check)
        try writeThumbnailTestReport(["phase": "running", "checks": checks, "processID": ProcessInfo.processInfo.processIdentifier,
            "system": ProcessInfo.processInfo.operatingSystemVersionString], to: output.appendingPathComponent("result.json"))
        print("PASS \(check["name"] ?? "check")")
        fflush(stdout)
    }
    private func rejected(_ name: String, code: PreviewFailure) async throws {
        do {
            _ = try await render(name, pixels: 128)
            releaseFinished()
            throw ThumbnailTestFailure.failed("Expected \(name) to fail with \(code.rawValue)")
        } catch let error as PreviewFailure {
            releaseFinished()
            try thumbnailRequire(error == code, "\(name): expected \(code.rawValue), got \(error.rawValue)")
            try record(["name": "reject-\(name)", "code": error.rawValue])
        }
    }
    private func cancelled() async throws {
        let document = try document("cube")
        var renderer: ThumbnailRenderer? = ThumbnailRenderer(pixels: 512, resourceRoot: resources.appendingPathComponent("web"))
        weak var releasedRenderer = renderer
        var callbacks = 0
        var code: PreviewFailure?
        renderer!.start(document: document) { result in
            callbacks += 1
            if case .failure(let error) = result { code = error as? PreviewFailure }
        }
        inspectWindow(renderer!)
        renderer!.cancel()
        renderer!.cancel()
        renderer = nil
        await wait(0.5)
        try thumbnailRequire(callbacks == 1 && code == .cancelled, "Cancel must complete exactly once with cancelled; count=\(callbacks), code=\(String(describing: code))")
        try thumbnailRequire(releasedRenderer == nil, "Cancelled renderer was retained")
        try record(["name": "cancel-completes-once-and-releases", "callbacks": callbacks])
    }

    func run() async {
        do {
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            for (name, size) in [("cube",64),("cube",512),("meshopt",128),("draco",256),("ktx2",256),("ktx2",1024)] {
                let image = try await render(name, pixels: size)
                releaseFinished()
                var metrics = try thumbnailPixels(image, expectedSize: size)
                metrics["name"] = "\(name)-\(size)"
                try saveThumbnail(image, to: output.appendingPathComponent("\(name)-\(size).png"))
                try record(metrics)
            }
            try await rejected("broken", code: .invalid)
            try await rejected("external", code: .externalResources)
            try await rejected("budget", code: .tooLarge)
            try await cancelled()
            for index in 0..<12 {
                let image = try await render(index % 2 == 0 ? "cube" : "meshopt", pixels: 64)
                releaseFinished()
                _ = try thumbnailPixels(image, expectedSize: 64)
            }
            await wait(0.5)
            try thumbnailRequire(released.allSatisfy { $0.value == nil }, "A finished renderer is retained")
            try record(["name": "sequential-workload-and-release", "renders": 12, "liveRenderers": released.filter { $0.value != nil }.count])
            try thumbnailRequire(rendererWindowErrors.isEmpty && inspectedRenderers == released.count + 1, "Windowless renderer inspection failed: count=\(inspectedRenderers), errors=\(rendererWindowErrors)")
            try record(["name": "actual-renderer-views-have-no-window", "inspectedRenderers": inspectedRenderers, "attachedWindows": 0])
            // WebKit/AppKit can create hidden internal text-input windows. No
            // renderer view is attached to a window and none may become visible.
            let windows = NSApp.windows.map { ["class": String(describing: type(of: $0)), "visible": $0.isVisible, "title": $0.title] as [String: Any] }
            try thumbnailRequire(NSApp.windows.allSatisfy { !$0.isVisible }, "Windowless test unexpectedly displayed a window: \(windows)")
            try writeThumbnailTestReport(["phase": "passed", "checks": checks, "visibleWindowCount": NSApp.windows.filter { $0.isVisible }.count, "appKitWindows": windows,
                "system": ProcessInfo.processInfo.operatingSystemVersionString, "output": output.path], to: output.appendingPathComponent("result.json"))
            print("PASS all \(checks.count) windowless thumbnail checks. Report: \(output.appendingPathComponent("result.json").path)")
            fflush(stdout)
            exit(0)
        } catch {
            releaseFinished()
            try? writeThumbnailTestReport(["phase": "failed", "checks": checks, "error": String(describing: error), "output": output.path], to: output.appendingPathComponent("result.json"))
            print("FAIL \(error). Report: \(output.appendingPathComponent("result.json").path)")
            fflush(stdout)
            exit(1)
        }
    }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    application.setActivationPolicy(.prohibited)
    let tests = NativeThumbnailTests()
    Task { await tests.run() }
    withExtendedLifetime(tests) { application.run() }
}
