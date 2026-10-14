# WebLens Reliable Backend Platform — final status 2026-10-10

## Quyết định

**NO-GO production / NO-GO shutdown.** Candidate chưa được deploy, production
không bị restart/DDL/migration, và Windows local không được tắt. Release đang
phục vụ vẫn là `6ade9332e2e4c4df12b304edecad5d756462143f`.

Lý do là gate latency production vẫn FAILED và một số gate recovery/restore còn
UNKNOWN. Không dùng native diagnostic PASS, warm sample hoặc server query time để
thay thế client end-to-end SLO.

## Phạm vi đã đối chiếu

- Java Spring Boot Control Plane: transaction boundary, admission, idempotency,
  outbox/inbox, auth/session, cancellation và API read path.
- Go Crawler: lease/fencing, cancellation bridge, PostgreSQL workflow và native
  ClickHouse path.
- Playwright Capture Worker: lease, retry, cancellation/GC, object integrity.
- Test, benchmark, release/health evidence và production Windows topology.

Đã giữ nguyên DESIGN_GATES và kiến trúc ba deployable; không thêm Kafka, Redis,
Kubernetes hay schema mới.

## Bằng chứng đạt

- Backend: 105 unit + 44 integration pass; Capture Worker: 56 unit pass,
  4/4 PostgreSQL + MinIO integration pass; Go vet/build và Java→Go cancellation
  bridge pass.
- Local full-stack scan hoàn tất, analytics expected/published `1/1`.
- Crawler kill/restart sau admission không làm mất work hoặc tạo duplicate
  ClickHouse fact/receipt trong fixture đã kiểm tra.
- VPS read-only health: Control Plane `8080`, Crawler `8081/health/ready`,
  Capture `8082/health/ready` đều HTTP `200 / UP`.
- Exact native diagnostic VPS: 6/6 exit 0; body hash ổn định. Baseline/candidate
  p95 khoảng `1,401 / 1,389 ms`; cả hai vẫn không đạt `<1 s`.

## Bằng chứng fail hoặc chưa đủ

- Production API baseline cũ: 4/20 page timeout, failure 20%, p95 bị censor
  khoảng 5 giây.
- Read-only production monitor mới (owner/scan hiện hữu, 1 VU, 30 s, fail-fast,
  không POST/DDL): HTTP failure `0%`, nhưng p95 tổng khoảng `1.40 s`; pages
  `1.47 s`, progress `1.62 s`, website list `979 ms`. Kết quả
  `BASELINE_GATE_FAILED`.
- Exact request → Caddy → Java → Crawler → ClickHouse query-id join cho failed
  window chưa có; thiếu join này thì root cause admission timeout chưa được
  chứng minh.
- Chưa có production-like fault matrix cho ClickHouse receipt→PostgreSQL ACK,
  object upload→COMMIT, Capture crash/restart; chưa có full-stack restore với
  RPO/RTO đo được; chưa có soak/backlog/DEAD/error-budget proof.
- Go Windows native TLS cold/warm test còn lỗi pool stats portability
  (`Open=0, Idle=0` sau query); cần phân loại trên Linux candidate.

## Roadmap gated

| Ưu tiên | Test/điều kiện | Acceptance criteria | Tác động Java Control Plane |
|---|---|---|---|
| P0 | Instrument và join correlation/Caddy/Java/Crawler/query-id; chạy cold/warm và stagger/burst cùng cohort | p95 read <1 s, failure <1%; admission p95 <1 s, p99 <2 s; accepted identity có durable commit/outbox | Giữ transaction ngắn; chỉ sửa root cause đã chứng minh, không tăng timeout/pool trước benchmark |
| P0 | Kill/restart Crawler + Capture; fault ClickHouse ACK và object COMMIT | Không mất accepted work, stale lease không publish, retry không duplicate facts/artifacts | Kiểm tra state machine, idempotency key, outbox/inbox và fencing |
| P0 | Restore PostgreSQL, ClickHouse/object, auth/session từ fresh backup | Invariant dữ liệu giữ nguyên; RPO/RTO thực đạt mục tiêu đã công bố | Không đổi schema; xác minh session/revocation và scan terminal state |
| P1 | Soak/backlog/retry/DEAD/lease và alert drill | Không tăng backlog vô hạn; alert có owner/runbook; error budget được đo | Xác minh dispatcher/bulkhead không gây starvation hoặc retry storm |
| P1 | Clean build, provenance, backup, canary/rollback, health/auth/queue postcheck | Hash release khớp, rollback thử được, mọi health gate pass | Chỉ deploy candidate sau khi toàn bộ P0/P1 PASS |

## Benchmark trước/sau bắt buộc

Giữ cùng dataset, cohort, topology, timeout và pool. Báo cáo median/p95/p99,
failure, admission wait, Caddy status/bytes, Java timing, Crawler native timing,
query-id và resource guard. Không so warm-only với cold baseline và không gán
causal improvement khi chưa có exact join.

## Artifact

- [Staging release gate](RELIABILITY_STAGING_RELEASE_GATE_2026-10-09.md)
- [Final decision](RELIABILITY_FINAL_DECISION_2026-10-09.md)
- [Native phase triage](CLICKHOUSE_NATIVE_PHASE_TRIAGE_2026-10-09.md)
- Private read evidence: `C:\Users\HP\weblens-private-recovery-20261009-856a91f6c04346cc818afbc17329f105`

Evidence private không chứa trong repo; report không lưu password, token, query
text hoặc response body.

## Kết luận vận hành

Không triển khai production và không shutdown Windows ở trạng thái hiện tại.
Giữ nguyên release đang chạy, giữ volume/backup, và chỉ đổi sang GO sau khi mọi
gate P0/P1 chuyển từ FAILED/UNKNOWN sang PASS bằng evidence cùng topology.
