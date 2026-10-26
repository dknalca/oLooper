//! Best-effort system memory availability used to keep in-memory caches adaptive.

use std::sync::Mutex;
use std::time::{Duration, Instant};

const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
const FALLBACK_BUDGET: usize = 16 * 1024 * 1024;
pub(crate) const MAX_PCM_BYTES: usize = 192 * 1024 * 1024;

pub(crate) fn working_budget(maximum: usize) -> usize {
    // Input, inflated body, PCM and scratch can coexist within one job.
    cache_budget(maximum.saturating_mul(2))
        .div_ceil(2)
        .min(maximum)
}
static SAMPLE: Mutex<Option<(Instant, Option<u64>)>> = Mutex::new(None);
static HEAVY_WORK: Mutex<()> = Mutex::new(());

/// Decoders, SWF materialization and WSOLA share one transient-work slot.
pub(crate) fn work_guard() -> std::sync::MutexGuard<'static, ()> {
    HEAVY_WORK.lock().unwrap_or_else(|error| error.into_inner())
}

/// Allow each cache at most one eighth of currently available system memory,
/// while preserving its hard cap. Failed queries use a conservative budget.
pub(crate) fn cache_budget(maximum: usize) -> usize {
    let mut sample = SAMPLE.lock().unwrap_or_else(|error| error.into_inner());
    let now = Instant::now();
    if sample
        .as_ref()
        .is_none_or(|(time, _)| now.duration_since(*time) >= SAMPLE_INTERVAL)
    {
        *sample = Some((now, available_memory_bytes()));
    }
    budget_for_available(
        sample.as_ref().and_then(|(_, available)| *available),
        maximum,
    )
}

fn budget_for_available(available: Option<u64>, maximum: usize) -> usize {
    available
        .map(|available| (available / 8).min(maximum as u64) as usize)
        .unwrap_or(maximum.min(FALLBACK_BUDGET))
}

#[cfg(target_os = "linux")]
fn available_memory_bytes() -> Option<u64> {
    let contents = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kilobytes = contents.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        (name == "MemAvailable").then(|| value.split_whitespace().next()?.parse::<u64>().ok())?
    })?;
    kilobytes.checked_mul(1024)
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn available_memory_bytes() -> Option<u64> {
    unsafe extern "C" {
        fn mach_port_deallocate(
            task: libc::mach_port_t,
            name: libc::mach_port_t,
        ) -> libc::kern_return_t;
    }
    // SAFETY: Mach fills the correctly-sized, initialized vm_statistics64 struct.
    unsafe {
        let mut stats: libc::vm_statistics64 = std::mem::zeroed();
        let mut count = libc::HOST_VM_INFO64_COUNT;
        let host = libc::mach_host_self();
        let result = libc::host_statistics64(
            host,
            libc::HOST_VM_INFO64,
            (&mut stats as *mut libc::vm_statistics64).cast(),
            &mut count,
        );
        // mach_host_self returns a send right on every call, including failures.
        mach_port_deallocate(libc::mach_task_self(), host);
        if result != libc::KERN_SUCCESS {
            return None;
        }
        let page_size = libc::vm_page_size as u64;
        if page_size == 0 {
            return None;
        }
        // Speculative pages are already included in free_count on Darwin.
        let pages = u64::from(stats.free_count) + u64::from(stats.inactive_count);
        pages.checked_mul(page_size)
    }
}

#[cfg(target_os = "windows")]
fn available_memory_bytes() -> Option<u64> {
    #[repr(C)]
    struct MemoryStatus {
        length: u32,
        memory_load: u32,
        total_physical: u64,
        available_physical: u64,
        total_page_file: u64,
        available_page_file: u64,
        total_virtual: u64,
        available_virtual: u64,
        available_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
    }
    let mut status = MemoryStatus {
        length: std::mem::size_of::<MemoryStatus>() as u32,
        memory_load: 0,
        total_physical: 0,
        available_physical: 0,
        total_page_file: 0,
        available_page_file: 0,
        total_virtual: 0,
        available_virtual: 0,
        available_extended_virtual: 0,
    };
    // SAFETY: The OS API initializes the struct after receiving its exact size.
    (unsafe { GlobalMemoryStatusEx(&mut status) != 0 }).then_some(status.available_physical)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn available_memory_bytes() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::budget_for_available;

    #[test]
    fn dynamic_budget_scales_with_available_memory_and_never_exceeds_cap() {
        assert_eq!(
            budget_for_available(Some(64 * 1024 * 1024), 512 * 1024 * 1024),
            8 * 1024 * 1024
        );
        assert_eq!(
            budget_for_available(Some(8 * 1024 * 1024 * 1024), 512 * 1024 * 1024),
            512 * 1024 * 1024
        );
        assert_eq!(budget_for_available(Some(0), 512 * 1024 * 1024), 0);
        assert_eq!(
            budget_for_available(None, 512 * 1024 * 1024),
            16 * 1024 * 1024
        );
        assert_eq!(budget_for_available(None, 1024), 1024);
    }
}
