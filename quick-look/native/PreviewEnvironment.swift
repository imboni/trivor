import Foundation
import Metal

enum PreviewMemoryPressure: String {
    case unknown, normal, warning, critical

    static func coalesced(_ events: DispatchSource.MemoryPressureEvent) -> PreviewMemoryPressure? {
        if events.contains(.critical) { return .critical }
        if events.contains(.warning) { return .warning }
        if events.contains(.normal) { return .normal }
        return nil
    }
}

enum PreviewThermalCondition: String {
    case nominal, fair, serious, critical, unknown

    static func current() -> PreviewThermalCondition {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return .nominal
        case .fair: return .fair
        case .serious: return .serious
        case .critical: return .critical
        @unknown default: return .unknown
        }
    }
}

struct PreviewHardwareSnapshot {
    let physicalMemory: UInt64
    let recommendedWorkingSets: [UInt64]

    static func current() -> PreviewHardwareSnapshot {
        // Enumerating devices avoids choosing/waking the default discrete GPU
        // on dual-GPU Intel Macs. This is a recommendation, not free VRAM.
        PreviewHardwareSnapshot(physicalMemory: ProcessInfo.processInfo.physicalMemory,
            recommendedWorkingSets: MTLCopyAllDevices().map { $0.recommendedMaxWorkingSetSize })
    }

    var decodedRecommendationCap: Int? {
        // A usable recommendation must produce a positive integral quarter.
        guard let smallest = recommendedWorkingSets.filter({ $0 >= 4 }).min() else { return nil }
        return Int(min(smallest / 4, UInt64(Int.max)))
    }
}

enum PreviewBudgetPolicy {
    static func select(hardware: PreviewHardwareSnapshot, thermal: PreviewThermalCondition,
                       pressure: PreviewMemoryPressure) throws -> PreviewBudgetSnapshot {
        guard pressure != .critical else { throw PreviewFailure.memoryPressure }
        let gib: UInt64 = 1024 * 1024 * 1024
        let ramIndex = hardware.physicalMemory >= 64 * gib ? 3 : hardware.physicalMemory >= 32 * gib ? 2 : hardware.physicalMemory >= 16 * gib ? 1 : 0
        let constrained = pressure == .warning || thermal == .serious || thermal == .critical || thermal == .unknown
        guard let gpuCap = hardware.decodedRecommendationCap else { return .standard }
        let upperIndex = constrained ? 0 : ramIndex
        let supported = PreviewBudgetSnapshot.previewTiers.prefix(upperIndex + 1).last { $0.limits.decoded <= gpuCap } ?? .standard
        return PreviewBudgetSnapshot(tier: supported.tier, limits: supported.limits.clampingDecoded(to: gpuCap))
    }
}

/// One memory-pressure source per extension process. Until the first event its
/// state is explicitly unknown; initial requests need not wait for an event.
final class PreviewMemoryPressureMonitor {
    static let shared = PreviewMemoryPressureMonitor()
    private(set) var state: PreviewMemoryPressure = .unknown
    private var source: DispatchSourceMemoryPressure?
    private var observers: [UUID: (PreviewMemoryPressure) -> Void] = [:]

    init(startSystemMonitoring: Bool = true) {
        if startSystemMonitoring {
            let source = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical], queue: .main)
            self.source = source
            source.setEventHandler { [weak self, weak source] in
                guard let source else { return }
                self?.receive(source.data)
            }
            source.resume()
        }
    }

    // Tests inject events into their own monitor, never into system pressure.
    func receive(_ events: DispatchSource.MemoryPressureEvent) {
        precondition(Thread.isMainThread)
        guard let pressure = PreviewMemoryPressure.coalesced(events), pressure != state else { return }
        state = pressure
        for observer in Array(observers.values) { observer(pressure) }
    }

    func observe(_ handler: @escaping (PreviewMemoryPressure) -> Void) -> UUID {
        precondition(Thread.isMainThread)
        let id = UUID()
        observers[id] = handler
        return id
    }

    func removeObserver(_ id: UUID) {
        precondition(Thread.isMainThread)
        observers.removeValue(forKey: id)
    }

    deinit { source?.cancel() }
}

protocol PreviewEnvironmentProviding: AnyObject {
    func budgetForNewRequest() throws -> PreviewBudgetSnapshot
    func observePressure(_ handler: @escaping (PreviewMemoryPressure) -> Void) -> UUID
    func removePressureObserver(_ id: UUID)
}

final class PreviewEnvironment: PreviewEnvironmentProviding {
    static let shared = PreviewEnvironment()
    let hardware: PreviewHardwareSnapshot
    let pressure: PreviewMemoryPressureMonitor
    private let thermal: () -> PreviewThermalCondition

    init(hardware: PreviewHardwareSnapshot = .current(), pressure: PreviewMemoryPressureMonitor = .shared,
         thermal: @escaping () -> PreviewThermalCondition = PreviewThermalCondition.current) {
        self.hardware = hardware
        self.pressure = pressure
        self.thermal = thermal
    }

    func budgetForNewRequest() throws -> PreviewBudgetSnapshot {
        precondition(Thread.isMainThread)
        return try PreviewBudgetPolicy.select(hardware: hardware, thermal: thermal(), pressure: pressure.state)
    }
    func observePressure(_ handler: @escaping (PreviewMemoryPressure) -> Void) -> UUID { pressure.observe(handler) }
    func removePressureObserver(_ id: UUID) { pressure.removeObserver(id) }
}
