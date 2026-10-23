//! One active model preparation per window; cancelled IDs stay cancelled across LOD calls.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, TryLockError};
use std::time::Duration;

const CANCELLED: &str = "MODEL_PREPARATION_CANCELLED";

/// One model operation owns all cache reads/writes until its worker returns.
/// Cancellation alone does not release ownership while a child is still exiting.
#[derive(Default)]
struct OperationGate {
    active: Mutex<()>,
    shutting_down: AtomicBool,
}

impl OperationGate {
    fn cancelled(&self, cancelled: Option<&AtomicBool>) -> bool {
        self.shutting_down.load(Ordering::Relaxed)
            || cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed))
    }

    fn lock(&self, cancelled: Option<&AtomicBool>) -> Result<MutexGuard<'_, ()>, &'static str> {
        loop {
            if self.cancelled(cancelled) {
                return Err(CANCELLED);
            }
            if let Some(guard) = self.try_lock() {
                if self.cancelled(cancelled) {
                    return Err(CANCELLED);
                }
                return Ok(guard);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn try_lock(&self) -> Option<MutexGuard<'_, ()>> {
        if self.shutting_down.load(Ordering::Relaxed) {
            return None;
        }
        match self.active.try_lock() {
            Ok(guard) => Some(guard),
            Err(TryLockError::Poisoned(error)) => Some(error.into_inner()),
            Err(TryLockError::WouldBlock) => None,
        }
    }

    fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Relaxed);
    }
}

fn operations() -> &'static OperationGate {
    static OPERATIONS: OnceLock<OperationGate> = OnceLock::new();
    OPERATIONS.get_or_init(Default::default)
}

/// Only call from a blocking worker, before entering the model access gate.
pub(crate) fn acquire_operation(
    cancelled: Option<&AtomicBool>,
) -> Result<MutexGuard<'static, ()>, String> {
    operations().lock(cancelled).map_err(str::to_owned)
}

/// Cache clearing runs on the main thread, so it must never wait for a worker.
pub(crate) fn try_operation() -> Option<MutexGuard<'static, ()>> {
    operations().try_lock()
}

#[derive(Default)]
pub(crate) struct PreparationJobs {
    requests: VecDeque<(String, Arc<AtomicBool>)>,
    shutting_down: bool,
}

impl PreparationJobs {
    fn register(&mut self, id: &str) -> Arc<AtomicBool> {
        if self.shutting_down {
            return Arc::new(AtomicBool::new(true));
        }
        if let Some((_, cancelled)) = self.requests.iter().find(|(key, _)| key == id) {
            return Arc::clone(cancelled);
        }
        // Starting another model must not leave a multi-gigabyte conversion running.
        self.cancel_all();
        let cancelled = Arc::new(AtomicBool::new(false));
        self.requests.push_back((id.to_owned(), Arc::clone(&cancelled)));
        while self.requests.len() > 128 {
            self.requests.pop_front();
        }
        cancelled
    }

    fn cancel(&mut self, id: &str) {
        if let Some((_, cancelled)) = self.requests.iter().find(|(key, _)| key == id) {
            cancelled.store(true, Ordering::Relaxed);
        } else {
            // A cancellation may arrive before the worker has started its first phase.
            self.requests.push_back((id.to_owned(), Arc::new(AtomicBool::new(true))));
            while self.requests.len() > 128 {
                self.requests.pop_front();
            }
        }
    }

    fn cancel_all(&self) {
        for (_, cancelled) in &self.requests {
            cancelled.store(true, Ordering::Relaxed);
        }
    }

    fn shutdown(&mut self) {
        self.shutting_down = true;
        self.cancel_all();
    }
}

fn jobs() -> &'static Mutex<PreparationJobs> {
    static JOBS: OnceLock<Mutex<PreparationJobs>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}

pub(crate) fn register(id: &str) -> Arc<AtomicBool> {
    jobs().lock().unwrap_or_else(|e| e.into_inner()).register(id)
}

pub(crate) fn cancel(id: &str) {
    jobs().lock().unwrap_or_else(|e| e.into_inner()).cancel(id);
}

pub(crate) fn cancel_all() {
    jobs().lock().unwrap_or_else(|e| e.into_inner()).cancel_all();
}

pub(crate) fn shutdown() {
    jobs().lock().unwrap_or_else(|e| e.into_inner()).shutdown();
    operations().shutdown();
    // Flags alone are insufficient when the main event loop is about to exit:
    // workers may never get another cancellation poll before the process ends.
    trivor_loaders::shutdown_model_processes();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switching_models_cancels_previous_lods() {
        let mut jobs = PreparationJobs::default();
        let old = jobs.register("old");
        assert!(Arc::ptr_eq(&old, &jobs.register("old")));
        let current = jobs.register("current");
        assert!(old.load(Ordering::Relaxed));
        assert!(!current.load(Ordering::Relaxed));
        jobs.cancel("old");
        assert!(!current.load(Ordering::Relaxed));
        assert!(jobs.register("old").load(Ordering::Relaxed));
    }

    #[test]
    fn cancellation_before_worker_start_cannot_be_revived() {
        let mut jobs = PreparationJobs::default();
        jobs.cancel("cancelled");
        assert!(jobs.register("cancelled").load(Ordering::Relaxed));
        let next = jobs.register("next");
        assert!(!next.load(Ordering::Relaxed));
        jobs.cancel_all();
        assert!(next.load(Ordering::Relaxed));
    }

    #[test]
    fn shutdown_cancels_running_and_late_requests() {
        let mut jobs = PreparationJobs::default();
        let running = jobs.register("running");
        jobs.shutdown();
        assert!(running.load(Ordering::Relaxed));
        assert!(jobs.register("late").load(Ordering::Relaxed));
        assert!(jobs.register("running").load(Ordering::Relaxed));
    }

    #[test]
    fn cancelled_waiter_returns_while_another_operation_still_owns_cache() {
        let gate = Arc::new(OperationGate::default());
        let first = gate.lock(None).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = {
            let gate = Arc::clone(&gate);
            let cancelled = Arc::clone(&cancelled);
            std::thread::spawn(move || {
                tx.send(gate.lock(Some(&cancelled)).map(|_| ())).unwrap();
            })
        };
        assert!(rx.recv_timeout(Duration::from_millis(150)).is_err());
        cancelled.store(true, Ordering::Relaxed);
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), Err(CANCELLED));
        worker.join().unwrap();
        assert!(gate.try_lock().is_none());
        drop(first);
        assert!(gate.try_lock().is_some());
    }

    #[test]
    fn cancel_does_not_allow_clear_until_the_active_worker_has_returned() {
        let gate = Arc::new(OperationGate::default());
        let cancelled = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let worker = {
            let gate = Arc::clone(&gate);
            let cancelled = Arc::clone(&cancelled);
            std::thread::spawn(move || {
                let _operation = gate.lock(Some(&cancelled)).unwrap();
                ready_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
                assert!(cancelled.load(Ordering::Relaxed));
            })
        };
        ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        cancelled.store(true, Ordering::Relaxed);
        // A stop button only sets the flag: cleanup/kill may still be running.
        assert!(gate.try_lock().is_none());
        finish_tx.send(()).unwrap();
        worker.join().unwrap();
        assert!(gate.try_lock().is_some());
    }

    #[test]
    fn model_operations_are_serialized_and_shutdown_cancels_unscoped_waiters() {
        let gate = Arc::new(OperationGate::default());
        let first = gate.lock(None).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = {
            let gate = Arc::clone(&gate);
            std::thread::spawn(move || {
                tx.send(gate.lock(None).map(|_| ())).unwrap();
            })
        };
        assert!(rx.recv_timeout(Duration::from_millis(150)).is_err());
        drop(first);
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), Ok(()));
        worker.join().unwrap();

        let first = gate.lock(None).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let waiter = {
            let gate = Arc::clone(&gate);
            std::thread::spawn(move || {
                tx.send(gate.lock(None).map(|_| ())).unwrap();
            })
        };
        gate.shutdown();
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), Err(CANCELLED));
        waiter.join().unwrap();
        drop(first);
        assert!(gate.try_lock().is_none());
        assert_eq!(gate.lock(None).unwrap_err(), CANCELLED);
    }
}
