# Database test results

Date: 2026-09-27. No schema or migration was changed in this audit.

## Isolated PostgreSQL evidence

- A temporary PostgreSQL 18.4 cluster was created under ignored `tmp/` and stopped after testing. The test databases were separate from the pre-existing local PostgreSQL service.
- Control Plane startup on an empty UTF-8 database applied 13 Flyway migrations; a second startup validated all 13 with no pending migration. Health returned 200.
- The resulting Control Plane schema contained 11 base tables, 11 primary keys, 11 foreign keys, 6 unique constraints, 69 check constraints, 133 not-null constraints and 42 indexes. Counts are inventory, not proof that every access pattern is indexed.
- Go crawler PostgreSQL integration passed 9 workflow subcases, including concurrent discovery dedup, host-slot fencing, cancellation races, retry/reclaim and analytics backlog checks.
- Capture Worker PostgreSQL integration passed 2 test cases for workflow, lease fencing, phase retry, cancellation and GC.
- The live Control Plane API verified owner-scoped reads and mutation, scan idempotency and duplicate cancellation against PostgreSQL.

## Remaining database gates

- The target production PostgreSQL 17 migration/restart check remains M-05.
- Backend Testcontainers IT tests were skipped because Docker was unavailable: 17 skips, zero failures. The local API smoke covers some of the same behavior but does not replace every repository/transaction test.
- ClickHouse batch receipt/version and object-storage recovery were not run (H-04). No backup/restore drill was run (H-05).
- No query plan or large-data benchmark was run. That belongs to the later performance phase; the current audit found no evidence to justify a new index or schema change under the database design gates.
