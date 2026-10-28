import AppKit
import Foundation
import WebKit

enum IntegrationFailure: Error, CustomStringConvertible {
    case failed(String)
    var description: String { switch self { case .failed(let message): return message } }
}

/// Software integration tests inside the actual sandboxed WKWebView. Pointer
/// events below exercise the page's input handlers; they do not claim to test
/// the operating system's delivery of physical mouse events to Finder.
@MainActor
final class IntegrationApp: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var preview = PreviewViewController()
    private let status = NSTextField(wrappingLabelWithString: "Starting native integration tests…")
    private var observations: [[String: Any]] = []
    private var checks: [[String: Any]] = []
    private var callbacks = 0
    private var output: URL!
    private var lastState: [String: Any] = [:]
    private var hardwareBudget: PreviewBudgetSnapshot?

    func applicationDidFinishLaunching(_ notification: Notification) {
        output = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("TrivorQuickLookIntegration", isDirectory: true)
        try? FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let holder = NSViewController()
        holder.view = NSView(frame: NSRect(x: 0, y: 0, width: 800, height: 700))
        holder.addChild(preview)
        preview.view.frame = NSRect(x: 0, y: 100, width: 800, height: 600)
        preview.view.autoresizingMask = [.width, .height]
        holder.view.addSubview(preview.view)
        status.frame = NSRect(x: 16, y: 12, width: 768, height: 76)
        status.autoresizingMask = [.width]
        status.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        status.setAccessibilityIdentifier("integration-status")
        holder.view.addSubview(status)
        window = NSWindow(contentRect: holder.view.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Trivor Quick Look Integration"
        window.contentViewController = holder
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        Task { await run() }
    }

    private func children(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(children) }
    private var web: WKWebView? { children(preview.view).compactMap { $0 as? WKWebView }.first }
    private var nativeStatus: String { children(preview.view).compactMap { $0 as? NSTextField }.filter { !$0.isHidden }.map(\.stringValue).joined(separator: " ") }
    private func sleep(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
    private func require(_ condition: Bool, _ message: String) throws { if !condition { throw IntegrationFailure.failed(message) } }
    private func script(_ source: String, web: WKWebView) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            web.callAsyncJavaScript(source, arguments: [:], in: nil, in: .page) { result in continuation.resume(with: result) }
        }
    }
    private func state() async -> [String: Any] {
        guard let web else { return ["nativeStatus": nativeStatus, "web": false] }
        do {
            let value = try await script("""
                const m=document.querySelector('model-viewer'), r=m?.getBoundingClientRect();
                if(!window.__integrationErrors){window.__integrationErrors=[];window.addEventListener('error',e=>window.__integrationErrors.push(String(e.message)));window.addEventListener('unhandledrejection',e=>window.__integrationErrors.push(String(e.reason)));}
                return {document:document.readyState,visibility:document.visibilityState,body:document.body.innerText.slice(0,800),state:document.querySelector('#preview')?.dataset.state||'',budgetTier:document.querySelector('#preview')?.dataset.budgetTier||'',loaded:m?.loaded||false,modelCount:document.querySelectorAll('model-viewer').length,width:r?.width||0,height:r?.height||0,camera:m?{theta:m.getCameraOrbit().theta,phi:m.getCameraOrbit().phi,radius:m.getCameraOrbit().radius}:null,dimensions:m?.loaded?m.getDimensions():null,errors:window.__integrationErrors};
                """, web: web)
            var result = value as? [String: Any] ?? [:]
            result["nativeStatus"] = nativeStatus
            result["webHidden"] = web.isHidden
            result["inWindow"] = web.window != nil
            result["windowVisible"] = web.window?.isVisible ?? false
            result["nativeBudget"] = preview.currentBudget?.bridgeValue
            result["isPreparing"] = preview.isPreparing
            return result
        } catch { return ["evaluationError": String(describing: error), "nativeStatus": nativeStatus, "url": web.url?.absoluteString ?? ""] }
    }
    private func write(_ phase: String) {
        var result: [String: Any] = ["phase": phase, "checks": checks, "observations": observations, "lastState": lastState,
            "callbacks": callbacks, "processID": ProcessInfo.processInfo.processIdentifier,
            "updatedAt": ISO8601DateFormatter().string(from: Date()),
            "system": ProcessInfo.processInfo.operatingSystemVersionString, "output": output.path]
        let environment = PreviewEnvironment.shared
        result["hardware"] = ["physicalMemory": environment.hardware.physicalMemory,
            "recommendedWorkingSets": environment.hardware.recommendedWorkingSets,
            "memoryPressure": environment.pressure.state.rawValue, "thermal": PreviewThermalCondition.current().rawValue]
        result["hardwareBudget"] = hardwareBudget?.bridgeValue
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: output.appendingPathComponent("result.json"), options: .atomic) }
        status.stringValue = "\(phase) · \(checks.count) checks\n\(output.path)/result.json"
    }
    private func begin(_ name: String) {
        let url = Bundle.main.resourceURL!.appendingPathComponent("fixtures/\(name).glb")
        preview.preparePreviewOfFile(at: url) { [weak self] error in
            self?.callbacks += 1
            if let error { self?.observations.append(["completionError": String(describing: error), "fixture": name]) }
        }
    }
    private func ready(_ name: String, timeout: Double = 20) async throws -> WKWebView {
        let start = Date()
        var lastRecord = -1
        while Date().timeIntervalSince(start) < timeout {
            lastState = await state()
            let second = Int(Date().timeIntervalSince(start))
            if second != lastRecord && [0, 1, 3, 7, 12, 18].contains(second) {
                observations.append(["fixture": name, "elapsed": second, "state": lastState]); lastRecord = second; write("Loading \(name)")
            }
            if lastState["state"] as? String == "ready", lastState["loaded"] as? Bool == true, !preview.isPreparing, let web {
                try require(lastState["budgetTier"] as? String == preview.currentBudget?.tier.rawValue, "\(name): WebKit did not use the native budget snapshot")
                return web
            }
            if !nativeStatus.isEmpty && (nativeStatus.contains("无法") || nativeStatus.contains("超出") || nativeStatus.contains("上限") || nativeStatus.contains("exceed") || nativeStatus.contains("too long")) { break }
            await sleep(0.15)
        }
        throw IntegrationFailure.failed("\(name) did not render: \(lastState)")
    }
    private func checkPixels(_ web: WKWebView, name: String) async throws {
        let result = try await script("""
            const m=document.querySelector('model-viewer'), url=m.toDataURL();
            return {url,dimensions:m.getDimensions()};
            """, web: web) as? [String: Any] ?? [:]
        let dimensions = result["dimensions"] as? [String: Double] ?? [:]
        for (key, expected) in [("x",2.0),("y",1.2),("z",0.8)] { try require(abs((dimensions[key] ?? -10) - expected) < 0.03, "\(name): wrong \(key) dimension") }
        guard let url = result["url"] as? String, let encoded = url.split(separator: ",").last,
              let data = Data(base64Encoded: String(encoded)), let bitmap = NSBitmapImageRep(data: data) else { throw IntegrationFailure.failed("\(name): no canvas PNG") }
        var colored = 0
        for y in stride(from: 0, to: bitmap.pixelsHigh, by: 4) {
            for x in stride(from: 0, to: bitmap.pixelsWide, by: 4) {
                if let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) {
                    if color.alphaComponent > 0.2 && max(color.redComponent, color.greenComponent, color.blueComponent) - min(color.redComponent, color.greenComponent, color.blueComponent) > 0.15 { colored += 1 }
                }
            }
        }
        try require(colored > 100, "\(name): canvas had no model pixels")
        try data.write(to: output.appendingPathComponent("\(name).png"))
        checks.append(["name": "render-\(name)", "passed": true, "coloredSamples": colored, "width": bitmap.pixelsWide, "height": bitmap.pixelsHigh])
        write("PASS render \(name)")
    }
    private func interactions(_ web: WKWebView) async throws {
        let result = try await script("""
            const m=document.querySelector('model-viewer'), input=m.shadowRoot.querySelector('.userInput'), r=input.getBoundingClientRect();
            const camera=()=>{const c=m.getCameraOrbit();return {theta:c.theta,phi:c.phi,radius:c.radius}};
            const wait=()=>new Promise(resolve=>setTimeout(resolve,350));
            const initial=camera(), x=r.left+r.width*.4,y=r.top+r.height*.5;
            input.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:7,pointerType:'mouse',isPrimary:true,button:0,buttons:1,clientX:x,clientY:y}));
            for(let i=1;i<=8;i++)input.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:7,pointerType:'mouse',isPrimary:true,button:-1,buttons:1,clientX:x+i*12,clientY:y+i*4}));
            input.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:7,pointerType:'mouse',isPrimary:true,button:0,buttons:0,clientX:x+96,clientY:y+32}));
            await wait();const rotated=camera();
            document.querySelector('#fit').click();await wait();const fitted=camera();
            input.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-150,deltaMode:0,clientX:x,clientY:y}));
            await wait();const zoomed=camera();
            document.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'f'}));await wait();const reset=camera();
            return {initial,rotated,fitted,zoomed,reset};
            """, web: web) as? [String: [String: Double]] ?? [:]
        func value(_ phase: String, _ key: String) -> Double { result[phase]?[key] ?? .nan }
        try require(abs(value("rotated", "theta") - value("initial", "theta")) > 0.1, "PointerEvent drag did not rotate: \(result)")
        try require(abs(value("fitted", "theta") - value("initial", "theta")) < 0.01, "Fit did not restore rotation")
        try require(value("zoomed", "radius") < value("initial", "radius") * 0.98, "WheelEvent did not zoom")
        try require(abs(value("reset", "radius") - value("initial", "radius")) < 0.01, "F did not restore zoom")
        checks.append(["name": "native-webkit-pointer-wheel-fit", "passed": true, "cameras": result]); write("PASS native WebKit interaction path")
    }
    private func errorFixture(_ name: String, fragments: [String], required: [String] = []) async throws {
        begin(name)
        for _ in 0..<50 {
            if fragments.contains(where: nativeStatus.contains) {
                try require(required.allSatisfy(nativeStatus.contains), "\(name): missing structured limit details in \(nativeStatus)")
                if name == "budget" {
                    guard let failure = preview.limitFailure, let budget = preview.currentBudget else { throw IntegrationFailure.failed("Missing native budget evidence") }
                    try require(failure.limit == budget.limits.dictionary[failure.metric.rawValue] && failure.actual > failure.limit,
                                "Native limit error does not match selected hardware budget")
                    observations.append(["budgetFailure": ["metric": failure.metric.rawValue, "actual": failure.actual, "limit": failure.limit], "budget": budget.bridgeValue])
                }
                checks.append(["name": "reject-\(name)", "passed": true, "message": nativeStatus]); write("PASS reject \(name)"); return
            }
            await sleep(0.1)
        }
        lastState = await state()
        throw IntegrationFailure.failed("\(name): expected rejection containing \(fragments), got \(lastState)")
    }
    private func pressureChecks() async throws {
        // This monitor is isolated to the test controller. No system memory
        // pressure is generated and no live extension's pressure is changed.
        let monitor = PreviewMemoryPressureMonitor(startSystemMonitoring: false)
        let gib: UInt64 = 1024 * 1024 * 1024
        let environment = PreviewEnvironment(hardware: PreviewHardwareSnapshot(physicalMemory: 64 * gib, recommendedWorkingSets: [64 * gib]),
            pressure: monitor, thermal: { .nominal })
        guard let parent = preview.parent else { throw IntegrationFailure.failed("Missing test view parent") }
        let frame = preview.view.frame
        preview.view.removeFromSuperview()
        preview.removeFromParent()
        let replacement = PreviewViewController()
        replacement.environment = environment
        parent.addChild(replacement)
        replacement.view.frame = frame
        replacement.view.autoresizingMask = [.width, .height]
        parent.view.addSubview(replacement.view, positioned: .below, relativeTo: status)
        preview = replacement

        begin("cube")
        let visible = try await ready("pressure-baseline")
        try require(preview.currentBudget == .maximum && !preview.isPreparing, "Initial injected hardware budget did not settle")
        monitor.receive(.critical)
        await sleep(0.1)
        try require(web === visible && nativeStatus.isEmpty && !preview.isPreparing, "Critical pressure disposed an already-ready preview")
        checks.append(["name": "pressure-preserves-ready-model", "passed": true])

        let beforeRejected = callbacks
        begin("cube")
        try require(callbacks == beforeRejected + 1 && !preview.isPreparing && web == nil &&
            (nativeStatus.contains("内存压力") || nativeStatus.contains("memory pressure")), "Critical pressure did not reject a new request exactly once")
        checks.append(["name": "pressure-rejects-new-requests", "passed": true])

        for phase in ["reading", "boot", "loading"] {
            monitor.receive(.normal)
            let before = callbacks
            begin("ktx2")
            for _ in 0..<2000 {
                if preview.preparationPhase == phase { break }
                await sleep(0.001)
            }
            try require(preview.preparationPhase == phase && preview.isPreparing, "Could not reach \(phase) for pressure cancellation")
            let snapshot = preview.currentBudget
            monitor.receive(.warning)
            try require(preview.currentBudget == snapshot && preview.isPreparing, "Warning changed an in-flight snapshot")
            monitor.receive([.critical, .warning, .normal])
            await sleep(0.15)
            try require(!preview.isPreparing && web == nil && callbacks == before + 1 &&
                (nativeStatus.contains("内存压力") || nativeStatus.contains("memory pressure")), "Critical pressure failed to cancel \(phase), or a stale callback replaced its reason")
            monitor.receive(.normal)
            await sleep(0.1)
            try require(!preview.isPreparing && web == nil && callbacks == before + 1, "Normal pressure resurrected the cancelled \(phase) task")
            checks.append(["name": "pressure-cancels-\(phase)-once", "passed": true])
        }

        monitor.receive(.warning)
        begin("cube")
        try require(preview.currentBudget == .standard, "Warning did not select standard for a new request")
        _ = try await ready("pressure-warning")
        checks.append(["name": "pressure-warning-standard-budget", "passed": true])
        monitor.receive(.normal)
        begin("cube")
        try require(preview.currentBudget == .maximum, "Normal pressure did not restore hardware selection for a new request")
        let recovered = try await ready("pressure-recovery")
        try await checkPixels(recovered, name: "pressure-recovery")
        checks.append(["name": "pressure-new-request-recovers", "passed": true])
    }
    private func run() async {
        // WebKit suppresses RAF in an occluded window. Keep the real test view
        // visible while other development tools have focus, then restore the
        // ordinary window as soon as this run completes or fails.
        let collectionBehavior = window.collectionBehavior
        window.level = .floating
        window.collectionBehavior.formUnion([.canJoinAllSpaces, .fullScreenAuxiliary])
        defer {
            window.level = .normal
            window.collectionBehavior = collectionBehavior
        }
        do {
            for name in ["cube", "meshopt", "draco", "ktx2"] {
                begin(name)
                if hardwareBudget == nil { hardwareBudget = preview.currentBudget }
                let web = try await ready(name)
                try await checkPixels(web, name: name)
                if name == "cube" { try await interactions(web) }
            }
            try await errorFixture("broken", fragments: ["GLB"])
            try await errorFixture("external", fragments: ["外部", "external resources"])
            try await errorFixture("budget", fragments: ["几何", "geometry"], required: ["MiB", "Trivor"])
            for i in 0..<20 { begin(i % 2 == 0 ? "broken" : "cube") }
            begin("cube")
            let finalWeb = try await ready("replacement")
            try await checkPixels(finalWeb, name: "replacement")
            try require(callbacks == 28, "Expected exactly one preparation callback for each of 28 requests, got \(callbacks)")
            checks.append(["name": "rapid-replacement-and-error-recovery", "passed": true, "requests": 21])
            try await pressureChecks()
            try require(callbacks == 35, "Expected exactly one callback for each of 35 total requests, got \(callbacks)")
            write("PASS — all native integration checks")
        } catch {
            checks.append(["name": "failure", "passed": false, "error": String(describing: error)])
            write("FAIL — inspect result.json")
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let delegate = IntegrationApp()
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    withExtendedLifetime(delegate) { application.run() }
}
