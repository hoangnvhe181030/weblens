# WebLens reliability staging và release gate — 2026-10-09

## Quyết định cuối phiên

**NO-GO production; không shutdown Windows.** Local staging đã chạy được full
path Java Control Plane → Go Crawler → PostgreSQL/ClickHouse, nhưng production
gate vẫn mở. Không deploy VPS, không DDL, không restart production và không đổi
timeout/pool.

## Những gì đã chạy trong phiên này

- Khởi động lại các dependency local có ownership WebLens: PostgreSQL control,
  PostgreSQL crawler/capture, ClickHouse 26.3, Redis và MinIO. Volume được giữ
  nguyên; không dùng `down -v`.
- Crawler migration local hoàn tất; ClickHouse batch integration PASS và
  `go vet ./...` PASS.
- Backend `mvn -B verify`: **105 unit + 44 integration, 0 fail/skip**. Các test
  có crash-recovery dispatch, auth/Redis/session persistence, Flyway/persistence,
  cancellation và Java→Go transport.
- Full-stack local chạy ở cổng cô lập `18080` (8080 bị AgentService giữ) với
  Crawler ở `8081`. Registration → website → scan admission → crawl hoàn tất:
  scan `51de5b69-f746-458c-a442-c24ffef5ae85` đạt `COMPLETED`, analytics
  expected/published `1/1`.
- Read API cùng identity: 3 lượt 200, 105.618–203.612 ms, cùng một body/item.
- Ma trận read API 3 vòng:
  - stagger 9 × 3: 27/27 200, failure 0%, p95 127.822 ms, max 152.319 ms.
  - burst 8 × 3: 24/24 200, failure 0%, max 270.376 ms.
  - burst 9: có 503 `SCAN_REPORT_BUSY`; đây là bulkhead bảo vệ đúng thiết kế,
    nhưng là failure nếu workload production yêu cầu 9 concurrent requests.
    Không dùng lượt này để tuyên bố error budget <1%.
- Kill/restart Crawler sau khi scan được accepted: scan mới
  `171d67c3-d1d4-478a-ad2e-f3de1f3d7747` vẫn `COMPLETED`, expected/published
  `1/1`. Crawler PostgreSQL có một analytics outbox record; ClickHouse có một
  ingestion receipt, một page fact và hai findings — không duplicate.
- Capture Worker: `npm test` **56 pass, 10 skip, 0 fail** (skip chỉ browser
  smoke); `typecheck` và `build` PASS. Với PostgreSQL capture + MinIO thật,
  `npm run test:integration` **4/4 pass, 0 skip**; gồm lease fencing, retry,
  cancellation/GC và object put/copy/integrity/delete.

## Bằng chứng production read-only bổ sung — 2026-10-09/10 UTC

- VPS vẫn ở release `6ade9332e2e4c4df12b304edecad5d756462143f`, host
  `WIN-D1G2GS3O7J7`; probe SSH chỉ đọc xác nhận Control Plane `8080`, Crawler
  `/health/ready` `8081` và Capture `/health/ready` `8082` đều HTTP 200 / `UP`.
- Exact native diagnostic trên VPS: **6/6 exit 0** (3 vòng baseline + candidate),
  body hash ổn định; p95 baseline khoảng **1,401 ms**, candidate khoảng
  **1,389 ms**. Cả hai vẫn fail gate p95 `<1 s`; chênh lệch này chưa đủ để
  kết luận causal improvement.
- Read-only API monitor dùng đúng owner/scan đã có, 1 VU, cửa sổ 30 giây,
  không POST/DDL/replay. Vòng đầu dừng theo fail-fast: HTTP failure `0%`,
  nhưng p95 tổng read khoảng **1.40 s**; `dashboard_summary` 358 ms,
  `scan_list` 812 ms, `scan_pages` 1.47 s, `scan_progress` 1.62 s,
  `website_list` 979 ms. Gate p95/p99 của read monitor **FAILED** dù mọi
  check dữ liệu đều đúng. Evidence riêng nằm ngoài repo tại
  `C:\Users\HP\weblens-private-recovery-20261009-856a91f6c04346cc818afbc17329f105`;
  report không chứa token, password hay response body.

## Failure/risk evidence không được che giấu

- Go Windows full suite vẫn fail tại `TestNativeTLSColdWarmIntegration`: sau
  query, driver stats quan sát `Open=0, Idle=0` thay vì kỳ vọng pooled idle. Đây
  là test/runtime portability issue cần tái hiện trên Linux candidate trước khi
  coi native TLS reuse đã được chứng minh trên Windows; không sửa production để
  làm xanh test.
- Lượt local burst 9 chứng minh capacity boundary: request thứ 9 bị 503. Không
  tăng semaphore hoặc pool khi chưa có workload/contract production.
- Production API baseline trước đó vẫn **4/20 pages timeout (20%)**, p95 bị
  censor khoảng 5 giây; failed window chưa có exact Crawler query-log record.
  Staging local không xoá được bằng chứng production này.
- Read-only monitor mới không tạo timeout nhưng vẫn vượt p95: lỗi latency còn
  tái hiện ở tải 1 VU; không chữa bằng tăng timeout, pool hoặc semaphore khi
  chưa có root-cause trace và workload contract.
- Local staging không có Caddy/TLS production topology, không phải benchmark
  Cloud ClickHouse, không chứng minh RPO/RTO full-stack hay browser capacity
  production.

## Artifact và provenance

- API matrix: `tmp/load/staging-api-matrix.json`
- Crawler restart: `tmp/load/staging-crawler-restart.json` (status và counts;
  token không lưu)
- Burst capacity diagnostic: `tmp/load/staging-burst-diagnostic.json`
- Crawler log/binary: `tmp/load/staging-crawler.log`,
  `tmp/load/staging-crawler.exe`
- Backend log: `tmp/load/staging-backend.log`
- Previous native/production evidence: `CLICKHOUSE_NATIVE_PHASE_TRIAGE_2026-10-09.md`,
  `RELIABILITY_FINAL_DECISION_2026-10-09.md`.

## Release gate còn mở

1. Re-run native candidate on owned Linux/staging topology with exact
   correlation → Caddy → Java → Crawler → query-ID join; resolve Windows stats
   portability classification.
2. Match production API cohort and prove p95 <1 s, failure <1%, admission p95
   <1 s/p99 <2 s, including timeout/429/503 and durable accepted identity.
3. Run worker kill/restart plus ClickHouse receipt→PostgreSQL ACK and object
   upload→COMMIT fault matrix on production-like services.
4. Full restore of PostgreSQL, ClickHouse/object and auth/session invariants;
   measure real RPO/RTO, then soak/backlog/DEAD/retry/lease/error-budget alerts.
5. Clean release build/provenance, fresh backup, canary/rollback and health/auth/
   queue postchecks.

Only after all gates pass may the decision change to GO, final completion report
be saved, and **then** local Windows may be shut down. VPS shutdown is never in
scope.

## What the developer should understand before accepting this code

Local full-stack success proves wiring, transaction boundaries, idempotency and
recovery behavior for this fixture; it does not prove production capacity. A
bulkhead 503 is safer than unbounded queueing, but its allowed concurrency must
be part of the measured API SLO. ClickHouse server receipt/fact counts prove
deduplication only for the tested scan; they do not replace a cross-service
restore drill or production query trace.
