# WebLens Reliability — quyết định cuối phiên 2026-10-09

## Quyết định

**NO-GO production / NO-GO shutdown.** Không deploy candidate, không chạy DDL,
không restart service production và chưa tắt máy Windows local.

Lý do trực tiếp: API read gate vẫn FAILED (4/20 pages timeout, failure20%,
p95 bị censor khoảng5 giây); staging full-stack candidate chưa chạy qua Java,
Caddy, Crawler, ClickHouse và production-like auth cùng một release; crash/restart
worker, ClickHouse receipt→PostgreSQL ACK, object upload→COMMIT và full-stack
restore/soak chưa có evidence PASS.

## Evidence đã đạt

- Native cancellation candidate: 18/18 fault cases PASS; baseline tương ứng
  6 PASS/12 FAIL. Deadline150ms khoảng150–152ms, capacity được trả.
- TLS physical reuse: cold1 dial, warm0 dial trên ba pool; server query ID khớp
  trace; Linux Go race/integration/vet/build 8 package PASS, 0 fail/skip/race.
- Java→Go loopback bridge: CrawlerReportClient timeout500ms truyền cancellation
  tới Go handler; pages/detail giữ correlation. Go HTTP/HTTPS race -count=3
  và vet PASS; Java targeted tests 10/10 PASS.
- Exact Cloud metadata của successful candidate window: 27 QueryStart +27
  QueryFinish, duration22–285ms, exception_code0, hai node.
- Failed API window và vùng mở rộng không có Crawler query-log record. Đây là
  UNKNOWN, không phải proof request không chạy.
- Backup/restore PostgreSQL cô lập và local recovery rehearsal trước đó đã có
  evidence riêng, nhưng không phải full-stack RPO/RTO.

## Evidence thất bại/rủi ro

- Production API baseline: 20 attempts, 4 pages timeout; Caddy status0/zero
  bytes; Crawler native TCP read/i/o timeout; admission wait0, pool open1/limit7.
- Probe đúng owner/scan: baseline 9/9 p95 1404.368ms; candidate 9/9 p95
  1192.891ms. Cùng body hash nhưng cả hai không đạt p95<1s; không suy causal
  improvement.
- Java readTimeout là inactivity timeout: slow-drip fixture vẫn hoàn tất
  khoảng1.9s với timeout750ms. Không tự đổi timeout vì chưa có contract/
  benchmark chứng minh nhu cầu.
- Crawler production chưa có query ID/correlation instrumentation mới; exact
  request→query join cho failed window chưa có.
- Workspace chính dirty lớn; candidate chỉ là worktree 6 tracked files, chưa
  commit/push/deploy.

## Cập nhật kiểm chứng cuối — 2026-10-10

- VPS không bị thay đổi: release vẫn `6ade9332e2e4c4df12b304edecad5d756462143f`;
  health read-only trên `8080`, Crawler `8081/health/ready` và Capture
  `8082/health/ready` đều trả `200 / UP`.
- Exact native probe 3 vòng baseline/candidate đạt **6/6** exit 0, nhưng p95
  baseline/candidate khoảng **1,401 / 1,389 ms**, đều không đạt `<1 s`.
- Read-only production monitor (1 VU, 30 s, fail-fast, không POST/DDL) có
  HTTP failure `0%` nhưng p95 tổng **~1.40 s**; riêng pages **1.47 s**,
  progress **1.62 s**, website list **979 ms**. Kết quả là
  **BASELINE_GATE_FAILED**. Đây là latency evidence mới, không phải bằng chứng
  causal cho native candidate.

## Gate trước khi đổi quyết định

1. Chạy staging full-stack từ candidate/auth-compatible release, cold/warm ×
   burst/stagger tối thiểu3 lượt/cell; join correlation→Caddy→Java→Crawler→
   query ID, giữ timeout/429/503.
2. API gate: p95<1s, failure<1%; admission p95<1s/p99<2s, failure<1%; mọi
   accepted identity có durable commit/outbox, không replay POST mù.
3. Kill/restart Crawler và Capture Worker; fault ClickHouse receipt→PG ACK,
   object upload→COMMIT; không mất accepted work, stale lease không publish,
   không duplicate facts.
4. Full-stack restore PostgreSQL + ClickHouse/object/auth invariants; đo RPO/RTO
   thật, rồi soak và alert/runbook ownership.
5. Clean release build/provenance, fresh backup, canary/rollback và health/auth/
   queue postcheck. Chỉ sau đó lưu report hoàn tất và shutdown local Windows.

Không thêm Kafka/Redis/Kubernetes, không đổi schema/migration, không tăng timeout
hoặc pool để vượt gate. Java Control Plane giữ transaction ngắn, idempotency,
outbox/inbox và owner authorization hiện tại.

Trạng thái sau cập nhật: **NO-GO production, NO-GO shutdown**. Không deploy
candidate, không restart VPS, không DDL/migration và không tăng timeout/pool.

## Artifact chính

- [Native phase triage](CLICKHOUSE_NATIVE_PHASE_TRIAGE_2026-10-09.md)
- [Java–Go bridge summary](../../tmp/load/http-transport-8f53920d10c448479bb4f0a14146ad0d/java-go-bridge-summary.json)
- [Sanitized phase summary](../../tmp/load/native-vps-probe-8d7ec671c8364a258a90eff979beeb4b/native-phase-sanitized-summary.json)
- [Latest candidate patch](../../tmp/load/native-vps-probe-8d7ec671c8364a258a90eff979beeb4b/native-phase-latest-candidate.patch)

UTF-8 và scoped whitespace checks PASS. Credentials, query text, response body và
crawled payload không nằm trong report/evidence sanitized.

## What the developer should understand before accepting this code

Một test local PASS chỉ chứng minh phase/contract đã test; không thay full-stack
capacity, production topology hoặc recovery proof. Server query duration khác
client query-and-read; HTTP timeout khác absolute deadline; accepted khác durable
commit và terminal workflow. Không được gọi production-ready khi còn một gate
UNVERIFIED/FAILED.
