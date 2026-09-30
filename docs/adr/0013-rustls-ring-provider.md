# ADR 0013 — Use the Rustls ring provider

- Status: accepted
- Date: 2026-09-30

## Context

Reqwest's default Rustls feature selects `aws-lc-rs`. Its assembly emits an
Apple linker compact-unwind warning in macOS builds. oLooper uses HTTPS for the
Tablist catalog and downloads, and does not require the AWS-LC-specific FIPS or
post-quantum configuration.

## Decision

- Build Reqwest with `rustls-no-provider` and enable the Rustls `ring` provider
  explicitly through the shared Rustls dependency.
- Install the Ring provider once before building the first Reqwest client.
- Keep Ring as the sole compiled Rustls provider so Rustls selects it
  unambiguously when constructing a client.

## Consequences

- The macOS linker warning from AWS-LC assembly is removed without suppressing
  linker diagnostics.
- HTTPS certificate validation and system proxy support remain enabled.
- The Tablist client has a hardware/network-free regression test that verifies
  Reqwest can construct its Rustls client with the selected provider.
