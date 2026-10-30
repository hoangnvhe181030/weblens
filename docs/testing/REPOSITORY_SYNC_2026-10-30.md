# Repository synchronization — 2026-10-30

## Scope

The CV URL remains https://github.com/hoangnvhe181030/weblens. Its `main`
includes the reviewed histories from `hoangptkd/weblens`:

- `main` at `2782c9e`: current static Design Clone export fixes.
- `codex/reliability-local-evidence-20261014` at `101d356`: billing, Redis
  sessions, RabbitMQ command transport, recovery and load-test evidence.
- `codex/analytics-batch-receipts` at `de3bbaa`: analytics benchmark history
  and phased test plan. The timing and metrics branches are already ancestors.

The merge preserves the October 30 rendered-document/CSS/resource fixes and
the reliability branch's abort propagation for lost capture leases. A regression
test verifies that an already-aborted lease cannot start browser work. Existing
migrations are retained without rewriting their contents.

README links to both GitHub locations and the live website. CI remains active;
release/deploy jobs require `github.repository == 'hoangptkd/weblens'` so the
CV repository cannot publish a production deployment.

## Local verification

- Java 21: `mvn -B clean verify` — 183 unit/MVC/architecture tests and 72
  integration tests passed, zero skipped. Integration includes PostgreSQL 17.6,
  Redis, RabbitMQ, billing/IPN and crash/recovery tests.
- Backend integration evidence gate and its self-test passed.
- Go: `go test -count=1 ./...` and `go vet ./...` passed with isolated
  PostgreSQL 17.6, ClickHouse 26.3 and RabbitMQ 4.3.6 test endpoints.
- Frontend: 39 tests, lint and production build passed.
- Capture Worker: typecheck/build passed; default suite passed 70 tests with
  12 environment-dependent skips. With PostgreSQL and browser smoke enabled,
  84 tests passed, two Camoufox smoke tests could not start because the browser
  runtime was absent, and the MinIO test was skipped.
- Windows RabbitMQ cutover checks and seven release-runtime scenarios passed.
- GitHub workflow passed `actionlint`; edited Vietnamese text passed UTF-8 checks.
- A pattern scan of tracked text files found no provider token or private key.
  This is not a complete security audit.

No production deployment, real payment or new load benchmark is part of this
synchronization. Historical load-test results keep their original outcomes and
limitations; synchronization does not turn failed capacity gates into passes.
