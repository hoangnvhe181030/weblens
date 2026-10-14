# WebLens database and performance execution — 2026-10-11

Continuation: [October 12 local Redis/VPS verification](VPS_LOCAL_REDIS_PERFORMANCE_2026-10-12.md).
The historical NO-GO results below are preserved; later deployment evidence is
recorded separately rather than rewriting this execution's outcome.

## Authorization and execution window

The user authorized the complete query audit, measured performance fixes,
connection-pool experiments, load testing, deployment, and local computer shutdown
after completion. The user accepts test downtime and delegates routine choices.
The working window starts at 2026-10-11 16:31 UTC and lasts up to twelve hours.
Existing ownership, authentication, SSRF, durable acceptance, data integrity, and
database design gates remain requirements. The production VPS must stay running.

## Plan

1. Record the initial source/runtime state and inspect all persistence paths.
2. Capture current production health, effective pools, query statistics and read baseline.
3. Rank query/transaction issues; measure representative plans and query counts.
4. Implement small verified fixes and test connection budgets, reusing existing pools.
5. Run regression/integration and fault checks on isolated fixtures.
6. Build hash-pinned artifacts and deploy verified changes with recoverable backups.
7. Run bounded ramp, mixed workload, sixty-minute load and two-hour soak where feasible.
8. Reconcile accepted jobs, collect the final performance report, preserve evidence,
   finish cleanup and schedule local shutdown.

## Measurement contract

Keep dataset, owner cohort, request mix, release, timeout, generator location and
topology explicit. Record median/p95/p99, errors including timeouts/rejections,
actual RPS, connection waits, transaction duration, queue age and resource use.
Compare cold/warm and burst/stagger independently. Do not claim SQL causality
from client timing without phase evidence. Load uses owned synthetic targets.

Targets: ordinary API p95 <=500 ms/p99 <=1 s; report and durable admission
p95 <1 s/p99 <2 s; unexpected errors <0.1% at 150 modeled concurrent users.
The achieved capacity is the highest level meeting the complete workload contract.
These are exploratory CV-oriented experiment gates, not a replacement for the
accepted workload document's 1,000-client / 300-RPS goals or its stricter 300-ms
admission p95. Passing the local one-second gate does not satisfy that SLO.

## Risks and verification

- Preserve the dirty workspace; initial changes predate this execution.
- Budget PostgreSQL connections across all services, including admin headroom.
- Separate pools must not split operations requiring one atomic transaction.
- Run write EXPLAIN ANALYZE only on isolated databases.
- Preserve deduplication, publication watermark, cancellation and lease fencing.
- Keep credentials, raw response bodies and private backup evidence outside public reports.
- Deploy/restart and schema operations require concrete provenance and backups;
  the current user authorization covers downtime, not data loss.
- Verify job state and save the report before local shutdown.

## Progress

2026-10-11 16:31 UTC: execution started. Existing source already isolates the
Crawler ClickHouse read/write pools (7/3). Source defaults and production effective
configuration need independent reconciliation. Previous report records failed API
latency gates; these are the starting evidence, not a current benchmark.

## Verified changes and query audit ledger

This execution uses Ponytail full: fix measured or concrete issues without adding
infrastructure, splitting atomic transactions or rewriting existing schema.
Existing dirty changes are preserved and are not attributed to this execution.
The ledger records reviewed query families; it is not a claim that every query
was benchmarked against every production cardinality.

| Persistence area | Reviewed paths and decision | Evidence / remaining work |
| --- | --- | --- |
| Java authentication | User lookup, refresh row locking and session PK existence; retain Redis plus SQL revocation checks | Real PostgreSQL/Redis tests; production Redis blocks authentication |
| Java websites/scans | Owner-scoped CRUD/specifications, pagination, admission locks/idempotency and batched latest scan lookup | No proven list N+1; latest `DISTINCT ON scan.*` projection is a lower-priority candidate |
| Java report authorization | `ScanReportService` / `ScanRepository`: replace entity load with owner-scoped existence | New real-PG test: exactly one SQL statement, zero entity loads; wrong-owner/missing ID rejected |
| Java dashboard | `DashboardSummaryRepository`: one owner-scoped statement with filtered aggregates | Full-owner history aggregation may grow; no loaded production plan obtained |
| Java capture/site clone | Owner/idempotency lookups, bounded lists and write locks | Preserve ownership and row locks; no measured reason to rewrite |
| Java messaging | All `ControlMessagingRepository` enqueue/claim/complete/retry/inbox SQL | Preserve SKIP LOCKED, predecessor ordering and post-lock fencing; production claim workload still needs profiling |
| Go PostgreSQL | Command/cancel dedup, page/host claim, heartbeat, commit/discovery, analytics/event publication, expiry/recovery | Add `aggregate_type = 'SCAN'` in all three correlation lookups, reusing existing index; local decoy aggregate regression passes |
| Go ClickHouse | Batch writes/receipts, page/detail/summary and batched findings, read admission/transport | Existing 7/3 read/write split predates this execution; keep it. Warm physical reuse test now waits for asynchronous idle publication, without weakening dial-count/query-ID assertions |
| Capture PostgreSQL | `database.ts`: claims, fenced completion, resource/object staging, publication, report/object reads and GC | Existing PG + MinIO integration passes; per-resource writes remain a measured-workload candidate, not an assumed bug |
| Site-clone PostgreSQL | `site-database.ts`: ingestion/page/assembly, progress, cancellation, event and object GC | Global advisory claim lock, sweeps, counters and full-job assembly lists need large-job measurement; no unapproved batching/lock change |
| Capture ClickHouse | `analytics.ts`: publication, receipt/resource metadata queries | Fix unread first response holding its connection while the second query waits; consume first JSON before issuing second query, no extra pool |

Locations changed by this execution:

- `crawler/internal/postgres/store.go` and `store_integration_test.go`.
- `crawler/internal/analytics/clickhouse_integration_test.go` (test only).
- `capture-worker/src/analytics.ts` and `analytics.test.ts`: release each report
  response before acquiring another connection.
- `backend/src/main/java/com/weblens/scan/repository/ScanRepository.java`.
- `backend/src/main/java/com/weblens/scan/service/ScanReportService.java`.
- `backend/src/test/java/com/weblens/scan/service/ScanReportServiceTest.java`.
- `backend/src/test/java/com/weblens/persistence/FoundationPersistenceIT.java`.
- This report and `tools/load/database-performance-vps.ps1`.
- `tools/load/local-admission-probe.mjs`, its test and README: explicit validated
  local Hikari maximum, recorded in manifest and passed into Java; no production
  setting changed.

No Flyway migration, new index, pool expansion, authentication fallback, service
restart or application deployment has been performed by this execution.

Recovery correlation additionally has a decoy-aggregate assertion in the expiry
test; the complete Go suite was rerun with real local PG/ClickHouse and passed.
Capture progress uses a short repeatable-read snapshot for status counts and
page rows: do not parallelize those queries over separate pool connections and
lose consistency. Batched findings already avoids per-page report N+1. Discovery
batching must preserve the count of successful ON CONFLICT inserts under the
execution lock; simply counting candidate links would violate the page cap.

The Capture fix is a reproduced transport/pool bug, not a speculative SQL
parallelization. A loopback HTTP fixture uses the installed real ClickHouse JS
client, a single socket, 500 rows exceeding stream buffers, and bounded timeouts.
The original implementation fails with stream abort/ECONNRESET around 1.05 s;
the fixed implementation completes in approximately 170 ms for the fixture,
preserves two owner-scoped queries and correctly merged results. It also survives
a deliberately failed second query and a following successful report using the
same pool. This is not production latency evidence or a real ClickHouse-server
SQL benchmark. No new dependency or connection was added.
Five concurrent reports also complete through the same single-connection fixture.
The installed client implementation and the official
[ResultSet guidance](https://clickhouse.com/docs/integrations/language-clients/js/index#result-set-and-row-abstractions)
confirm that unread response streams keep connections busy until consumed or
destroyed; concurrency cannot safely compensate for retaining response sockets.

## Production evidence and connection budget

VPS: Windows Server 2019, eight logical CPUs, approximately 7 GiB RAM;
PostgreSQL 17.11. Application release remains
`6ade9332e2e4c4df12b304edecad5d756462143f`, with the October 5 auth patch.
Source HEAD is `e7bae1d8131d875f645dcee839db5b5167ed3185`; the dirty main workspace
is not a release checkout. Do not deploy it wholesale or use the older patch
manager's incompatible hardcoded base.

PostgreSQL `max_connections=100`, three superuser-reserved slots. Effective
Hikari maximum is 32; crawler PG maximum 20; Capture PG maximum 10. Total app
budget 62 leaves 35 non-superuser slots. The source Hikari default of 64 would
raise this to 94, leaving only three slots; preserve explicit production config
when building a later release. Observed Hikari active/pending were both zero,
with zero waiting PG locks/long transactions in the diagnostic snapshot. This
idle evidence does not prove capacity under load, but gives no reason to add pools.

Representative inbox correlation lookup: 4,826 production rows. Both baseline
and candidate used an index scan. Baseline five execution times were 42.711 ms
(cold), then 1.504/0.851/1.063/1.913 ms; candidate was
0.895/0.863/0.486/0.090/0.522 ms. Root shared blocks fell from 45 to 9; index-node
blocks from 39 to 3; no temporary spill. The added leading-index predicate also
prevents a different aggregate with the same UUID from supplying correlation.
There were zero non-SCAN SCAN_REQUESTED rows in the sampled production database.
Small sequential samples with unmatched cache state are query-plan evidence,
not a production API latency speedup claim. Historical cumulative sequential
scan counters are not proof of the current bottleneck.

Repeat read-only snapshot at 17:02 UTC: baseline execution
76.083/1.134/0.929/1.667/1.215 ms; candidate
0.543/0.756/0.629/0.573/0.767 ms. Shared blocks remained 45 versus 9. The retained
`vps-diagnostics.json` contains this second measurement.

`pg_stat_statements` is absent and `track_io_timing` is off. No production DDL,
extension enablement or statistics reset was performed.

## Production blocker

Layerbase returns this public error at Redis AUTH after successful TCP and
verified TLS: database held asleep under the Free-plan sleep requirement; paid
plan or provider support required. This is not evidence of an incorrect password
or SQL pool exhaustion. API login timed out at the five-second preflight, so
authenticated public end-to-end ramp/soak cannot run honestly.

ADR-019 explicitly requires the selected shared persistent Redis. Do not replace
it with local Redis, change provider persistence, reconstruct registry entries
or bypass checks with JWT-only authentication. No authenticated provider session
or provider API credential is available to perform the account action. Budget
authorization alone does not supply that capability. No questions were sent to
the user. Independent local verification continued.

Private sanitized diagnostics are retained outside the repository under
`C:\Users\HP\weblens-private-recovery-20261009-856a91f6c04346cc818afbc17329f105\database-performance-20261011\vps-diagnostics.json`.
The diagnostic script uses read-only PG sessions, validated targets, timeouts,
verified TLS, and output redaction; its no-network self-test passes in PowerShell
7 and Windows PowerShell 5.1.

At 17:02 UTC the PowerShell HTTP helper reported all readiness probes failed;
independent direct `curl --noproxy '*'` verification returned Crawler HTTP 200
(0.871 s), Capture HTTP 200 (0.234 s), and Backend HTTP 000 at the eight-second
timeout. Service state alone and helper failures are not proof all services are
down; the direct probes establish that the two workers are still ready.

## Regression/build verification

- Backend candidate: 105 unit tests and 45 integration tests; zero failures,
  errors or skips. Critical integration evidence gate and its self-test PASS.
- Baseline backend: 105 unit tests and 44 integration tests PASS.
- Go complete suite with real local PostgreSQL and ClickHouse PASS; `go build
  ./...` and `go vet ./...` PASS. Windows race testing was not executed because
  CGO C compiler is unavailable; no race-pass claim.
- Capture baseline unit invocation: 56 PASS / 10 SKIP (browser/DB/S3 prerequisites).
  After the response-consumption regression was added: 57 PASS / 10 SKIP.
  Separately configured real PostgreSQL + MinIO integration: 4 PASS / 0 SKIP.
  Capture TypeScript typecheck and build PASS.
- Admission evidence parser/reconciliation tests: 6 PASS / 0 SKIP.

## Isolated load measurements

Run `admission-81942447-7cc9-47ba-88a4-f283985a94e4` finished 17:06:05 UTC.
Hashed snapshot clean verify + critical IT gate PASS. Source digest
`5138083cec3dc715ba227d22cb6e595bb6089300a1ef5b6d226665296d466ff0`; JAR SHA-256
`becd22bb7afbd6af4ae63e029e6def0c4e4d20a734754ee590aec48f3ec3ca15`.
Local host: Windows x64, 16 logical CPUs / 33,622,609,920 bytes RAM. Java heap
256..768 MiB; PG 17.6 container 512 MiB, Redis 7.4 container 128 MiB;
Hikari 64 maximum / 16 minimum idle. Generator and target share this host.

Workload: one round, 150 distinct owners/websites, paced registration/login,
then one simultaneous POST per idempotency key, five-second timeout, no replay.
No active connection warmup or staggering; JVM/DB are not guaranteed cold after
auth setup. Dispatchers disabled; synthetic websites are not fetched.

- 150/150 HTTP 202; 150 matching committed QUEUED scans plus PENDING outbox.
- Zero HTTP0, failures, unresolved identities or missing commit/timing evidence.
- Wall elapsed median 494.5 ms, p95 598.55 ms, p99 616.06 ms, max 624 ms.
- HTTP duration p95 596.001 ms / p99 603.974 ms.
- k6 latency/error thresholds PASS (exit zero); in its flat summary, threshold
  boolean `false` means the threshold did not fail, not that it failed.
- Both owned ephemeral containers/anonymous volumes removed; source/build and
  evidence remain under `tmp/load/admission-81942447-7cc9-47ba-88a4-f283985a94e4`.

This establishes admission durability in this local burst only. It is not
sustained RPS, 150 production CCU, scan completion throughput, a mixed read/write
benchmark, or matched before/after evidence for either query change.
Run `admission-39e44fef-e9ce-4bfd-a4c0-5e74ac9376ee` uses maximum 32 / minimum
idle 16, two rounds and the same backend/input source digest as the first run.
Only the maximum matches VPS; production minimum idle is four, and host/topology
are different. Round 1: 150/150 accepted and committed, zero unresolved, wall
median 545 ms / p95 654.55 ms / p99 661.06 ms / max 671 ms; gate PASS. The
32-versus-64 comparison is not randomized or repeated at 64, and has no
continuous pool/host telemetry, so it does not establish a causal best pool size.
Round 2: 150/150 accepted and committed, zero HTTP0/unresolved; wall median
204.5 ms / p95 298 ms / p99 320.51 ms / max 343 ms, gate PASS. The run finished
17:24:23 UTC with both owned containers/anonymous volumes removed and the Java
listener stopped; their absence was independently checked. JVM, cache and dataset
changed between rounds; the faster second round does not prove a pool advantage.

| Local burst | Hikari max/min | Accepted + committed | Wall p95 | Wall p99 |
| --- | --- | --- | --- | --- |
| Run A / round 1 | 64 / 16 | 150 / 150 | 598.55 ms | 616.06 ms |
| Run B / round 1 | 32 / 16 | 150 / 150 | 654.55 ms | 661.06 ms |
| Run B / round 2 | 32 / 16 | 150 / 150 | 298 ms | 320.51 ms |

All three independent-owner one-shot bursts pass their exploratory gates;
450/450 identities reconcile durably. Do not pool their percentiles, count them
as 450 simultaneous users, or report the setup-inclusive k6 RPS as sustained
admission throughput. Six local transport test reports also do not count as
production CCU.

## Release decision and remaining work

**NO-GO for deployment/capacity certification while production authentication is
blocked.** Verified source fixes and local tests are completed independently;
public production end-to-end acceptance is not completed. The twelve-hour window
is an upper execution allowance, not proof that an unavailable provider account
action can be completed by waiting or generating more failing requests.

Resume order (no account changes or security bypass were made here):

1. Restore the selected Layerbase instance through an authenticated paid-plan or
   provider-support action, retaining existing shared persistence and keys.
2. Verify AUTH/PING, Backend readiness and a real owned login through Caddy/TLS.
3. Isolate a reviewed release from the actual deployed base and preserve the
   October 5 auth patch. Apply only intended changes; clean-build/test, hash and
   back up before service replacement. Keep explicit Hikari maximum 32 initially.
4. Compare identical owned datasets and workload on current/candidate artifacts.
   Measure read mixes separately from one-shot admission and background crawling;
   collect pool waits, CPU/RAM, PG locks/transactions, queue age and ClickHouse
   backlog. Increase/split a pool only if evidence supports it within the total
   database budget. Do not infer production settings from local burst alone.
5. Run ramp, sustained mixed load, soak and failure/recovery checks; reconcile all
   accepted identities and publication counts before publishing capacity on CV.
   Approved workload/SLO goals remain targets until proven.

No production data or shared-provider state was deleted. Disposable local probe
containers/anonymous volumes are intentionally destroyed by their ownership-
checked cleanup; source and evidence are retained. Existing dependency volumes,
other projects and the VPS are preserved.

## Handoff and local shutdown

Final execution outcome: **local code/regression/admission checks PASS;
production deployment, mixed-load capacity and soak BLOCKED/NOT EXECUTED**.
Final VPS check at 2026-10-11 17:27:04 UTC still returns the same Free-plan sleep
error at Redis AUTH. Backend/crawler/capture artifact hashes match the initial
inventory; all six WebLens Windows services remain Running. This does not mean
Backend readiness or authentication is healthy. Runtime evidence is saved in
`vps-final-runtime.json` in the private evidence directory.
No full-stack VPS CCU value is established. Source is saved in the original dirty
workspace, not committed or deployed. Reviewed-file recovery copies, source
hashes, sanitized runtime diagnostics and local result summaries are retained in
the private evidence directory; full local runner evidence stays under `tmp/load`.
Edited files passed UTF-8 validation and scoped `git diff --check`.

All test/probe processes must finish and owned ephemeral cleanup must be verified
before requesting local Windows shutdown. Only the local computer is targeted;
there is no VPS shutdown command. Use graceful shutdown with timeout zero and
without `/f`, after a short hidden-helper delay to allow the handoff to be saved;
do not force-close unsaved applications. An OS application veto can prevent
shutdown, and physical power-off cannot be verified from an already ended session.

## What the developer should understand before accepting this code

An existence query avoids entity hydration but is not fewer than one SQL call;
authorization still requires owner predicates. Composite-index leading columns
matter even when the old plan already says Index Scan. More connections do not
create more database capacity, and separate pools must not divide atomic work.
SKIP LOCKED, idempotency, durable outbox, lease generation and post-lock expiry
checks are correctness boundaries, not disposable performance overhead.
Client percentiles, SQL execution time and asynchronous scan completion are
different measurements. Local admission-only load cannot establish VPS CCU.
