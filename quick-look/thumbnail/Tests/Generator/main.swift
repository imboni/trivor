import AppKit
import Foundation
import QuickLookThumbnailing

// This command asks the OS for its real registered provider. It rejects fallback
// file-type icons even if those icons happen to contain nontransparent pixels.
guard CommandLine.arguments.count >= 2 else {
    fputs("Usage: TrivorThumbnailGeneratorTests /path/model.glb [pixels=256] [scale=1] [output-directory]\n", stderr)
    exit(2)
}
let file = URL(fileURLWithPath: CommandLine.arguments[1])
let pixels = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2]) ?? 0 : 256
let scale = CommandLine.arguments.count > 3 ? Double(CommandLine.arguments[3]) ?? 0 : 1
guard (32...1024).contains(pixels), scale.isFinite, scale > 0, scale <= 4 else { fputs("Invalid size or scale\n", stderr); exit(2) }
let output = CommandLine.arguments.count > 4 ? URL(fileURLWithPath: CommandLine.arguments[4], isDirectory: true) : FileManager.default.temporaryDirectory.appendingPathComponent("trivor-thumbnail-generator-tests", isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let pointSize = Double(pixels) / scale
let request = QLThumbnailGenerator.Request(fileAt: file, size: CGSize(width: pointSize, height: pointSize), scale: scale, representationTypes: .thumbnail)
request.iconMode = false
request.minimumDimension = pointSize
let generator = QLThumbnailGenerator.shared
var completed = false
let name = "\(file.deletingPathExtension().lastPathComponent)-\(pixels)-\(String(format: "%g", scale))x"
func finish(_ representation: QLThumbnailRepresentation?, _ error: Error?) {
    guard !completed else { return }
    completed = true
    do {
        if let error { throw error }
        guard let representation else { throw ThumbnailTestFailure.failed("OS returned no representation") }
        try thumbnailRequire(representation.type == .thumbnail, "OS returned a fallback type \(representation.type.rawValue), not a thumbnail")
        // Keep the actual OS image even if its framing assertion fails.
        try saveThumbnail(representation.cgImage, to: output.appendingPathComponent("\(name).png"))
        var metrics = try thumbnailPixels(representation.cgImage, expectedSize: pixels)
        metrics["representationType"] = representation.type.rawValue
        metrics["source"] = file.path
        metrics["scale"] = scale
        metrics["phase"] = "passed"
        try writeThumbnailTestReport(metrics, to: output.appendingPathComponent("\(name).json"))
        print("PASS actual QLThumbnailGenerator type=thumbnail \(pixels)px @\(scale)x: \(output.appendingPathComponent("\(name).json").path)")
        fflush(stdout)
        exit(0)
    } catch {
        try? writeThumbnailTestReport(["phase": "failed", "source": file.path, "error": String(describing: error)], to: output.appendingPathComponent("\(name).json"))
        print("FAIL actual QLThumbnailGenerator: \(error)")
        fflush(stdout)
        exit(1)
    }
}
generator.generateBestRepresentation(for: request) { representation, error in
    DispatchQueue.main.async { finish(representation, error) }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
    guard !completed else { return }
    generator.cancel(request)
    finish(nil, ThumbnailTestFailure.failed("Actual provider exceeded 30 seconds"))
}
app.run()
