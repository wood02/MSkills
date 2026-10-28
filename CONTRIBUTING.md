# Contributing to MSkills

Use the `mskills` default branch as the base for changes. Explain the user-visible behavior and keep unrelated changes separate.

## Setup and checks

Follow [README](README.md) for prerequisites. Run `pnpm install --frozen-lockfile`, then `pnpm dev`.

Before submitting, run `pnpm typecheck`, the relevant `pnpm test:unit` tests, and Rust tests with `cargo test --manifest-path src-tauri/Cargo.toml`. Use `pnpm build` when changing packaging or application startup. State platform checks you could not perform.

For changes to stored data, backup formats, sync or external tool configuration, include regression tests using temporary directories. Do not run migration tests against real user data. Keep legacy readers until a documented migration replaces them.

Do not commit credentials, local databases, personal configuration, build artifacts or screenshots containing private information. Preserve third-party copyright notices.

[Report an issue](https://github.com/wood02/MSkills/issues) with reproduction steps, application version and operating system. Report security issues through [SECURITY](SECURITY.md).
