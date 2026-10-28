import CoreGraphics
import Foundation

protocol ThumbnailRenderOperation: AnyObject {
    func start(document: PreviewDocument, completion: @escaping (Result<CGImage, Error>) -> Void)
    func cancel()
}

/// A blocked file-system call cannot be interrupted, but the next chunk and its
/// eventual result must observe cancellation. Only this flag crosses threads.
final class ThumbnailReadCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
}

/// Normal jobs read and render one at a time, keeping only one model in memory.
/// An expired, blocked read retains its physical slot until it really returns.
/// A second slot lets healthy files proceed; two blocked reads cannot spawn more.
/// Every request expires from enqueue time, including requests waiting for a slot.
final class ThumbnailQueue {
    typealias Read = (URL, ThumbnailReadCancellation, @escaping (Result<PreviewDocument, Error>) -> Void) -> Void
    typealias MakeRenderer = (Int) throws -> ThumbnailRenderOperation

    private final class Job {
        let id = UUID()
        let url: URL
        let pixels: Int
        let completion: (Result<CGImage, Error>) -> Void
        let expiresAt: DispatchTime
        let cancellation = ThumbnailReadCancellation()
        var deadline: DispatchWorkItem?
        init(url: URL, pixels: Int, expiresAt: DispatchTime, completion: @escaping (Result<CGImage, Error>) -> Void) {
            self.url = url
            self.pixels = pixels
            self.expiresAt = expiresAt
            self.completion = completion
        }
    }

    private let timeout: TimeInterval
    private let maximumRequests: Int
    private let read: Read
    private let makeRenderer: MakeRenderer
    private var waiting: [Job] = []
    private var pending: [UUID: Job] = [:]
    private var reading: Set<UUID> = []
    private var active: Job?
    private var renderer: ThumbnailRenderOperation?
    private var isPumping = false
    private var completionDepth = 0

    init(timeout: TimeInterval = 15, maximumRequests: Int = 64,
         read: @escaping Read = ThumbnailQueue.readDocument,
         makeRenderer: @escaping MakeRenderer) {
        precondition(timeout.isFinite && timeout > 0 && maximumRequests > 0 && maximumRequests <= 64)
        self.timeout = timeout
        self.maximumRequests = maximumRequests
        self.read = read
        self.makeRenderer = makeRenderer
    }

    func enqueue(url: URL, pixels: Int, completion: @escaping (Result<CGImage, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard pending.count < maximumRequests else { completion(.failure(PreviewFailure.tooLarge)); return }
        let job = Job(url: url, pixels: pixels, expiresAt: .now() + timeout, completion: completion)
        pending[job.id] = job
        waiting.append(job)
        let id = job.id
        let deadline = DispatchWorkItem { [weak self] in self?.finish(id, .failure(PreviewFailure.timedOut)) }
        job.deadline = deadline
        DispatchQueue.main.asyncAfter(deadline: job.expiresAt, execute: deadline)
        pump()
    }

    private static func readDocument(_ url: URL, _ cancellation: ThumbnailReadCancellation,
                                     _ completion: @escaping (Result<PreviewDocument, Error>) -> Void) {
        DispatchQueue.global(qos: .utility).async {
            completion(Result { try PreviewDocument.read(url, profile: .thumbnail, isCancelled: { cancellation.isCancelled }) })
        }
    }

    private func pump() {
        guard !isPumping, completionDepth == 0 else { return }
        isPumping = true
        defer { isPumping = false }
        while active == nil, reading.count < 2, !waiting.isEmpty {
            let job = waiting.removeFirst()
            guard pending[job.id] === job else { continue }
            guard DispatchTime.now() < job.expiresAt else {
                finish(job.id, .failure(PreviewFailure.timedOut))
                continue
            }
            active = job
            reading.insert(job.id)
            let id = job.id
            read(job.url, job.cancellation) { [weak self] result in
                // Production reads finish off-thread; injected reads may complete
                // synchronously. Both paths serialize state changes on the main thread.
                if Thread.isMainThread { self?.readFinished(id, result) }
                else { DispatchQueue.main.async { self?.readFinished(id, result) } }
            }
        }
    }

    private func readFinished(_ id: UUID, _ result: Result<PreviewDocument, Error>) {
        guard reading.remove(id) != nil else { return }
        defer { pump() }
        guard let job = pending[id], active === job, !job.cancellation.isCancelled else { return }
        guard DispatchTime.now() < job.expiresAt else { finish(id, .failure(PreviewFailure.timedOut)); return }
        switch result {
        case .failure(let error): finish(id, .failure(error))
        case .success(let document):
            do {
                let operation = try makeRenderer(job.pixels)
                renderer = operation
                operation.start(document: document) { [weak self] result in
                    if Thread.isMainThread { self?.finish(id, result) }
                    else { DispatchQueue.main.async { self?.finish(id, result) } }
                }
            } catch { finish(id, .failure(error)) }
        }
    }

    private func finish(_ id: UUID, _ result: Result<CGImage, Error>) {
        guard let job = pending.removeValue(forKey: id) else { return }
        completionDepth += 1
        job.cancellation.cancel()
        job.deadline?.cancel()
        job.deadline = nil
        waiting.removeAll { $0 === job }
        if active === job {
            active = nil
            let old = renderer
            renderer = nil
            // Clear the job first: cancel may synchronously call its completion.
            old?.cancel()
        }
        job.completion(DispatchTime.now() < job.expiresAt ? result : .failure(PreviewFailure.timedOut))
        completionDepth -= 1
        // Retain reading IDs until their callbacks arrive, even after timeout.
        pump()
    }
}
