//! Own sidecar lifetimes so application exit cannot leave a conversion running.

use std::io;
use std::process::{Child, ChildStderr, Command, ExitStatus};
use std::sync::{Arc, Mutex, OnceLock, Weak};

#[derive(Default)]
struct Processes {
    shutting_down: bool,
    children: Vec<Weak<Mutex<Child>>>,
}

#[derive(Default)]
struct Registry(Mutex<Processes>);

impl Registry {
    fn spawn(&self, command: &mut Command) -> io::Result<ManagedChild> {
        let mut processes = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if processes.shutting_down {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "MODEL_PREPARATION_CANCELLED",
            ));
        }
        // Keep the shutdown lock through spawn and registration: a process must
        // never start after shutdown has collected the children it will stop.
        let child = Arc::new(Mutex::new(command.spawn()?));
        processes.children.retain(|child| child.strong_count() > 0);
        processes.children.push(Arc::downgrade(&child));
        Ok(ManagedChild(child))
    }

    fn shutdown(&self) {
        let children = {
            let mut processes = self.0.lock().unwrap_or_else(|e| e.into_inner());
            processes.shutting_down = true;
            processes
                .children
                .iter()
                .filter_map(Weak::upgrade)
                .collect::<Vec<_>>()
        };
        for child in children {
            terminate(&mut child.lock().unwrap_or_else(|e| e.into_inner()));
        }
    }
}

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(Registry::default)
}

pub(crate) struct ManagedChild(Arc<Mutex<Child>>);

impl ManagedChild {
    pub(crate) fn spawn(command: &mut Command) -> io::Result<Self> {
        registry().spawn(command)
    }

    pub(crate) fn take_stderr(&self) -> Option<ChildStderr> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .stderr
            .take()
    }

    pub(crate) fn try_wait(&self) -> io::Result<Option<ExitStatus>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).try_wait()
    }

    pub(crate) fn terminate(&self) {
        terminate(&mut self.0.lock().unwrap_or_else(|e| e.into_inner()));
    }
}

fn terminate(child: &mut Child) {
    // Child has no Drop implementation that terminates or waits. try_wait also
    // reaps an already exited child; otherwise kill before the blocking wait.
    if !matches!(child.try_wait(), Ok(Some(_))) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        self.terminate();
    }
}

/// Permanently stop sidecar creation and synchronously kill/reap running ones.
/// Call only when the application has committed to exiting.
pub fn shutdown_model_processes() {
    registry().shutdown();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Stdio;

    fn sleeping_child(registry: &Registry) -> ManagedChild {
        registry
            .spawn(Command::new("/bin/sleep").arg("30"))
            .unwrap()
    }

    fn assert_reaped(pid: u32) {
        assert!(!Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
    }

    #[test]
    fn shutdown_reaps_all_children_and_rejects_late_starts() {
        let registry = Registry::default();
        let children = [sleeping_child(&registry), sleeping_child(&registry)];
        let pids = children
            .each_ref()
            .map(|child| child.0.lock().unwrap().id());
        registry.shutdown();
        for (child, pid) in children.iter().zip(pids) {
            assert!(!child.try_wait().unwrap().unwrap().success());
            assert_reaped(pid);
        }
        let result = registry.spawn(Command::new("/bin/sleep").arg("30"));
        assert!(matches!(result, Err(error) if error.kind() == io::ErrorKind::Interrupted));
        registry.shutdown(); // Repeated exit notifications are safe.
    }

    #[test]
    fn dropping_worker_guard_reaps_child_without_a_cancellation_poll() {
        let registry = Registry::default();
        let child = sleeping_child(&registry);
        let pid = child.0.lock().unwrap().id();
        drop(child);
        assert_reaped(pid);
    }
}
