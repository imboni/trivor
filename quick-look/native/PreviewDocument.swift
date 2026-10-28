import Foundation
import CoreFoundation

enum PreviewFailure: String, Error {
    case tooLarge, invalid, externalResources, unsupported, renderFailed, timedOut, unreadable, cancelled, memoryPressure

    func message(locale: String) -> String {
        let chinese = locale.lowercased().hasPrefix("zh")
        switch self {
        case .tooLarge:
            return chinese ? "此模型超出快速预览的大小或复杂度限制。请用 Trivor 打开。" : "This model exceeds the size or complexity limit for Quick Look. Open it in Trivor."
        case .externalResources:
            return chinese ? "此模型引用了外部资源。请用 Trivor 打开，或先导出为自包含 GLB。" : "This model references external resources. Open it in Trivor, or export a self-contained GLB first."
        case .unsupported:
            return chinese ? "快速预览暂不支持此模型的内容。请用 Trivor 打开。" : "Quick Look does not support this model's content yet. Open it in Trivor."
        case .invalid:
            return chinese ? "无法读取此 GLB 模型，文件可能已损坏或不完整。" : "This GLB model could not be read. The file may be damaged or incomplete."
        case .timedOut:
            return chinese ? "快速预览准备时间过长。请用 Trivor 打开此模型。" : "The preview took too long to prepare. Open this model in Trivor."
        case .unreadable:
            return chinese ? "无法访问此模型文件。请确认文件仍然存在且已下载到本机。" : "The model file could not be accessed. Check that it still exists and is downloaded to this Mac."
        case .cancelled:
            return chinese ? "预览已取消。" : "Preview cancelled."
        case .memoryPressure:
            return chinese ? "系统内存压力较高，已停止准备快速预览。请稍后重试，或用 Trivor 打开。" : "System memory pressure is high, so preparing this preview has stopped. Try again later, or open it in Trivor."
        case .renderFailed:
            return chinese ? "无法显示此模型的快速预览。请用 Trivor 打开。" : "The model preview could not be displayed. Open it in Trivor."
        }
    }
}

/// Background thumbnails keep the smaller envelope. Interactive previews may
/// use more memory because only the model the user opens is being prepared.
enum PreviewBudgetProfile {
    case thumbnail, preview

    var snapshot: PreviewBudgetSnapshot { self == .preview ? .standard : .thumbnail }
    var maximumBytes: Int { snapshot.limits.file }
    var maximumJSONBytes: Int { snapshot.limits.json }
}

enum PreviewBudgetTier: String, CaseIterable {
    case standard, expanded, large, maximum
}

struct PreviewBudgetLimits: Equatable {
    let file: Int, json: Int, geometry: Int, textures: Int, decoded: Int
    let triangles: Int, draws: Int, nodes: Int
    let depth: Int, animationChannels: Int, animationSamplers: Int, animationTracks: Int

    var dictionary: [String: Int] {
        ["file": file, "json": json, "geometry": geometry, "textures": textures, "decoded": decoded,
         "triangles": triangles, "draws": draws, "nodes": nodes, "depth": depth,
         "animationChannels": animationChannels, "animationSamplers": animationSamplers, "animationTracks": animationTracks]
    }

    func clampingDecoded(to maximum: Int) -> PreviewBudgetLimits {
        precondition(maximum > 0)
        return PreviewBudgetLimits(file: file, json: json, geometry: min(geometry, maximum), textures: min(textures, maximum),
            decoded: min(decoded, maximum), triangles: triangles, draws: draws, nodes: nodes, depth: depth,
            animationChannels: animationChannels, animationSamplers: animationSamplers, animationTracks: animationTracks)
    }
}

/// Captured once per request. File reads and the WebKit boot message share this
/// exact value even if thermal or pressure conditions change during preparation.
struct PreviewBudgetSnapshot: Equatable {
    let tier: PreviewBudgetTier
    let limits: PreviewBudgetLimits
    var bridgeValue: [String: Any] { ["tier": tier.rawValue, "limits": limits.dictionary] }

    private static func limits(file: Int, json: Int, allocation: Int, decoded: Int, triangles: Int, draws: Int, nodes: Int) -> PreviewBudgetLimits {
        let mib = 1024 * 1024
        return PreviewBudgetLimits(file: file * mib, json: json * mib, geometry: allocation * mib, textures: allocation * mib,
            decoded: decoded * mib, triangles: triangles, draws: draws, nodes: nodes,
            depth: 128, animationChannels: 4096, animationSamplers: 4096, animationTracks: 8192)
    }

    static let standard = PreviewBudgetSnapshot(tier: .standard, limits: limits(file: 128, json: 8, allocation: 256, decoded: 384, triangles: 3_000_000, draws: 1024, nodes: 25_000))
    static let expanded = PreviewBudgetSnapshot(tier: .expanded, limits: limits(file: 256, json: 16, allocation: 512, decoded: 768, triangles: 5_000_000, draws: 2048, nodes: 50_000))
    static let large = PreviewBudgetSnapshot(tier: .large, limits: limits(file: 384, json: 24, allocation: 1024, decoded: 1536, triangles: 8_000_000, draws: 4096, nodes: 75_000))
    static let maximum = PreviewBudgetSnapshot(tier: .maximum, limits: limits(file: 512, json: 32, allocation: 1536, decoded: 2304, triangles: 12_000_000, draws: 6144, nodes: 100_000))
    // Thumbnail snapshots are never sent as an interactive-preview boot budget.
    static let thumbnail = PreviewBudgetSnapshot(tier: .standard, limits: limits(file: 64, json: 4, allocation: 128, decoded: 256, triangles: 1_000_000, draws: 512, nodes: 10_000))
    static let previewTiers: [PreviewBudgetSnapshot] = [.standard, .expanded, .large, .maximum]
    static var allProfiles: [String: Any] {
        ["preview": previewTiers.map(\.bridgeValue), "thumbnail": thumbnail.limits.dictionary]
    }
}

enum PreviewLimitMetric: String, CaseIterable {
    case file, json, geometry, textures, decoded, triangles, draws, nodes, depth
    case animationChannels, animationSamplers, animationTracks, entries

    var isBytes: Bool {
        switch self {
        case .file, .json, .geometry, .textures, .decoded: return true
        default: return false
        }
    }

    func label(chinese: Bool) -> String {
        switch self {
        case .file: return chinese ? "文件大小" : "File size"
        case .json: return chinese ? "GLB JSON 大小" : "GLB JSON size"
        case .geometry: return chinese ? "解码后的几何数据" : "Decoded geometry"
        case .textures: return chinese ? "解码后的纹理（含 mipmap）" : "Decoded textures (including mipmaps)"
        case .decoded: return chinese ? "解码后的几何与纹理合计" : "Combined decoded geometry and textures"
        case .triangles: return chinese ? "三角形数量" : "Triangle count"
        case .draws: return chinese ? "绘制调用次数" : "Draw calls"
        case .nodes: return chinese ? "节点数量" : "Node count"
        case .depth: return chinese ? "场景或数据嵌套深度" : "Scene or data nesting depth"
        case .animationChannels: return chinese ? "动画通道数量" : "Animation channels"
        case .animationSamplers: return chinese ? "动画采样器数量" : "Animation samplers"
        case .animationTracks: return chinese ? "动画轨道数量" : "Animation tracks"
        case .entries: return chinese ? "数据条目数量" : "Data entries"
        }
    }
}

/// Only validated numeric evidence crosses the script bridge. User-facing text
/// always comes from the native metric table, never a JavaScript error message.
struct PreviewLimitFailure: Error, Equatable, LocalizedError {
    let metric: PreviewLimitMetric
    let actual: Int
    let limit: Int
    var code: PreviewFailure { .tooLarge }

    init(metric: PreviewLimitMetric, actual: Int, limit: Int) {
        self.metric = metric
        self.actual = actual
        self.limit = limit
    }

    init?(bridge body: [String: Any]) {
        guard body["type"] as? String == "error", body["code"] as? String == "tooLarge",
              let detail = body["limit"] as? [String: Any],
              let name = detail["metric"] as? String, let metric = PreviewLimitMetric(rawValue: name),
              let actual = Self.safeInteger(detail["actual"]),
              let limit = Self.safeInteger(detail["limit"]), limit > 0, actual > limit else { return nil }
        self.init(metric: metric, actual: actual, limit: limit)
    }

    private static func safeInteger(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let value = number.doubleValue
        guard value.isFinite, value >= 0, value <= 9_007_199_254_740_991, value.rounded(.towardZero) == value else { return nil }
        return Int(value)
    }

    func message(locale: String) -> String {
        let chinese = locale.lowercased().hasPrefix("zh")
        let label = metric.label(chinese: chinese)
        let actualText = formatted(actual, locale: locale)
        let limitText = formatted(limit, locale: locale)
        let estimated = metric == .geometry || metric == .textures || metric == .decoded
        let exact = metric == .file || metric == .json
        // Cumulative inspection stops at the first crossed cap, so its value
        // is a lower bound rather than the total for every model resource.
        let relation = estimated ? "预计至少占用" : exact ? "为" : "至少为"
        return chinese ? "\(label)\(relation) \(actualText)，超过快速预览上限 \(limitText)。请用 Trivor 打开。" :
            "\(label): \(estimated ? "estimated " : "")\(exact ? "" : "at least ")\(actualText), exceeding the Quick Look limit of \(limitText). Open it in Trivor."
    }

    private func formatted(_ value: Int, locale: String) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: locale)
        formatter.numberStyle = .decimal
        if metric.isBytes && value >= 1024 * 1024 {
            // Round upward so a value just above a whole-MiB cap is not shown
            // as equal to that cap. The exact count remains in the error value.
            formatter.maximumFractionDigits = 2
            formatter.roundingMode = .ceiling
            let amount = formatter.string(from: NSNumber(value: Double(value) / (1024 * 1024))) ?? String(value)
            return "\(amount) MiB"
        }
        formatter.maximumFractionDigits = 0
        let amount = formatter.string(from: NSNumber(value: value)) ?? String(value)
        return metric.isBytes ? "\(amount) B" : amount
    }

    var errorDescription: String? { message(locale: Locale.preferredLanguages.first ?? "en") }
}

/// An immutable, bounded copy avoids keeping the user's file open while Quick Look is visible.
struct PreviewDocument {
    let data: Data
    let name: String

    static func read(_ url: URL, profile: PreviewBudgetProfile = .thumbnail, isCancelled: () -> Bool = { false }) throws -> PreviewDocument {
        try read(url, budget: profile.snapshot, isCancelled: isCancelled)
    }

    static func read(_ url: URL, budget: PreviewBudgetSnapshot, isCancelled: () -> Bool = { false }) throws -> PreviewDocument {
        if isCancelled() { throw PreviewFailure.cancelled }
        guard url.isFileURL, url.pathExtension.lowercased() == "glb" else { throw PreviewFailure.unsupported }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            // The same URL can be reused after the file changes. Do not let
            // Foundation's cached metadata bypass the profile's initial cap.
            var resourceURL = url
            resourceURL.removeAllCachedResourceValues()
            let values = try resourceURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            if isCancelled() { throw PreviewFailure.cancelled }
            guard values.isRegularFile == true else { throw PreviewFailure.unreadable }
            guard let size = values.fileSize, size >= 0 else { throw PreviewFailure.unreadable }
            let maximumBytes = budget.limits.file
            guard size <= maximumBytes else { throw PreviewLimitFailure(metric: .file, actual: size, limit: maximumBytes) }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            if isCancelled() { throw PreviewFailure.cancelled }
            var data = Data()
            data.reserveCapacity(size)
            while true {
                if isCancelled() { throw PreviewFailure.cancelled }
                // Read one extra byte at the cap to detect files that grow after stat().
                let chunk = try handle.read(upToCount: min(1024 * 1024, maximumBytes - data.count + 1)) ?? Data()
                if isCancelled() { throw PreviewFailure.cancelled }
                if chunk.isEmpty { break }
                guard data.count + chunk.count <= maximumBytes else {
                    throw PreviewLimitFailure(metric: .file, actual: data.count + chunk.count, limit: maximumBytes)
                }
                data.append(chunk)
            }
            if isCancelled() { throw PreviewFailure.cancelled }
            try validate(data, budget: budget)
            if isCancelled() { throw PreviewFailure.cancelled }
            return PreviewDocument(data: data, name: url.lastPathComponent)
        } catch let error as PreviewLimitFailure {
            throw error
        } catch let error as PreviewFailure {
            throw error
        } catch {
            throw PreviewFailure.unreadable
        }
    }

    static func validate(_ data: Data, profile: PreviewBudgetProfile = .thumbnail) throws {
        try validate(data, budget: profile.snapshot)
    }

    static func validate(_ data: Data, budget: PreviewBudgetSnapshot) throws {
        guard data.count <= budget.limits.file else { throw PreviewLimitFailure(metric: .file, actual: data.count, limit: budget.limits.file) }
        guard data.count >= 20, word(data, 0) == 0x46546C67,
              word(data, 4) == 2, Int(word(data, 8)) == data.count else { throw PreviewFailure.invalid }
        let jsonLength = Int(word(data, 12))
        guard jsonLength <= budget.limits.json else {
            throw PreviewLimitFailure(metric: .json, actual: jsonLength, limit: budget.limits.json)
        }
        guard word(data, 16) == 0x4E4F534A, jsonLength > 0,
              jsonLength % 4 == 0, jsonLength <= data.count - 20 else { throw PreviewFailure.invalid }
        var cursor = 20 + jsonLength
        var sawBinary = false
        while cursor < data.count {
            guard data.count - cursor >= 8 else { throw PreviewFailure.invalid }
            let count = Int(word(data, cursor))
            let type = word(data, cursor + 4)
            guard count % 4 == 0, count <= data.count - cursor - 8,
                  type != 0x4E4F534A else { throw PreviewFailure.invalid }
            if type == 0x004E4942 {
                guard !sawBinary else { throw PreviewFailure.invalid }
                sawBinary = true
            }
            cursor += 8 + count
        }
        let jsonData = data.subdata(in: 20..<(20 + jsonLength))
        let json: [String: Any]
        do {
            guard let object = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else { throw PreviewFailure.invalid }
            json = object
        } catch { throw PreviewFailure.invalid }
        guard let asset = json["asset"] as? [String: Any], asset["version"] as? String == "2.0" else { throw PreviewFailure.invalid }
        for key in ["buffers", "images"] {
            guard let value = json[key] else { continue }
            guard let entries = value as? [[String: Any]] else { throw PreviewFailure.invalid }
            for entry in entries {
                if let value = entry["uri"] {
                    guard let uri = value as? String else { throw PreviewFailure.invalid }
                    guard uri.hasPrefix("data:") else { throw PreviewFailure.externalResources }
                }
            }
        }
    }

    private static func word(_ data: Data, _ offset: Int) -> UInt32 {
        UInt32(data[offset]) | UInt32(data[offset + 1]) << 8 | UInt32(data[offset + 2]) << 16 | UInt32(data[offset + 3]) << 24
    }
}

/// Only these resources can be served to WebKit. File paths supplied by the model never become URLs.
enum PreviewResource {
    case model
    case bundled(URL)

    static func resolve(_ url: URL, root: URL) throws -> PreviewResource {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "trivor-preview", parts.host == "bundle",
              parts.port == nil, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              let path = parts.percentEncodedPath.removingPercentEncoding else { throw PreviewFailure.unreadable }
        let pieces = path.split(separator: "/", omittingEmptySubsequences: false)
        guard pieces.first == "", pieces.count >= 2,
              pieces.dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") && !$0.contains("\0") }) else {
            throw PreviewFailure.unreadable
        }
        if path == "/model.glb" { return .model }
        let resolvedRoot = root.resolvingSymlinksInPath().standardizedFileURL
        let resolvedFile = resolvedRoot.appendingPathComponent(String(path.dropFirst())).resolvingSymlinksInPath().standardizedFileURL
        guard resolvedFile.path.hasPrefix(resolvedRoot.path + "/") else { throw PreviewFailure.unreadable }
        return .bundled(resolvedFile)
    }

    static func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "json": return "application/json"
        case "wasm": return "application/wasm"
        case "glb": return "model/gltf-binary"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        default: return "application/octet-stream"
        }
    }
}
