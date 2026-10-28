import AppKit
import Foundation

/// Compile with the native sources (without the extension entry point) to inspect the actual controller.
/// Copy the same web resources into the harness app's Contents/Resources/web directory.
final class SmokeAppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow?
    var controller: PreviewViewController?
    func applicationDidFinishLaunching(_ notification: Notification) {
        let preview = PreviewViewController()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Trivor Quick Look Test"
        window.contentViewController = preview
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        controller = preview
        let path = CommandLine.arguments.dropFirst().first ?? Bundle.main.object(forInfoDictionaryKey: "SmokeFixturePath") as? String
        if let path { open(path) }
        NSApp.activate(ignoringOtherApps: true)
    }
    private func open(_ path: String) {
        controller?.preparePreviewOfFile(at: URL(fileURLWithPath: path)) { error in
            print(error == nil ? "PREVIEW_COMPLETED" : "PREVIEW_ERROR: \(error!)")
            fflush(stdout)
        }
    }
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        if let path = filenames.first { open(path) }
        sender.reply(toOpenOrPrint: .success)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let application = NSApplication.shared
let delegate = SmokeAppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
