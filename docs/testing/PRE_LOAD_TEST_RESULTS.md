# Pre-load production-readiness result

Date: 2026-09-27. **READY_FOR_LOAD_TEST = NO**. No load or stress test was run.

## Final gate

| Priority | Result | Evidence |
| --- | --- | --- |
| P0 crawler, state and security | **FAIL** | Deterministic HTTP, SSRF and PostgreSQL concurrency checks passed, but sitemap discovery is absent and browser egress containment plus auth throttling remain unresolved. |
| P1 resilience, capture and database | **FAIL** | PostgreSQL workflows and Playwright smoke passed; default Camoufox, ClickHouse/S3 recovery, in-flight cancellation and production-version migration remain unverified. |
| P2 API, UI, observability and operations | **FAIL** | Live API and partial browser journeys passed; full scan/results/snapshot E2E, production metrics and restore drill remain open. |

## Test accounting

These are distinct checks in the final baseline, not the number of times suites were rerun.

| Suite | Executed | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Java unit/API/architecture plus Testcontainers IT | 82 | 65 | 0 | 17 |
| Go unit, fixture and PostgreSQL integration | 75 | 74 | 0 | 1 ClickHouse integration |
| Capture Worker unit/integration | 53 | 46 | 0 | 7 browser/S3 checks |
| Frontend component tests | 33 | 33 | 0 | 0 |
| Live isolated API smoke assertions | 20 | 20 | 0 | 0 |
| Focused Playwright browser smoke | 1 | 1 | 0 | 0 |
| **Total** | **264** | **239** | **0** | **25** |

The Playwright smoke also passed three repeat runs. The concurrent Go discovery subtest passed three repeat runs. One old timing assertion was flaky at loopback clock resolution; it was corrected and the Go suite passed three full reruns. **Flaky remaining: 0 observed**, with limited repetitions. The opt-in Camoufox smoke failed before browser launch because the pinned binary was absent; this is an environment block, not a product behavior pass. Go `-race` could not run without CGO/a compiler.

Build checks passed: Java `clean verify` (integration skips above), Go `go vet`, Capture Worker typecheck/build, and frontend lint/build. Both Node production dependency audits reported zero known advisories. Vietnamese UTF-8 checks passed for edited localized files.

## Findings

| Severity | Remaining | Fixed in this audit |
| --- | ---: | ---: |
| BLOCKER | 0 | 0 |
| HIGH | 5 | 1 |
| MEDIUM | 5 | 1 |
| LOW | 1 | 2 |

See [KNOWN_ISSUES.md](KNOWN_ISSUES.md) for root cause, reproduction and required action. This audit fixed mapped-IPv6 SSRF handling, narrowed permanent HTTP retries, corrected a terminal scan report message, and removed a timing-test assumption. New runnable checks cover each change.

## Coverage and limitations

- **Crawler:** Local HTTP fixture and parser/normalizer tests cover static links, relative resolution, external exclusion, fragments/tracking query normalization, redirects, 200/404/503, binary content, malformed/empty pages, size and timeout bounds. PostgreSQL tests prove per-scan dedup and page/depth limits under concurrent completion. `robots.txt` is intentionally not enforced under ADR-011. Sitemap/index discovery is absent (M-01).
- **Scan consistency:** PostgreSQL lease generation, row locks and unique URL key passed duplicate completion, cancellation and concurrent discovery tests. The Control Plane projection uses pessimistic locking and version monotonicity; multi-service event replay under outage remains to be exercised.
- **API/security:** Twenty live assertions passed on the packaged application. Browser UI completed register → add website → queue scan → see queued progress → cancel → logout → login. Browser pages/results/snapshots could not be completed without Crawler, ClickHouse, Capture Worker and object storage.
- **Realtime:** The current UI polls; no SSE/EventSource path exists in this version, so SSE reconnection/termination cases are not applicable. Polling and stale-state behavior have component coverage; live progress beyond queued/cancelled was not exercised.
- **Observability/deployment:** Health checks and correlation IDs exist. Metrics and restore evidence are incomplete. Empty-schema migrations passed on PostgreSQL 18.4, not the production PostgreSQL 17 target. Existing production Windows edits in the working tree were left untouched.

## Exactly what must be fixed or proven before load testing

1. Run default Camoufox capture lifecycle, crash and cancellation checks in the pinned Windows release environment (H-01).
2. Enforce and verify browser network-level outbound containment (H-02).
3. Add and verify bounded authentication attempts (H-03).
4. Pass real ClickHouse/S3 and full three-service recovery/E2E tests, including critical report, snapshot and authorization flows (H-04).
5. Execute and record backup/restore drills for persistent stores (H-05).
6. Add bounded sitemap/index discovery or formally remove that required P0 capability, then pass its crawler suite (M-01).
7. Pass in-flight cancellation and critical resilience fixtures, production PostgreSQL 17 migrations/restart, and the missing observability gate (M-02, M-04, M-05). Resolve `Retry-After` behavior (M-03) before retry-failure signoff.

**READY_FOR_LOAD_TEST = NO**

## What the developer should understand before accepting this code

The crawler's PostgreSQL execution row serializes page discovery and counter changes; the page URL unique constraint makes concurrent discovery idempotent. Lease generations fence stale workers. ClickHouse and object storage are separate consistency domains, so passing PostgreSQL tests does not prove end-to-end publication or recovery. Browser SSRF protection needs both request-time address checks and an operating-system egress boundary. A skipped integration or browser test is a release gate, even when the unit suites pass.
