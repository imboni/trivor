import Foundation

if CommandLine.arguments.contains("--print-budget-profiles") {
    let data = try JSONSerialization.data(withJSONObject: PreviewBudgetSnapshot.allProfiles, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    exit(0)
}
if CommandLine.arguments.contains("--print-runtime-budget") {
    let environment = PreviewEnvironment.shared
    let snapshot = try environment.budgetForNewRequest()
    let report: [String: Any] = ["physicalMemory": environment.hardware.physicalMemory,
        "recommendedWorkingSets": environment.hardware.recommendedWorkingSets,
        "decodedRecommendationCap": environment.hardware.decodedRecommendationCap as Any? ?? NSNull(),
        "memoryPressure": environment.pressure.state.rawValue,
        "thermal": PreviewThermalCondition.current().rawValue, "budget": snapshot.bridgeValue]
    print(String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), as: UTF8.self))
    exit(0)
}

private var checks = 0
func expect(_ condition: @autoclosure () -> Bool, _ name: String) {
    precondition(condition(), name)
    checks += 1
}
func reject(_ expected: PreviewFailure, _ name: String, _ operation: () throws -> Void) {
    do { try operation(); fatalError("Expected rejection: \(name)") }
    catch let failure as PreviewFailure { expect(failure == expected, name) }
    catch { fatalError("Unexpected error for \(name): \(error)") }
}
func rejectLimit(_ metric: PreviewLimitMetric, actual: Int, limit: Int, _ name: String, _ operation: () throws -> Void) {
    do { try operation(); fatalError("Expected limit rejection: \(name)") }
    catch let failure as PreviewLimitFailure {
        expect(failure == PreviewLimitFailure(metric: metric, actual: actual, limit: limit), "\(name): got \(failure)")
        expect(failure.code == .tooLarge, "\(name): keeps the machine-readable failure code")
    }
    catch { fatalError("Unexpected error for \(name): \(error)") }
}
func glb(_ json: [String: Any]) throws -> Data {
    var bytes = try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])
    while bytes.count % 4 != 0 { bytes.append(0x20) }
    var result = Data()
    for word: UInt32 in [0x46546C67, 2, UInt32(20 + bytes.count), UInt32(bytes.count), 0x4E4F534A] {
        var little = word.littleEndian
        withUnsafeBytes(of: &little) { result.append(contentsOf: $0) }
    }
    result.append(bytes)
    return result
}
let valid = try glb(["asset": ["version": "2.0"]])
try PreviewDocument.validate(valid)
checks += 1
reject(.invalid, "truncated header") { try PreviewDocument.validate(Data([1, 2])) }
var wrongMagic = valid
wrongMagic[0] = 0
reject(.invalid, "bad magic") { try PreviewDocument.validate(wrongMagic) }
var wrongLength = valid
wrongLength.append(0)
reject(.invalid, "declared length mismatch") { try PreviewDocument.validate(wrongLength) }
reject(.externalResources, "external image") { try PreviewDocument.validate(try glb(["asset": ["version": "2.0"], "images": [["uri": "https://example.com/a.png"]]])) }
reject(.externalResources, "relative buffer") { try PreviewDocument.validate(try glb(["asset": ["version": "2.0"], "buffers": [["uri": "../model.bin"]]])) }
reject(.invalid, "wrong asset version") { try PreviewDocument.validate(try glb(["asset": ["version": "1.0"]])) }
reject(.invalid, "non-string URI") { try PreviewDocument.validate(try glb(["asset": ["version": "2.0"], "images": [["uri": 123]]])) }
var hugeJSONHeader = valid
hugeJSONHeader.replaceSubrange(12..<16, with: [0, 0, 0x80, 0])
rejectLimit(.json, actual: 8 * 1024 * 1024, limit: 4 * 1024 * 1024, "oversized JSON rejected before parsing") {
    try PreviewDocument.validate(hugeJSONHeader)
}
try PreviewDocument.validate(try glb(["asset": ["version": "2.0"], "images": [["uri": "data:image/png;base64,AAAA"]]]))
checks += 1

let root = URL(fileURLWithPath: "/private/tmp/trivor-native-resource-root", isDirectory: true)
switch try PreviewResource.resolve(URL(string: "trivor-preview://bundle/model.glb")!, root: root) {
case .model: checks += 1
default: fatalError("The model must have a fixed alias")
}
switch try PreviewResource.resolve(URL(string: "trivor-preview://bundle/assets/main.js")!, root: root) {
case .bundled(let url): expect(url.path == root.appendingPathComponent("assets/main.js").path, "bundle resource")
default: fatalError("Missing bundle route")
}
for url in [
    "file:///etc/passwd", "https://bundle/index.html", "trivor-preview://outside/index.html",
    "trivor-preview://bundle/../secret", "trivor-preview://bundle/%2e%2e/secret",
    "trivor-preview://bundle/a/%2e%2e/secret", "trivor-preview://bundle/%00",
    "trivor-preview://user@bundle/index.html", "trivor-preview://bundle:80/index.html",
    "trivor-preview://bundle/index.html?secret=1", "trivor-preview://bundle//secret",
    "trivor-preview://bundle/%5csecret"
] {
    reject(.unreadable, url) { _ = try PreviewResource.resolve(URL(string: url)!, root: root) }
}
expect(PreviewResource.mimeType(for: URL(fileURLWithPath: "/decoder.wasm")) == "application/wasm", "WASM MIME")
expect(PreviewFailure.tooLarge.message(locale: "zh-Hans").contains("Trivor"), "Chinese limit guidance")
expect(PreviewFailure.tooLarge.message(locale: "en").contains("Trivor"), "English limit guidance")

func profileAndLimitTests() throws {
    let mib = 1024 * 1024
    expect(PreviewBudgetProfile.thumbnail.maximumBytes == 64 * mib, "thumbnail file envelope remains 64 MiB")
    expect(PreviewBudgetProfile.thumbnail.maximumJSONBytes == 4 * mib, "thumbnail JSON envelope remains 4 MiB")
    expect(PreviewBudgetProfile.preview.maximumBytes == 128 * mib, "preview file envelope is 128 MiB")
    expect(PreviewBudgetProfile.preview.maximumJSONBytes == 8 * mib, "preview JSON envelope is 8 MiB")

    func word(_ data: inout Data, at offset: Int, _ value: Int) {
        var little = UInt32(value).littleEndian
        withUnsafeBytes(of: &little) { data.replaceSubrange(offset..<(offset + 4), with: $0) }
    }
    func paddedJSON(_ length: Int) -> Data {
        var data = valid
        data.append(Data(repeating: 0x20, count: length - (valid.count - 20)))
        word(&data, at: 8, data.count)
        word(&data, at: 12, length)
        return data
    }
    let largeJSON = paddedJSON(5 * mib)
    try PreviewDocument.validate(largeJSON, profile: .preview)
    checks += 1
    rejectLimit(.json, actual: 5 * mib, limit: 4 * mib, "omitted profile retains thumbnail JSON cap") {
        try PreviewDocument.validate(largeJSON)
    }
    try PreviewDocument.validate(paddedJSON(8 * mib), profile: .preview)
    checks += 1
    rejectLimit(.json, actual: 8 * mib + 4, limit: 8 * mib, "preview JSON cap is inclusive") {
        try PreviewDocument.validate(paddedJSON(8 * mib + 4), profile: .preview)
    }

    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("trivor-budget-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let jsonURL = directory.appendingPathComponent("larger-json.glb")
    try largeJSON.write(to: jsonURL)
    rejectLimit(.json, actual: 5 * mib, limit: 4 * mib, "read preserves JSON limit details rather than unreadable") {
        _ = try PreviewDocument.read(jsonURL)
    }
    let jsonDocument = try PreviewDocument.read(jsonURL, profile: .preview)
    expect(jsonDocument.data.count == largeJSON.count, "preview read uses preview JSON profile")

    // A sparse BIN chunk tests the actual file-size boundary without storing
    // a large fixture in Git or asking a decoder to allocate model resources.
    let fileURL = directory.appendingPathComponent("larger-file.glb")
    let fileSize = 64 * mib + 4
    var header = valid
    word(&header, at: 8, fileSize)
    for value in [UInt32(fileSize - valid.count - 8), UInt32(0x004E4942)] {
        var little = value.littleEndian
        withUnsafeBytes(of: &little) { header.append(contentsOf: $0) }
    }
    try header.write(to: fileURL)
    let handle = try FileHandle(forWritingTo: fileURL)
    try handle.truncate(atOffset: UInt64(fileSize))
    try handle.close()
    rejectLimit(.file, actual: fileSize, limit: 64 * mib, "default read keeps thumbnail file cap") {
        _ = try PreviewDocument.read(fileURL)
    }
    let document = try PreviewDocument.read(fileURL, profile: .preview)
    expect(document.data.count == fileSize, "preview reads and validates files above thumbnail cap")
    rejectLimit(.file, actual: fileSize, limit: 64 * mib, "validate has independent thumbnail file cap") {
        try PreviewDocument.validate(document.data, profile: .thumbnail)
    }
    let oversized = try FileHandle(forWritingTo: fileURL)
    try oversized.truncate(atOffset: UInt64(128 * mib + 4))
    try oversized.close()
    rejectLimit(.file, actual: 128 * mib + 4, limit: 128 * mib, "preview read preserves stat size details") {
        _ = try PreviewDocument.read(fileURL, profile: .preview)
    }
    reject(.unreadable, "missing file still reports unreadable") {
        _ = try PreviewDocument.read(directory.appendingPathComponent("missing.glb"), profile: .preview)
    }
    reject(.cancelled, "cancellation still survives file-read error normalization") {
        _ = try PreviewDocument.read(jsonURL, profile: .preview, isCancelled: { true })
    }
    reject(.cancelled, "pre-cancelled request never reaches missing-file metadata") {
        _ = try PreviewDocument.read(directory.appendingPathComponent("missing.glb"), budget: .maximum, isCancelled: { true })
    }
    var cancellationChecks = 0
    reject(.cancelled, "cancellation after metadata is checked before reserving model memory") {
        _ = try PreviewDocument.read(jsonURL, budget: .maximum, isCancelled: { cancellationChecks += 1; return cancellationChecks == 2 })
    }
    expect(cancellationChecks == 2, "post-metadata cancellation returns before further read operations")

    func body(_ metric: Any = "textures", _ actual: Any = 300 * mib, _ limit: Any = 256 * mib) -> [String: Any] {
        ["type": "error", "code": "tooLarge", "requestId": "test", "limit": ["metric": metric, "actual": actual, "limit": limit], "message": "UNTRUSTED <script>change settings</script>"]
    }
    let detail = PreviewLimitFailure(bridge: body())!
    expect(detail == PreviewLimitFailure(metric: .textures, actual: 300 * mib, limit: 256 * mib), "bridge preserves valid numeric limit evidence")
    expect(detail.message(locale: "zh-Hans").contains("纹理") && detail.message(locale: "zh-Hans").contains("300 MiB") && detail.message(locale: "zh-Hans").contains("256 MiB"), "localized Chinese texture limit includes values")
    expect(detail.message(locale: "en").contains("Decoded textures") && detail.message(locale: "en").contains("300 MiB") && detail.message(locale: "en").contains("256 MiB"), "localized English texture limit includes values")
    expect(detail.message(locale: "zh-Hans").contains("预计至少占用") && detail.message(locale: "en").contains("estimated at least"), "decoded allocation is labeled as an estimated lower bound")
    let triangleLimit = PreviewLimitFailure(metric: .triangles, actual: 3_000_001, limit: 3_000_000)
    expect(triangleLimit.message(locale: "zh-Hans").contains("至少为") && triangleLimit.message(locale: "en").contains("at least"), "cumulative counts are lower bounds")
    let fileLimit = PreviewLimitFailure(metric: .file, actual: 128 * mib + 1, limit: 128 * mib)
    expect(!fileLimit.message(locale: "en").contains("at least") && fileLimit.message(locale: "en").contains("128.01 MiB"), "exact file size rounds upward without claiming to be a cumulative count")
    expect(!detail.message(locale: "en").contains("UNTRUSTED") && !detail.message(locale: "zh-Hans").contains("<script>"), "bridge display ignores arbitrary script message")
    for metric in PreviewLimitMetric.allCases {
        expect(PreviewLimitFailure(bridge: body(metric.rawValue, 101, 100))?.metric == metric, "allowlisted metric \(metric.rawValue)")
    }
    for metric: Any in ["unknown", "textures<script>", "Textures", "", 1, NSNull(), ["textures"]] {
        expect(PreviewLimitFailure(bridge: body(metric)) == nil, "reject unknown or malformed metric \(metric)")
    }
    for number: Any in [true, false, "300", NSNull(), Double.nan, Double.infinity, -Double.infinity, -1, 1.5, 9_007_199_254_740_992 as Int64] {
        expect(PreviewLimitFailure(bridge: body("textures", number, 1)) == nil, "reject malformed actual \(number)")
        expect(PreviewLimitFailure(bridge: body("textures", 300, number)) == nil, "reject malformed limit \(number)")
    }
    expect(PreviewLimitFailure(bridge: body("textures", 100, 100)) == nil, "equal value is not a limit violation")
    expect(PreviewLimitFailure(bridge: body("textures", 99, 100)) == nil, "under-budget value is not a limit violation")
    expect(PreviewLimitFailure(bridge: body("textures", 100, 0)) == nil, "zero limit is invalid")
    expect(PreviewLimitFailure(bridge: body("entries", 9_007_199_254_740_991 as Int64, 100))?.actual == 9_007_199_254_740_991, "maximum safe JavaScript integer is preserved exactly")
    var malformed = body()
    malformed["limit"] = "raw message"
    expect(PreviewLimitFailure(bridge: malformed) == nil, "reject malformed limit object")
    malformed = body(); malformed["type"] = "ready"
    expect(PreviewLimitFailure(bridge: malformed) == nil, "ignore limit attached to ready event")
    malformed = body(); malformed["code"] = "invalid"
    expect(PreviewLimitFailure(bridge: malformed) == nil, "ignore limit attached to unrelated error code")
}
try profileAndLimitTests()

func adaptiveBudgetTests() throws {
    let mib = 1024 * 1024
    let gib: UInt64 = 1024 * 1024 * 1024
    func hardware(_ ram: UInt64 = 64 * 1024 * 1024 * 1024, _ gpus: [UInt64] = [64 * 1024 * 1024 * 1024]) -> PreviewHardwareSnapshot {
        PreviewHardwareSnapshot(physicalMemory: ram, recommendedWorkingSets: gpus)
    }
    func select(_ hardware: PreviewHardwareSnapshot, _ pressure: PreviewMemoryPressure = .unknown,
                _ thermal: PreviewThermalCondition = .nominal) throws -> PreviewBudgetSnapshot {
        try PreviewBudgetPolicy.select(hardware: hardware, thermal: thermal, pressure: pressure)
    }
    for (ram, tier): (UInt64, PreviewBudgetTier) in [(8 * gib, .standard), (16 * gib - 1, .standard), (16 * gib, .expanded),
        (32 * gib - 1, .expanded), (32 * gib, .large), (64 * gib - 1, .large), (64 * gib, .maximum), (256 * gib, .maximum)] {
        let budget = try select(hardware(ram))
        expect(budget.tier == tier, "RAM threshold \(ram) selects \(tier)")
    }
    for gpu: [UInt64] in [[], [0], [1, 2, 3]] {
        let budget = try select(hardware(64 * gib, gpu))
        expect(budget == .standard, "unknown or unusable GPU recommendation selects standard")
    }
    let multiple = try select(hardware(64 * gib, [0, 64 * gib, 3 * gib]))
    expect(multiple == .expanded, "smallest valid GPU recommendation limits a multi-GPU Mac")
    let mediumGPU = try select(hardware(64 * gib, [4 * gib]))
    expect(mediumGPU == .expanded, "GPU ceiling selects a lower whole tier")
    let exactLarge = try select(hardware(64 * gib, [6 * gib]))
    expect(exactLarge == .large, "GPU cap accepts exact decoded tier boundary")
    let exactMaximum = try select(hardware(64 * gib, [9 * gib]))
    expect(exactMaximum == .maximum, "maximum tier fits one quarter of its recommendation")
    for bytes in [1, 128 * mib, 300 * mib, 384 * mib - 1] {
        let constrained = try select(hardware(64 * gib, [UInt64(bytes) * 4]))
        expect(constrained.tier == .standard, "weak GPU remains standard rather than choosing an expanded tier")
        expect(constrained.limits.decoded == bytes && constrained.limits.geometry <= bytes && constrained.limits.textures <= bytes,
               "all GPU allocation budgets respect weak recommendation")
        expect(constrained.limits.file == PreviewBudgetSnapshot.standard.limits.file, "GPU constraint does not change file capacity")
    }
    for thermal in [PreviewThermalCondition.serious, .critical, .unknown] {
        let budget = try select(hardware(), .normal, thermal)
        expect(budget == .standard, "thermal \(thermal) restricts new requests")
    }
    let fair = try select(hardware(), .unknown, .fair)
    expect(fair == .maximum, "fair thermal state and unknown initial pressure permit hardware tier")
    let warning = try select(hardware(), .warning)
    expect(warning == .standard, "warning restricts new requests to standard")
    let weakWarning = try select(hardware(64 * gib, [512 * UInt64(mib)]), .warning)
    expect(weakWarning.limits.decoded == 128 * mib, "warning does not bypass GPU limits")
    reject(.memoryPressure, "critical rejects new requests") { _ = try select(hardware(), .critical) }

    expect(PreviewMemoryPressure.coalesced([.critical, .warning, .normal]) == .critical, "critical wins coalesced flags")
    expect(PreviewMemoryPressure.coalesced([.warning, .normal]) == .warning, "warning wins normal flag")
    expect(PreviewMemoryPressure.coalesced(.normal) == .normal, "normal flag is explicit")
    expect(PreviewMemoryPressure.coalesced([]) == nil, "empty event does not imply normal pressure")
    let monitor = PreviewMemoryPressureMonitor(startSystemMonitoring: false)
    var thermal = PreviewThermalCondition.nominal
    let environment = PreviewEnvironment(hardware: hardware(), pressure: monitor, thermal: { thermal })
    expect(monitor.state == .unknown, "monitor starts unknown without waiting for a pressure event")
    let initial = try environment.budgetForNewRequest()
    var notifications: [PreviewMemoryPressure] = []
    let observer = environment.observePressure { notifications.append($0) }
    monitor.receive([.warning, .normal])
    let later = try environment.budgetForNewRequest()
    expect(initial == .maximum && later == .standard, "warning changes only the next immutable snapshot")
    monitor.receive(.warning)
    expect(notifications == [.warning], "duplicate pressure state does not re-notify observers")
    monitor.receive([.critical, .normal])
    reject(.memoryPressure, "environment rejects requests after critical event") { _ = try environment.budgetForNewRequest() }
    monitor.receive(.normal)
    let restored = try environment.budgetForNewRequest()
    expect(restored == initial && notifications == [.warning, .critical, .normal], "normal allows new hardware-tier requests")
    thermal = .serious
    let hot = try environment.budgetForNewRequest()
    expect(hot == .standard, "environment samples thermal state for every new request")
    environment.removePressureObserver(observer)
    monitor.receive(.critical)
    expect(notifications.count == 3, "removed observers are not retained or called")
    let decoded = PreviewLimitFailure(metric: .decoded, actual: 400 * mib, limit: 384 * mib)
    expect(decoded.message(locale: "zh-Hans").contains("几何与纹理合计") && decoded.message(locale: "en").contains("Combined decoded"), "combined allocation reason is distinct from separate resources")
    expect(PreviewFailure.memoryPressure.message(locale: "zh-Hans").contains("内存压力") && PreviewFailure.memoryPressure.message(locale: "en").contains("memory pressure"), "memory pressure has localized guidance")
}
try adaptiveBudgetTests()

let transfer = PreviewTaskDelivery()
let task = NSObject()
let taskID = ObjectIdentifier(task)
let payload = Data(repeating: 0x5A, count: 64 * 1024 * 2 + 7)
var events: [String] = []
var received = Data()
transfer.begin(taskID)
transfer.send(taskID, data: payload, response: { events.append("response") }, receive: { chunk in
    received.append(chunk)
    events.append("chunk")
}, finish: { events.append("finish") })
expect(received == payload, "resource bytes remain intact across chunk boundaries")
expect(events == ["response", "chunk", "chunk", "chunk", "finish"], "response and completion order")
transfer.fail(taskID) { events.append("unexpected error") }
expect(events.last == "finish", "completed tasks cannot fail a second time")

events = []
transfer.begin(taskID)
transfer.stop(taskID)
transfer.send(taskID, data: payload, response: { events.append("response") }, receive: { _ in events.append("chunk") }, finish: { events.append("finish") })
expect(events.isEmpty, "cancel before resource read completes suppresses all callbacks")

events = []
transfer.begin(taskID)
transfer.send(taskID, data: payload, response: {
    events.append("response")
    transfer.stop(taskID)
}, receive: { _ in events.append("unexpected chunk") }, finish: { events.append("unexpected finish") })
expect(events == ["response"], "reentrant stop during response suppresses chunks and finish")

events = []
transfer.begin(taskID)
transfer.send(taskID, data: payload, response: { events.append("response") }, receive: { _ in
    events.append("chunk")
    transfer.stop(taskID)
}, finish: { events.append("unexpected finish") })
expect(events == ["response", "chunk"], "reentrant stop during first chunk suppresses later chunks")

events = []
transfer.begin(taskID)
transfer.send(taskID, data: Data([1]), response: { events.append("response") }, receive: { _ in
    events.append("chunk")
    transfer.cancelAll()
}, finish: { events.append("unexpected finish") })
expect(events == ["response", "chunk"], "preview teardown during final chunk suppresses finish")

events = []
transfer.begin(taskID)
transfer.send(taskID, data: Data(), response: {
    events.append("response")
    transfer.cancelAll()
}, receive: { _ in events.append("unexpected chunk") }, finish: { events.append("unexpected finish") })
expect(events == ["response"], "empty resource still respects reentrant cancellation")

print("Quick Look native validation: \(checks) checks passed")
