//! Import pipeline: untrusted `.swf` / `.exe` containers parsed as data.
//!
//! Never executes imported content. All parsing is bounds-checked with
//! allocation caps derived from declared (file-controlled) lengths.

pub mod exe;
#[cfg(test)]
pub(crate) mod fixture;
pub mod swf;
