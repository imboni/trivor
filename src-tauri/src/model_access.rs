use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use trivor_loaders::LoadError;

const MAX_FAILED_ATTEMPTS: usize = 128;
pub(crate) const ACCESS_CANCELLED: &str = "MODEL_ASSETS_ACCESS_CANCELLED";

/// Called under one mutex so parallel metadata/preview requests share a prompt.
/// Failures belong to a frontend load attempt, never permanently to a model.
pub(crate) struct ModelAccessGate {
    failures: VecDeque<((PathBuf, String), String)>,
}

impl ModelAccessGate {
    pub(crate) const fn new() -> Self {
        Self {
            failures: VecDeque::new(),
        }
    }

    pub(crate) fn ensure(
        &mut self,
        source: &Path,
        request_id: &str,
        check: impl Fn() -> Result<(), LoadError>,
        request_folder: impl FnOnce() -> Result<Option<PathBuf>, String>,
        format_error: impl Fn(LoadError) -> String,
    ) -> Result<(), String> {
        // Always recheck: a prior request or a normal folder open may already
        // have granted access, including after this attempt was cancelled.
        match check() {
            Ok(()) => return Ok(()),
            Err(LoadError::PermissionDenied { .. }) => {}
            Err(error) => return Err(format_error(error)),
        }

        let key = (source.to_path_buf(), request_id.to_owned());
        if let Some((_, error)) = self.failures.iter().find(|(entry, _)| entry == &key) {
            return Err(error.clone());
        }

        let result = match request_folder() {
            // Selecting a directory is not proof of access. Check the actual
            // model dependencies again, without opening another prompt.
            Ok(Some(_)) => check().map_err(format_error),
            Ok(None) => Err(ACCESS_CANCELLED.to_owned()),
            Err(error) => Err(error),
        };
        if let Err(error) = &result {
            if self.failures.len() == MAX_FAILED_ATTEMPTS {
                self.failures.pop_front();
            }
            self.failures.push_back((key, error.clone()));
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier, Mutex};

    fn denied() -> Result<(), LoadError> {
        Err(LoadError::PermissionDenied {
            path: PathBuf::from("/models/mesh.bin"),
        })
    }

    fn format(error: LoadError) -> String {
        error.to_string()
    }

    #[test]
    fn cancellation_is_shared_only_by_the_same_model_attempt() {
        let mut gate = ModelAccessGate::new();
        let prompts = AtomicUsize::new(0);
        let request = || {
            prompts.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        };
        for _ in 0..2 {
            assert_eq!(
                gate.ensure(Path::new("a.gltf"), "1", denied, request, format),
                Err(ACCESS_CANCELLED.into())
            );
        }
        assert_eq!(prompts.load(Ordering::SeqCst), 1);
        assert!(gate
            .ensure(Path::new("a.gltf"), "2", denied, request, format)
            .is_err());
        assert!(gate
            .ensure(Path::new("b.gltf"), "1", denied, request, format)
            .is_err());
        assert_eq!(prompts.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn wrong_folder_fails_without_reopening_and_later_access_is_rechecked() {
        let mut gate = ModelAccessGate::new();
        let readable = AtomicBool::new(false);
        let checks = AtomicUsize::new(0);
        let check = || {
            checks.fetch_add(1, Ordering::SeqCst);
            if readable.load(Ordering::SeqCst) {
                Ok(())
            } else {
                denied()
            }
        };
        assert!(gate
            .ensure(
                Path::new("a.gltf"),
                "1",
                check,
                || Ok(Some("/wrong".into())),
                format
            )
            .is_err());
        assert_eq!(checks.load(Ordering::SeqCst), 2);
        assert!(gate
            .ensure(
                Path::new("a.gltf"),
                "1",
                check,
                || panic!("must not reopen"),
                format
            )
            .is_err());
        readable.store(true, Ordering::SeqCst);
        assert!(gate
            .ensure(
                Path::new("a.gltf"),
                "1",
                check,
                || panic!("already readable"),
                format
            )
            .is_ok());
    }

    #[test]
    fn concurrent_requests_prompt_once_and_both_recheck_after_grant() {
        let gate = Arc::new(Mutex::new(ModelAccessGate::new()));
        let readable = Arc::new(AtomicBool::new(false));
        let prompts = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(2));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let (gate, readable, prompts, barrier) = (
                    gate.clone(),
                    readable.clone(),
                    prompts.clone(),
                    barrier.clone(),
                );
                std::thread::spawn(move || {
                    barrier.wait();
                    let result = gate.lock().unwrap().ensure(
                        Path::new("a.gltf"),
                        "1",
                        || {
                            if readable.load(Ordering::SeqCst) {
                                Ok(())
                            } else {
                                denied()
                            }
                        },
                        || {
                            prompts.fetch_add(1, Ordering::SeqCst);
                            readable.store(true, Ordering::SeqCst);
                            Ok(Some("/models".into()))
                        },
                        format,
                    );
                    result
                })
            })
            .collect();
        for thread in threads {
            assert!(thread.join().unwrap().is_ok());
        }
        assert_eq!(prompts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn concurrent_cancellation_returns_the_same_error_without_a_second_prompt() {
        let gate = Arc::new(Mutex::new(ModelAccessGate::new()));
        let prompts = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(2));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let (gate, prompts, barrier) = (gate.clone(), prompts.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    let result = gate.lock().unwrap().ensure(
                        Path::new("a.gltf"),
                        "cancel",
                        denied,
                        || {
                            prompts.fetch_add(1, Ordering::SeqCst);
                            Ok(None)
                        },
                        format,
                    );
                    result
                })
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap(), Err(ACCESS_CANCELLED.to_owned()));
        }
        assert_eq!(prompts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn ordinary_errors_never_prompt_and_failure_history_is_bounded() {
        let mut gate = ModelAccessGate::new();
        assert!(gate
            .ensure(
                Path::new("a.gltf"),
                "parse",
                || Err(LoadError::Parse {
                    path: "a.gltf".into(),
                    message: "bad model".into(),
                }),
                || panic!("not a permission failure"),
                format
            )
            .is_err());
        for n in 0..200 {
            let _ = gate.ensure(
                Path::new("a.gltf"),
                &n.to_string(),
                denied,
                || Ok(None),
                format,
            );
        }
        assert_eq!(gate.failures.len(), MAX_FAILED_ATTEMPTS);
    }
}
