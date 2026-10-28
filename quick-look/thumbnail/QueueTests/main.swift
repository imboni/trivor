import CoreGraphics
import Foundation

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else { fatalError(message) }
}
func waitUntil(_ message: String, timeout: TimeInterval = 2, _ condition: () -> Bool) {
    let end = Date().addingTimeInterval(timeout)
    while !condition(), Date() < end {
        RunLoop.main.run(until: Date().addingTimeInterval(0.005))
    }
    check(condition(), message)
}
func failure(_ result: Result<CGImage, Error>?) -> PreviewFailure? {
    if case .failure(let error)? = result { return error as? PreviewFailure }
    return nil
}
func successful(_ result: Result<CGImage, Error>?) -> Bool {
    if case .success? = result { return true }
    return false
}
let image = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()!
func file(_ name: String) -> URL { URL(fileURLWithPath: "/tmp/\(name).glb") }
func document(_ name: String) -> PreviewDocument { PreviewDocument(data: Data(), name: name) }

final class Reads {
    struct Attempt {
        let url: URL
        let token: ThumbnailReadCancellation
        let completion: (Result<PreviewDocument, Error>) -> Void
    }
    var attempts: [Attempt] = []
    var read: ThumbnailQueue.Read {
        { url, token, completion in self.attempts.append(Attempt(url: url, token: token, completion: completion)) }
    }
}

final class Renderer: ThumbnailRenderOperation {
    let owner: Renderers
    var callback: ((Result<CGImage, Error>) -> Void)?
    var cancelled = 0
    var running = false
    init(_ owner: Renderers) { self.owner = owner }
    func start(document: PreviewDocument, completion: @escaping (Result<CGImage, Error>) -> Void) {
        check(Thread.isMainThread, "renderer started off main thread")
        callback = completion
        running = true
        owner.running += 1
        owner.maximumRunning = max(owner.maximumRunning, owner.running)
        owner.names.append(document.name)
        owner.onStart?(document.name)
        if owner.immediate { complete(.success(image)) }
    }
    func complete(_ result: Result<CGImage, Error>) {
        if running { running = false; owner.running -= 1 }
        // Deliberately keep the callback to simulate a misbehaving late completion.
        callback?(result)
    }
    func cancel() {
        cancelled += 1
        complete(.failure(PreviewFailure.cancelled))
    }
}
final class Renderers {
    var operations: [Renderer] = []
    var names: [String] = []
    var running = 0
    var maximumRunning = 0
    var immediate = false
    var onStart: ((String) -> Void)?
    func make(_ pixels: Int) -> ThumbnailRenderOperation {
        let result = Renderer(self)
        operations.append(result)
        return result
    }
}

// A failed network/cloud read must not poison all future thumbnails. Its slot
// remains occupied until its real callback, while the other slot remains useful.
do {
    let reads = Reads(), renders = Renderers()
    renders.immediate = true
    let queue = ThumbnailQueue(timeout: 0.08, read: reads.read, makeRenderer: renders.make)
    var results: [String: Result<CGImage, Error>] = [:]
    var calls: [String: Int] = [:]
    func enqueue(_ name: String) {
        queue.enqueue(url: file(name), pixels: 256) { result in
            calls[name, default: 0] += 1
            results[name] = result
        }
    }
    enqueue("blocked")
    waitUntil("blocked read did not time out") { results["blocked"] != nil }
    check(failure(results["blocked"]) == .timedOut, "read deadline returned wrong error")
    check(reads.attempts[0].token.isCancelled, "timed out read did not see cancellation")
    enqueue("healthy")
    check(reads.attempts.count == 2, "one blocked read prevented healthy work")
    reads.attempts[1].completion(.success(document("healthy")))
    check(successful(results["healthy"]), "healthy file did not render")
    reads.attempts[0].completion(.success(document("stale")))
    reads.attempts[0].completion(.failure(PreviewFailure.unreadable))
    check(renders.names == ["healthy"], "late read rendered the wrong request")
    check(calls == ["blocked": 1, "healthy": 1], "read completed more than once")
    print("PASS expired read frees logical job, retains physical slot, and ignores late/duplicate results")
}

// Two truly blocked reads exhaust the physical budget. New requests must still
// finish on their enqueue deadline instead of spawning unbounded I/O workers.
do {
    let reads = Reads(), renders = Renderers()
    renders.immediate = true
    let queue = ThumbnailQueue(timeout: 0.08, read: reads.read, makeRenderer: renders.make)
    var results: [String: Result<CGImage, Error>] = [:]
    for name in ["first", "second"] {
        queue.enqueue(url: file(name), pixels: 256) { results[name] = $0 }
        waitUntil("blocked slot did not expire") { results[name] != nil }
    }
    for name in ["waiting1", "waiting2", "waiting3"] {
        queue.enqueue(url: file(name), pixels: 256) { results[name] = $0 }
    }
    waitUntil("queued requests did not expire") { results.count == 5 }
    check(reads.attempts.count == 2, "more than two blocked reads were spawned")
    check(results.values.allSatisfy { failure($0) == .timedOut }, "waiting requests did not return timeout")
    reads.attempts[0].completion(.failure(PreviewFailure.cancelled))
    queue.enqueue(url: file("recovered"), pixels: 256) { results["recovered"] = $0 }
    check(reads.attempts.count == 3, "returned physical slot was not reused")
    reads.attempts[2].completion(.success(document("recovered")))
    check(successful(results["recovered"]), "queue failed to recover with one remaining blocked read")
    reads.attempts[1].completion(.success(document("late")))
    check(renders.names == ["recovered"], "expired waiting/read job was resurrected")
    print("PASS two stuck reads cap actual concurrency while queued requests time out and recovery works")
}

// Reading consumes part of the same deadline. Starting a renderer must not grant
// another full interval, and cancelling it must not double-call the provider.
do {
    let reads = Reads(), renders = Renderers()
    let queue = ThumbnailQueue(timeout: 0.15, read: reads.read, makeRenderer: renders.make)
    var result: Result<CGImage, Error>?
    var calls = 0
    var checkedDeadline = false
    queue.enqueue(url: file("slow"), pixels: 512) { result = $0; calls += 1 }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.09) { reads.attempts[0].completion(.success(document("slow"))) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.20) {
        check(failure(result) == .timedOut, "render restarted the total deadline")
        checkedDeadline = true
    }
    waitUntil("combined read/render deadline did not fire") { checkedDeadline }
    check(failure(result) == .timedOut, "combined deadline did not return timedOut")
    check(renders.operations.count == 1 && renders.operations[0].cancelled == 1, "renderer was not cleaned up on timeout")
    renders.operations[0].complete(.success(image))
    check(calls == 1, "renderer timeout or late success completed twice")
    print("PASS one enqueue deadline spans read and render, with cancellation and once-only completion")
}

// Enqueueing from a client callback cannot begin another renderer before the
// old renderer is cleaned up, even if read/render callbacks are synchronous.
do {
    let renders = Renderers()
    let queue = ThumbnailQueue(read: { url, _, done in done(.success(document(url.lastPathComponent))) }, makeRenderer: renders.make)
    var trace: [String] = []
    var secondCalls = 0
    renders.onStart = { trace.append("start:\($0)") }
    queue.enqueue(url: file("first"), pixels: 128) { _ in
        trace.append("first callback")
        queue.enqueue(url: file("second"), pixels: 128) { _ in secondCalls += 1 }
        trace.append("first callback returned")
    }
    renders.operations[0].complete(.success(image))
    check(trace == ["start:first.glb", "first callback", "first callback returned", "start:second.glb"], "reentrant enqueue raced completion cleanup")
    renders.operations[0].complete(.failure(PreviewFailure.renderFailed))
    check(secondCalls == 0 && renders.running == 1, "late renderer result affected the next request")
    renders.operations[1].complete(.success(image))
    check(secondCalls == 1 && renders.maximumRunning == 1 && renders.running == 0, "renderers overlapped or callback ran twice")
    print("PASS callback reentry, synchronous completion and stale render results preserve one renderer")
}

// Directory floods have a bounded number of retained callbacks. Overflow is
// rejected promptly while accepted jobs retain FIFO behavior.
do {
    let reads = Reads(), renders = Renderers()
    let queue = ThumbnailQueue(read: reads.read, makeRenderer: renders.make)
    var results: [Int: Result<CGImage, Error>] = [:]
    for index in 0..<65 {
        queue.enqueue(url: file("\(index)"), pixels: 64) { results[index] = $0 }
    }
    check(results.count == 1 && failure(results[64]) == .tooLarge, "request capacity is not bounded at 64")
    for index in 0..<64 {
        check(reads.attempts.count == index + 1, "normal reads were concurrent or FIFO failed")
        reads.attempts[index].completion(.failure(PreviewFailure.unreadable))
    }
    check(results.count == 65, "accepted requests were lost after capacity rejection")
    print("PASS bounded 64-request capacity, immediate overflow, and FIFO failure recovery")
}

// A worker-thread completion must return to main before constructing WebKit or
// delivering the caller's handler.
do {
    let renders = Renderers()
    renders.immediate = true
    let queue = ThumbnailQueue(read: { _, _, done in
        DispatchQueue.global(qos: .utility).async { done(.success(document("worker"))) }
    }, makeRenderer: renders.make)
    var done = false
    queue.enqueue(url: file("worker"), pixels: 64) { result in
        check(Thread.isMainThread && successful(result), "worker completion escaped the main thread")
        done = true
    }
    waitUntil("worker completion was not delivered") { done }
    print("PASS worker results deliver rendering and completion on the main thread")
}

print("PASS thumbnail queue regression suite")
