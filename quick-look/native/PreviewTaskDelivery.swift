import Foundation

/// Main-thread task state, separate from WebKit so cancellation from inside a callback is testable.
final class PreviewTaskDelivery {
    private var active: Set<ObjectIdentifier> = []

    func begin(_ identifier: ObjectIdentifier) { active.insert(identifier) }
    func stop(_ identifier: ObjectIdentifier) { active.remove(identifier) }
    func cancelAll() { active.removeAll() }

    func send(_ identifier: ObjectIdentifier, data: Data, response: () -> Void, receive: (Data) -> Void, finish: () -> Void) {
        guard active.contains(identifier) else { return }
        defer { active.remove(identifier) }
        response()
        for offset in stride(from: 0, to: data.count, by: 64 * 1024) {
            // A WebKit callback can synchronously stop the task or tear down the preview.
            guard active.contains(identifier) else { return }
            receive(data.subdata(in: offset..<min(offset + 64 * 1024, data.count)))
        }
        guard active.contains(identifier) else { return }
        finish()
    }

    func fail(_ identifier: ObjectIdentifier, callback: () -> Void) {
        guard active.remove(identifier) != nil else { return }
        callback()
    }
}
