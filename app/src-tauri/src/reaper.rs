//! Making the host die when the app does, however the app dies (#157).
//!
//! `HostProcess::stop` handles the two graceful endings - the tray's Quit and
//! `RunEvent::Exit` - and neither of them runs when the process is killed
//! outright. Windows does not cascade a kill to children, so `End task`, a
//! `Stop-Process -Force`, or a crash in the Rust side all left `node.exe`
//! running with nothing attached to it.
//!
//! **The orphan is not idle.** It is the process holding the run: the agent
//! children, the warm Claude session, and the turn in flight. It keeps spending
//! against a ceiling nobody is watching, and it keeps its run's lock - so the
//! next launch reports that run as held by a live pid, which is correct and
//! useless.
//!
//! ## Why this cannot be a handler
//!
//! There is nothing to hook. `TerminateProcess` runs no user code in the target,
//! by design - that is what makes it the kill that always works. So the fix has
//! to be something the **kernel** enforces on our behalf, decided in advance.
//!
//! On Windows that is a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`:
//! the app creates a job, assigns the host to it, and holds the handle. When the
//! app dies for any reason at all, every handle it owned is closed by the
//! kernel, the job closes with them, and everything in the job is terminated.
//! It is the mechanism browsers use for this exact problem.
//!
//! ## This does not replace `stop()`
//!
//! `stop()` closes stdin first, which `serve()` reads as a shutdown, so the host
//! finishes the turn it is in and leaves the run resumable. That is the ending
//! we want and the job must not change it. **The job is the backstop for the
//! paths `stop()` never reaches**, and it is safe for the same reason `stop()`'s
//! own kill is: a killed run resumes.

//! ## The shape of `adopt`
//!
//! `Reaper::adopt` returns **`None` when the OS is enforcing containment, and
//! the reason when it is not.** Never an error, and deliberately so: a host that
//! is running but uncontained is a fact to *report*, not a reason to refuse to
//! start one. Refusing to run on a platform with no mechanism would make the app
//! unusable on two of its three targets in order to fix a leak on the third.
//!
//! The reason is a string because it reaches the window. An unenforced guarantee
//! nobody can see is the same as no guarantee.

#[cfg(windows)]
mod imp {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// The job, and why there is none when there is none.
    pub struct Reaper {
        job: HANDLE,
        /// Set when the job could not be created. Reported, never hidden.
        failure: Option<String>,
    }

    // The handle is owned by this struct, used only through the Win32 calls
    // below, and closed exactly once in `Drop`. It is not shared and nothing
    // else derefs it, which is what makes this sound.
    unsafe impl Send for Reaper {}
    unsafe impl Sync for Reaper {}

    impl Reaper {
        pub fn new() -> Self {
            // Both nulls matter. The first is the security attributes, and
            // passing null is what makes the handle NON-INHERITABLE - if the
            // host inherited it, the job would still have an open handle after
            // we died and would never close, which is the whole mechanism
            // silently doing nothing. The second is the name: an unnamed job
            // cannot be opened by anything else.
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() {
                return Self {
                    job,
                    failure: Some(format!(
                        "could not create the job object (error {})",
                        std::io::Error::last_os_error()
                    )),
                };
            }

            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(limits).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if set == 0 {
                // The job exists but will not kill anything, which is worse than
                // no job at all if it went unreported: it looks contained.
                return Self {
                    job,
                    failure: Some(format!(
                        "the job object will not kill on close (error {})",
                        std::io::Error::last_os_error()
                    )),
                };
            }

            Self { job, failure: None }
        }

        pub fn adopt(&self, child: &Child) -> Option<String> {
            if let Some(reason) = &self.failure {
                return Some(reason.clone());
            }
            let assigned =
                unsafe { AssignProcessToJobObject(self.job, child.as_raw_handle() as HANDLE) };
            if assigned == 0 {
                // Checked rather than assumed. A failed assignment is a host
                // OUTSIDE the job, and believing it contained is the one outcome
                // worse than knowing it is not.
                return Some(format!(
                    "the host could not be assigned to the job object (error {})",
                    std::io::Error::last_os_error()
                ));
            }
            None
        }
    }

    impl Drop for Reaper {
        fn drop(&mut self) {
            // Closing the last handle is what fires the kill. On an ordinary
            // quit the host has already gone through `stop()` and there is
            // nothing left in the job for this to reach.
            if !self.job.is_null() {
                unsafe { CloseHandle(self.job) };
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::process::Child;

    /// No mechanism, and it says so rather than pretending.
    ///
    /// macOS and Linux have no job objects. The usual substitutes are
    /// `prctl(PR_SET_PDEATHSIG)` on Linux - which fires when the parent THREAD
    /// exits rather than the parent process, a well-known footgun in a runtime
    /// with a thread pool - and on macOS either a `kqueue` watch on the parent
    /// pid kept by the child, or accepting the orphan.
    ///
    /// Both belong in the platform's own issue, decided deliberately, rather
    /// than in a crate that claims to paper over all three and quietly does
    /// nothing on one of them. Until then this reports the truth: the host is
    /// running and nothing will clean it up.
    pub struct Reaper;

    impl Reaper {
        pub fn new() -> Self {
            Self
        }

        pub fn adopt(&self, _child: &Child) -> Option<String> {
            Some(
                "this platform has no job objects, so a killed app leaves the host running (#157)"
                    .into(),
            )
        }
    }
}

pub use imp::Reaper;

#[cfg(test)]
mod tests {
    use super::Reaper;
    use std::process::{Command, Stdio};

    /// A child that waits and does nothing. Local, instant, no network.
    fn idle() -> std::process::Child {
        let mut cmd = if cfg!(windows) {
            Command::new("cmd.exe")
        } else {
            Command::new("cat")
        };
        // Piped stdin with nothing written to it is what makes it wait.
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("could not spawn the idle child")
    }

    #[test]
    #[cfg(windows)]
    fn a_live_child_is_contained_and_says_so_by_saying_nothing() {
        // The claim that would silently regress. `adopt` returning None is the
        // whole guarantee, and it is only true if the job was created, the limit
        // was set, AND the assignment succeeded - three calls, each of which can
        // fail on its own and each of which is checked.
        let reaper = Reaper::new();
        let mut child = idle();
        assert_eq!(reaper.adopt(&child), None);
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    #[cfg(windows)]
    fn a_child_that_has_already_gone_is_reported_rather_than_assumed_contained() {
        // Fail closed. A dead process cannot be assigned to a job, and the
        // dangerous outcome is not the failure - it is believing it worked.
        let reaper = Reaper::new();
        let mut child = idle();
        let _ = child.kill();
        let _ = child.wait();
        let why = reaper.adopt(&child);
        assert!(
            why.is_some(),
            "adopting a dead process should report, not claim containment"
        );
    }

    #[test]
    #[cfg(windows)]
    fn one_job_takes_more_than_one_child() {
        // The retry path (`host_start` after a failure) reuses the same reaper,
        // so the second host has to land in the same job as the first.
        let reaper = Reaper::new();
        let mut first = idle();
        let mut second = idle();
        assert_eq!(reaper.adopt(&first), None);
        assert_eq!(reaper.adopt(&second), None);
        for child in [&mut first, &mut second] {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    #[test]
    #[cfg(not(windows))]
    fn a_platform_with_no_mechanism_reports_that_rather_than_claiming_one() {
        let reaper = Reaper::new();
        let mut child = idle();
        let why = reaper.adopt(&child);
        assert!(why.is_some(), "silence here would be a guarantee nobody makes");
        let _ = child.kill();
        let _ = child.wait();
    }
}
