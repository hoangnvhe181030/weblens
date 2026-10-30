# VPS local Redis and performance verification - 2026-10-12

## Scope and status

The user authorized installing and using local Redis and completing the existing
VPS work. This is a continuation of the [October 11 query audit](DATABASE_PERFORMANCE_EXECUTION_2026-10-11.md),
not a new twelve-hour deadline or a request to shut down the VPS or laptop.
Authentication, ownership, SSRF, durable acceptance, schema gates and user changes
remain protected. No production DDL, schema migration, index, SQL-pool expansion,
Git push or wholesale deployment of the dirty workspace is included.

Final deployment record at 06:47:59 UTC: local Redis deployed and verified; all six runtime
services healthy; warm read-only 100-RPS/10-minute verification passed. Overall
full workload remains **NO_GO**: 300-RPS read overload failed, cold/idle reports
failed, and fresh scan-to-capture E2E timed out behind the historical Crawler
event outbox. Existing-page Chromium capture passed separately. Failed SLO tests
are not capacity certification. No further SQL/ClickHouse pools were expanded.

## Runtime and provenance

Windows Server 2019; eight logical CPUs; approximately 7 GiB RAM. Public origin:
`https://jobnext.top`. PostgreSQL 17.11 listens on loopback port 5433.
Base release: `6ade9332e2e4c4df12b304edecad5d756462143f`. Candidate source was
isolated from this release and retained the October 5 Redis authentication patch.
The heavily modified main workspace was not deployed wholesale.

| Artifact/profile | SHA-256 | Result |
| --- | --- | --- |
| Backend owner-scoped report authorization | `abe278442e39d4998178bb5edc85d35d9e644d3d82f653c573c403c58897a2ae` | Deployed; no entity hydration for the authorization check |
| Capture `dist/analytics.js` | `bf01a061d932d84bb2cf49dc142fa0f9522d243cf799eeb95a80bc65dcb3b29d` | Deployed; consume response before another connection acquisition |
| Native Crawler candidate | `a5fc36ba6c81d87092012cb0a70cd7b105dad8b0d14439d328a8d7c5cc99181d` | Failed report baseline; restored original before HTTPS rollout |
| HTTPS Crawler, read 7/write 3 | `382669af30366438477388b060be187e8547e9c8c1cc0e452e4bf8e04a9d3e4e` | Deployed; load experiment below |
| HTTPS configurable read budget candidate | `b547d9eca591281004ee6d624ff2961b11f95127976668b715affa6c05883eb2` | Deployed at 04:57 UTC with read 24/write 3; warm 100 RPS passed, 300 RPS and cold/idle failed |

Original Backend/Crawler/Capture hashes are retained in deployment manifests and
recoverable artifact backups. Crawler source archives retain AGPL LICENSE and
provenance. Read-7 HTTPS source archive: `7ffe95b54165404dcce6b38846c7bb69c8599dd433547ac0038d087b6888a1d6`.
Read-budget source archive: `bdc3eaf101acf95753aade507a431e59d24c6a2549ba7c6742a64f872a8f0eac`.
Private retention is not a published AGPL network source offer; source-offer and
normal release-promotion work remain separate obligations.

## Local Redis: completed

Service `WebLensRedis`, virtual account `NT SERVICE\WebLensRedis`, Redis 8.2.10
community Cygwin Windows port. It is bound only to `127.0.0.1:6379`, protected
mode is enabled, and the dedicated `weblens` ACL user is namespace-restricted.
No public Redis port or shared Layerbase data/configuration was changed.
Config, credentials, persistence, private Cygwin filesystem mapping and backups
have restricted Windows ACLs. Backend depends on PostgreSQL and Redis services.

Memory is bounded at 128 MiB with `noeviction`; AOF everysec plus RDB is enabled.
The installer verifies unauthenticated rejection, SET PXAT, refresh Lua CAS,
replay rejection, exact key value/absolute TTL after restart and file permissions.
Actual access and refresh credentials also survived Redis and Backend restarts;
logout still invalidated access. Authentication smoke: 17/17 checks passed.
At 06:09 UTC an actual background RDB save increased rdb_saves from 9 to 10,
and an actual background AOF rewrite increased aof_rewrites from 0 to 1; both
completed with status ok. This verifies the Windows port's fork-based operations
for this small registry, not arbitrary dataset size or crash recovery.
Redis diagnostics showed about 811 KiB used, no evictions/rejected connections
and healthy AOF/RDB write status at that snapshot.

No SQL-session backfill or JWT-only fallback was added. Redis is a positive
session registry; PostgreSQL remains authoritative for durable revocation. A
missing Redis session requires login, and a stale Redis snapshot cannot revive a
SQL-revoked session. AOF everysec is not zero-loss crash recovery.

This Windows port is a personal-project experiment, not vendor-supported Redis
production/HA. Redis, Java and PostgreSQL share one failure domain. A supported
Windows product with appropriate licensing or Linux Redis is the next deployment
choice when vendor support matters.

## Query/transport fixes and connection budgets

The prior audit ledger covers Java auth/websites/scans/dashboard/messaging,
Crawler PostgreSQL and ClickHouse, Capture and site-clone persistence. It does
not claim that every query has a loaded production EXPLAIN benchmark.

The deployed query fixes are owner-scoped existence authorization, the existing
index's `aggregate_type = 'SCAN'` predicate in three inbox correlation lookups,
and releasing the first Capture ClickHouse response before requesting the next.
Ownership, batching, locks, fencing, publication watermarks and consistency are
preserved. No caching was added to hide freshness or ownership behavior.

Native production phase logs showed about 100 ms TCP/TLS followed by roughly
4.9 seconds native setup, reaching the five-second acquisition deadline. This
was transport/acquisition evidence, not a SQL execution-time measurement.
The existing clickhouse-go v2.43.0 supports the opt-in HTTPS transport, so no
dependency upgrade was needed. TLS certificate/hostname checking and TLS 1.2
minimum remain enabled. HTTP uses gzip level 1; native retains LZ4. Crawler
migrations explicitly refuse the HTTP override because existing DDL handling
depends on structured native exceptions. Production migration-on-start is false.

PostgreSQL app budgets remain Backend 32/minimum 4, Crawler 20/minimum 2 and
Capture 10: total 62 under max_connections 100 with three reserved slots.
The earlier read-7 collector sampled Hikari active maximum 3, pending maximum 0
and timeout count 0. Tomcat reached 100 busy threads during that overload. Host
CPU maximum was 58.2%, and free RAM minimum approximately 1.64 GiB. These are
sampled host observations, not proof that no short resource spike occurred.
Unrelated browser processes remained running and were not terminated.

The read-7 load phase showed ClickHouse report admission p95 about 1.50 seconds
versus query/read p95 about 131 ms across 6,854 slow timing records; the pool
reached all seven slots. These logs are threshold-selected, not all-query
percentiles. The deployed bounded read-24 experiment keeps three dedicated
writer connections and retains up to 24 idle HTTPS connections. Live ClickHouse
settings reported all-user concurrent query limit 1000, per-user limit 0 and
max_threads 4; provider account/billing quotas were not verified or changed.

## Load contract and known results

Generator is off-host on the developer machine. Authentication is paced and
excluded from activity metrics. Requests use distinct synthetic owners and
existing owned scan data; 146 of the 150-owner cohort have scans, four use only
dashboard/website/history. No scan-admission retry is hidden in these read tests.
Configured VUs, distinct participating owners, achieved RPS and simultaneous
in-flight requests are different measurements; none proves 1000 CCU.

Exploratory gates: ordinary API p95 <500 ms/p99 <1 s, report/overall p95 <1 s/p99
<2 s, unexpected activity errors <0.1%, no dropped arrival-rate iterations. The
earlier read-7 run used the prior p95/error-1% gates with p99 recorded. Subsequent
verification uses the stricter script and records its SHA. These experiments do
not replace the accepted 1000-client/300-RPS workload or admission p95 <300 ms.

| Profile / workload | Activity errors | Report p95 / p99 | Interpretation |
| --- | --- | --- | --- |
| Clean original baseline, 25 owners/60 s | 0/412 | 6609.8 / 6750.7 ms | Failed report latency gate |
| Native candidate, 25 owners/60 s | 57/328 (17.38%) | All 57 report requests failed | Negative result; original restored |
| HTTPS 7/3 baseline, 25 owners/60 s | 0/475 | 2490.3 / 2558.7 ms | Ordinary API p95 47-69 ms; report gate failed |
| HTTPS 7/3, 50 owners/120 s | 0/9607 | 1215.1 / 2081.4 ms | Approximately 80 nominal RPS; report gate failed |
| HTTPS 7/3, 150 owners/300 offered RPS/180 s | 0/21464 | 6186.2 / 6869.8 ms | 32537 dropped iterations; did not sustain offered load |
| HTTPS 7/3, 150 owners/100 offered RPS/10 min | 0/59602 | 2665.9 / 4900.6 ms | 99.315 completed RPS, 399 drops; gate failed |
| HTTPS 24/3, 25 owners/60 s after idle interval | 25/435 (5.75%) | 5466.2 / 6657.7 ms | One timeout and 24 report 503s; negative cold/idle evidence |
| HTTPS 24/3, 50 owners/120 s warm read diagnostic | 0/9949 | 586.7 / 950.6 ms | Exit 0 on stricter read gates; ordinary API p95 51.9-57.1 ms |
| HTTPS 24/3, 150 owners/300 offered RPS/180 s | 1/49955 (0.002%) | 2422.3 / 2792.0 ms | 4046 drops; ordinary API gates pass, report/overall/drop gates fail |
| HTTPS 24/3, 150 owners/100 offered RPS/10 min | 0/60000 | 443.6 / 987.8 ms | 99.9867 completed RPS, zero drops; all stricter warm read gates pass |

The first original baseline overlapped a roughly 1 GiB PostgreSQL backup and is
explicitly confounded; it is not a causal comparison. Setup/teardown and late
request completions are excluded from the analyzer's nominal-window RPS.
Exit code 99 means failed SLO, not successful completion of a capacity target.

The final analyzer verified 50/150/150 distinct participating owners and exit
codes 0/99/0. Completed requests inside each nominal activity window were
82.8333, 276.9333 and 99.9867 RPS respectively. At 100 offered RPS, ordinary API
p95 was 36.2-41.6 ms, p99 68.3-164.7 ms; overall activity p95/p99 was
378.8/447.2 ms. Report p99 is reported separately because combining endpoints
can hide a slower tail. The 150-owner arrival-rate cohort does not establish
150 simultaneous active clients, fresh-scan throughput or 1000 CCU.

The read-24 collector recorded 41 samples from 06:19:34 to 06:44:46 UTC. Across
the run, host CPU reached 97.6%, free RAM fell to 0.759 GiB, Hikari active reached
2 with pending/timeouts both zero, and Tomcat busy reached 94. Within the
100-RPS activity window, 17 samples showed CPU at most 50.9% and free RAM at
least 1.928 GiB. The last sample after load showed CPU 9.6%, free RAM 1.995 GiB,
all runtime services running and no WebLens browser process. The requested
20-second interval is not the actual sampling cadence: collection adds overhead,
and only three samples fell within the 300-RPS window. Short spikes may be missed.
No further pool increase is justified by these measurements.

The off-host generator recorded 67 samples. In the 300-RPS activity window,
eight samples showed CPU at most 14% and free RAM at least 8.044 GiB. Across
the complete run, CPU reached 41% and free RAM minimum was 7.050 GiB. There was
no sampled generator CPU/RAM saturation; network/distributed-generator limits
were not certified. The warm results do not erase the cold/idle failure or prove
that the improvement was caused solely by pool size. The workload reads existing
data and does not measure simultaneous crawl/browser execution.

## Tests, backup and limitations

- Backend isolated candidate: 95 unit tests and 19 real PostgreSQL/Redis tests
  passed, none skipped in the selected integration set.
- Capture: typecheck/build passed; three analytics regressions passed; full suite
  53 passed and nine browser/external-fixture tests skipped.
- Crawler: complete Go tests/vet/build passed with real local PostgreSQL and
  ClickHouse using HTTPS; complete tests/vet also passed with the HTTP override
  unset. Coverage includes owner isolation, idempotent replay, native TLS cold/warm
  physical reuse, untrusted TLS rejection, short-deadline cancellation/slot release
  and read-budget bounds. Current Windows race testing was not run because the
  required CGO compiler was unavailable; an older Linux run is a different artifact.
- Installer lifecycle smoke: six passed. Patch manager smoke: nine passed.
  Collector schema smoke, k6 offline checks and analyzer selftest passed.
  Final k6 offline checks, analyzer selftest and fixture-route smoke passed again.
  UTF-8/encoding checks passed for all 13 scoped localized/config/script files;
  no encoding repair was needed. Scoped git diff --check passed; Git emitted only
  normal Windows LF-to-CRLF conversion warnings. Pre-existing changes remain.
- Three fresh PostgreSQL custom archives total 971,635,767 bytes, with checksums and
  pg_restore --list checks. Full archives were copied to the ACL-protected off-host
  recovery directory and all three SHA-256 hashes matched. A list check is not a
  restore drill. A subsequent actual restore of all three archives passed on
  isolated PostgreSQL 17.6 with Docker network none, no exposed ports, two CPUs
  and 1.5 GiB memory. All indexes/constraints restored without pg_restore errors;
  public catalogs had 11/15/13 tables and 42/86/54 indexes, zero unvalidated
  constraints. The owned restore container/volume was removed afterward. This
  excludes production credentials/ownership grants (--no-owner/--no-acl), application
  workers and ClickHouse/R2; it is a PG data/schema drill, not whole-system recovery.
  The first fixture check refused an empty PortBindings object due to PowerShell
  truthiness; that fixture was removed, the guard was corrected to count binding
  properties, and both failed/successful proof files were preserved.
- Final stricter-profile read load and loopback JSON health passed as qualified
  above. Post-load auth passed all 17 checks at 06:46 UTC; artifact hashes and
  the disabled fixture route matched. A 60-minute load, two-hour soak and new
  150-scan admission campaign have not been completed. Fresh scan/capture E2E
  did not pass. Whole-system/ClickHouse/R2 recovery and public AGPL source-offer
  publication have not been completed.

## End-to-end findings and bounded repair

The managed fixture route was opened only under the deployment mutex. Public
health, leaf page and isolation checks passed. The first E2E scan
`232f0820-438e-466d-8f63-52b6d5623bbc` completed in Crawler with one succeeded
page and matching analytics expected/published counters, but Control Plane
initially stayed QUEUED for several minutes waiting for event delivery. Crawler
`ClaimEvents` was observed active for 30.6 seconds and waiting on DataFileRead.
Its production generic plan uses a sequential scan of the historical event
outbox. The existing claim index covers only PENDING, whereas the query includes
PENDING and DEAD. Adding an implied predicate or replacing the eligibility clock
with statement_timestamp did not remove the sequential scan in read-only EXPLAIN.
No production EXPLAIN ANALYZE write or unapproved index/DDL was executed. This
needs a separately gated workload/index or query redesign; the prior two-index
recovery approval does not cover a new claim index.

After delayed event delivery, the scan report became fresh. Capture
`30980cd8-56fa-4192-be78-0f102ea88baa` failed all three attempts with
CAPTURE_TIMEOUT under the existing Camoufox engine. The route was disabled and
the original Caddyfile hash restored even on failure. This is a failed E2E,
not a success proof.

The installed Playwright Chromium engine passed its real VPS browser smoke
(one test, zero skips), including screenshot and private-egress checks. At
06:03 UTC Capture was switched through its existing browser configuration to
`playwright`; no dependency, JS artifact, SSRF policy, external browser process
or rendering budget was changed. Readiness passed; a passing fresh E2E is still
required for full-workflow acceptance. The exact cause within Camoufox's timed-out launch/render
path was not established by these logs.

The fresh-scan E2E rerun timed out after 600 seconds while Control Plane still
showed QUEUED for scan `763522a2-c6c0-46ed-9646-7fd5183dfb68`; Crawler already
showed COMPLETED and matching 1/1 analytics counters. No event/data was deleted
or status manually advanced to pass this gate. The route was again disabled.
Read-only inspection at approximately 06:48 UTC found that this scan eventually
became COMPLETED/READY with one processed page, and both executions had matching
1/1 analytics counters. Event delivery eventually catching up does not turn the
600-second timeout into a passing E2E or establish an acceptable propagation SLO.

A narrower Capture test reused the previously completed owned scan. The first
route verification attempt failed and rolled back before creating a capture.
The manager's verification now uses bounded curl requests (matching the proven
service health checks) instead of intermittent Windows PowerShell web-request
checks. Its smoke covers JSON health, rejecting SPA-as-health, the exact leaf,
outside-route isolation, 404, HTTP failures and transport timeout. No response
or isolation criterion was relaxed.

At 06:18:57 UTC the existing-page test passed: Capture
`15440866-7e71-4f69-9f2f-e8331d0489ab` COMPLETED on Chromium 153.0.8010.12;
snapshot identity matched and the public owner-authenticated artifact was a
24,762-byte JPEG with SHA-256
`6bd0418ca2fa10a5fdd82b9ae8e0031fc124006dbd83f796ef153b95c2357379`.
The route was disabled and original Caddyfile hash restored afterward. This
verifies the browser repair on an existing fresh page; it does not pass the
fresh scan-to-capture E2E or repair the slow Crawler event outbox.

## Final evidence and rollback boundaries

The VPS sanitized deployment record is
`C:\ProgramData\WebLens\incoming\deployment-result-20261012.json`. It explicitly
records `overallFullWorkload=NO_GO`, `freshScanCaptureE2EPassed=false` and the
verified Redis/auth/existing-page capture results. Local sanitized copies are
under `tmp/releases/performance-local-redis-20261012/`: `deployment-result.json`,
`final-local-redis-proof.json`, `capture-existing-proof.json`,
`redis-background-proof.json`, `read24-final.jsonl` and `outbox-plans.json`.
The final auth proof is `tmp/releases/redis-production-20261005/auth-smoke-proof.json`.
Raw load and `analysis.json` remain in the ACL-protected off-host recovery folder
`local-redis-vps-load-7ae5a3959e0f4ac2be4721665c8d70ef`. Earlier negative profiles,
failed E2E evidence, artifact backups and source archives remain retained.
Owned test/restore containers and volumes were removed after checking ownership;
unrelated containers, browser processes and the pre-existing fixture service were
left alone. The public fixture route is disabled. No material user data was deleted.

Current environment SHA-256:
`855ab92ee66ccf1cb5d373801e1cf772b9b6486e1896023606a9dab4d065768d`.
Configuration changes must be undone in reverse order under the deployment
mutex, using their protected backups and checksum guards:

1. Chromium override: `incoming\capture-playwright-20261012`; predecessor
   environment `461da03652e3dd3d69f509e13088e607323c17a2dcec07e57d599ebf19289475`.
2. Read-24 override: `incoming\https-read-budget-20261012`; predecessor
   environment `743f5070fd6d880c8e843fcfa790a736d54760694d8f1322bff505a772121289`.
3. HTTPS override: `incoming\https-transport-20261012`; predecessor Redis-only
   environment begins `59b484` and is recorded in the original Redis manifest.
4. Only after these changes are undone may the Redis installer's original
   environment rollback guard match. Do not rewrite that guard to bypass it.

Artifact rollback is separate, using each patch manager's protected runtime
manifest; never guess a previous binary or replace the whole dirty workspace.
Returning to the sleeping shared Redis endpoint may restore configuration but
not authentication availability. These are rollback boundaries, not a claim that
the final composed deployment was rolled back and redeployed as a full drill.

Remaining work is separately scoped: workload-driven Crawler event-claim index
or query design through the database gates; cold/idle transport investigation;
then repeat fresh scan-to-capture, admission and sustained/distributed full load.
Do not bypass schema gates, weaken authorization or manually advance scan status
to turn a failed test green. Source publication and normal release promotion are
also still required before treating these isolated hot patches as a normal release.

## What the developer should understand before accepting this code

1. CCU describes a concurrency model; RPS describes request arrivals/completions;
   crawl throughput describes completed pages/jobs. They need separate workload
   evidence, and dropped arrivals invalidate an offered-RPS claim.
2. Redis and SQL have different responsibilities. Redis registration does not
   replace durable SQL revocation; outage handling must stay fail-closed.
3. A connection pool bounds resource ownership. Split analytics read/write pools
   protect ingestion, but increasing pool size is justified by measured waiting,
   not by assuming SQL is slow. Transactions requiring one snapshot stay on one
   connection.
4. Report latency includes authorization, admission, transport, queries,
   consumption and HTTP serialization. Client latency alone cannot identify the
   database bottleneck. Cold/warm behavior and matched configurations matter.
5. A reproducible release needs source/artifact hashes, protected rollback state,
   data backups and truthful failed-test evidence. An UP health response is not
   an SLO pass or a recovery guarantee.
