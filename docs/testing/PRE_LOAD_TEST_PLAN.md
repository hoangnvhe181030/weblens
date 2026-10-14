# Pre-load production-readiness test plan

Date: 2026-09-27. Scope: the current WebLens checkout. Load and stress tests are excluded.

## Order and evidence

1. Baseline the Java, Go, Capture Worker, and frontend test/build suites. Record skipped infrastructure tests separately from passes.
2. P0: exercise the crawler with deterministic local HTTP fixtures; inspect PostgreSQL frontier, counters, fencing, cancellation, and event projection; test SSRF and owner authorization at their real boundaries.
3. P1: inspect bounded retries, failure handling, capture browser isolation and lifecycle, and database migrations/constraints. Run real integration tests only against isolated test services.
4. P2: review API contracts, progress delivery, observability, critical UI flows, and production packaging/configuration.
5. P3: review operationally significant code smells only. Fix proven defects with narrow regression tests, rerun affected suites, and review the diff.

## Risks and test limits

- Crawl fixtures must use local listeners only; production SSRF policy stays enabled in runtime. The test-only local target mode is used solely to reach those fixtures.
- PostgreSQL tests create and remove isolated schemas. Never point them at a production database.
- Duplicate delivery, cancellation, and worker completion can race. Assertions must check persisted invariants and terminal states, not the winner's timing.
- Capture browser tests must account for process, context, page, proxy, and temporary-file cleanup.
- Any unavailable Docker, ClickHouse, object storage, or browser dependency is a verification gap, not a pass.

## Exit gate

No load testing recommendation until the crawler, concurrency, critical SSRF/authorization, resilience, and browser lifecycle checks pass with no unresolved BLOCKER or HIGH correctness/security issue.
