# Ticket 03 verification evidence

Verified on 2026-07-24 for the frozen T3 Code v0.0.28 baseline at
`fda6486233e0b2f07ecfea166e1a94533cb923c4`.

Certified Ticket 03 source fingerprint:
`sha256:69f105c53a00aa9a523d556d8ccb45ef5b24c7043c9307f0ed93029fe6c96db6`.

The combined release gate passed:

- TypeScript: `npm run check`
- Frontend: `npm test` — 81 files and 620 tests passed
- Rust formatting: `cargo fmt --all -- --check`
- Rust: `cargo test` — 367 library tests passed (22 ignored), 1
  build-certification integration test passed, and 2 process-supervisor
  integration tests passed (2 ignored)
- Rust build gate: `cargo check` and `cargo build`
- Production bundle: `npm run build`
- Diff integrity: `git diff --check` and conflict-marker scan

Ticket 03 focused evidence includes:

- Pinned HTTPS pairing, secure native credential references, device/session rotation and revocation
- Ordered snapshot and incremental reconciliation with stale state, generation reset, and duplicate-safe replay
- Execution-time authorization, expected versions, idempotency, durable runtime outbox recovery, host acknowledgement, and forbidden-capability audit
- Privacy-bounded canonical Attention notifications with grant and revocation checks
- Fresh and upgraded SQLite migration coverage
- Bounded synchronization and UI navigation with 100 Projects, 10,000 Tasks, 1,000 open Attention items, and 100,000 Run events
- Keyboard/focus, accessible naming, non-color status, bounded live announcements, responsive zoom layout, and reduced-motion coverage

All 26 frozen baseline rows retain their source disposition and Xiao evidence. The five
intentional exclusions remain outside Xiao’s product promise with no adjacent workflow
dependency introduced by Ticket 03.
