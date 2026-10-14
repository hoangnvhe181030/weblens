# Recovery index experiment — 2026-10-09

Trạng thái: **candidate/functional/negative checks hoàn tất;
COMPLETED_WITH_BASELINE_TIMEOUT, production BLOCK**.
Đây là báo cáo subphase, không báo cáo hoàn thành toàn bộ reliability rollout.
Scope hai logical index và runbook revision 1 đã được duyệt có điều kiện;
production execution vẫn BLOCK do preflight. Kết quả backup/restore và API gate
mới ở [production subphase](RECOVERY_PRODUCTION_SUBPHASE_2026-10-09.md).
Không deploy/push/commit, sửa runtime Java/Go/Capture hoặc applied migrations.

## Phương pháp và provenance

Runner `tools/load/recovery-index-probe.mjs`, Node standard library + Docker/Go
hiện hữu. Source crawler snapshot trước build; native migration-only CLI dùng
V1–V6 theo transactional checksum runner hiện tại. Không khởi động worker.
Baseline/candidate là hai database riêng trong cùng owned PostgreSQL container,
chạy tuần tự; exact fixture cardinality được kiểm tra trước đo ở runner mới.

- PostgreSQL 17.11-alpine; image ID
  `sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`.
- Windows host: 16 logical CPU, RAM 33.622.609.920 byte; container 2 CPU/1536 MiB.
- Crawler source digest ở smoke/representative đã đọc:
  `f3b7040cbcbf9d53c071ac58a134192bba27c1047455145e79c15a6a67997abc`.
- Mỗi artifact có manifest, runtime/image/binary/runner hash, migration logs và
  raw plans/write samples. Representative giữ runner source copy để truy nguyên.
  Hash định danh phép đo, không chứng minh clean release/reproducible build.
- Smoke: 15.000 page tháng 9 +15.000 tháng 10, 60.000 event mỗi database.
  Representative: 516.071 +780.640 page, 3.499.939 event mỗi database.
- Cardinality representative bắt nguồn từ estimate production, không clone thật;
  payload synthetic, mọi page ban đầu SUCCEEDED và event DELIVERED. Predicate
  lookup đo trạng thái **không có backlog**, chưa đo density PERSISTING/DEAD thật.
- 12 EXPLAIN ANALYZE BUFFERS/lookup, statement timeout 2 s/lock 500 ms.
  Giữ first sample riêng; không bảo đảm OS/JVM/cache cold. Với 12 mẫu nearest-rank
  p95 bằng max, không diễn giải như tail estimate dài hạn.
- 20 sample SQL status churn, 1.000 row/sample, server timing và WAL insert LSN
  delta. Page gồm cập nhật execution counter; event gồm insert/claim/DEAD/deliver.
  Event mutation filter synthetic theo aggregate_type/delivered_at, không mô phỏng
  runtime claim/predecessor query. Không suy overhead thực của worker từ assay này.
- WAL delta chưa gồm commit record và có thể gồm WAL background. Autovacuum chỉ
  tắt trên disposable server; không thay config production. Không đo peak temp,
  build WAL, concurrency, full ACK/lease/publish/ClickHouse hay API.
- Host không reserve; có workload Docker khác được quan sát trong đợt chạy.
  Không dừng/dọn workload đó. Không continuous host/container telemetry; các
  timings exploratory, không đạt yêu cầu matched production regression benchmark.

## Lỗi đã gặp và cách xử lý

| Artifact dưới `tmp/load/` | Kết quả | Diễn giải |
| --- | --- | --- |
| `recovery-index-cf23173b-4ab2-404f-81a8-c114f5c9b07f` | FAILED, 23514 | Fixture completion dùng now() ở partition tương lai, trái timestamp invariant; không lỗi runtime đã chứng minh |
| `recovery-index-b0f0145e-bc47-4443-a2a3-3a2e1248d51e` | FAILED, lỗi kết nối chưa có SQLSTATE | Không đủ stderr để gán root cause riêng artifact này |
| `recovery-index-adcb0b79-1b60-40d0-ae22-010a8983a428` | FAILED, database starting up | Socket readiness bắt server tạm của Docker image; sửa sang final TCP readiness |
| `recovery-index-9cea25ee-25b7-4ce5-96ca-f52d82459a00` | PASS smoke | Có fixture timestamp rejection 23514/ck_scan_pages_timestamps; chưa thêm negative build/rollback |
| `recovery-index-7fac41e7-d316-432b-b877-dc49aff1e5c0` | PASS smoke | Bao gồm negative build/cleanup/rollback |
| `recovery-index-3434bb2c-a204-4f34-a58e-8df20afa3cef` | FAILED representative, 57014 | Seed/history/page reads đã xong; chưa lưu event read samples, chưa chạy candidate |
| `recovery-index-42d41198-2f3c-4d14-b620-af491878c768` | FAILED representative, 57014 | phase chính xác `before: read events`, xác nhận lỗi ở lookup DEAD 2 s, không seed 180 s |
| `recovery-index-2e35aeeb-8183-4108-b806-6f7df7b35e99` | FAILED, 57014 sau candidate measurements | Functional/catalog đã đạt; negative block chưa lưu checkpoints từng bước, không gán chắc bước lỗi |
| `recovery-index-db149a93-b29e-4c32-825c-63bac65ad075` | COMPLETED_WITH_BASELINE_TIMEOUT | Candidate checks đạt, baseline/sau rollback DEAD vẫn TIMEOUT/UNKNOWN |

Đã đính chính update ban đầu gọi lỗi representative là seed timeout: evidence
final cho thấy **read events**. Chia fixture seed thành 50.000 page/100.000 event
không phải giải pháp cho lookup timeout; chỉ giới hạn transaction setup và giữ
cardinality/absolute IDs. Không sửa constraint, index nền hoặc dữ liệu production.
Fixture completion dùng greatest(discovered_at,clock_timestamp()); test cố ý đặt
completion trước discovery bị constraint hiện hữu từ chối. SQLSTATE/tên constraint
và phase được lưu, không log credentials. Các FAILED artifacts giữ nguyên.

Runner mới không cho baseline error thành false hoặc p95. Khi baseline read
57014, outcome toàn experiment là `COMPLETED_WITH_BASELINE_TIMEOUT` nếu candidate
và mọi check khác đạt; không PASS baseline. Candidate timeout, SQL/lock error
vẫn FAILED. Seed/count setup deadline riêng không nâng timeout đọc recovery 2 s.

## Smoke có negative checks — kết quả trước/sau

Artifact `recovery-index-7fac41e7-d316-432b-b877-dc49aff1e5c0`:

| Số đo server | Baseline | Candidate |
| --- | --- | --- |
| PERSISTING EXISTS median / p95, ms | 9,130 / 15,640 | 0,150 / 0,271 |
| DEAD EXISTS median / p95, ms | 16,560 / 18,678 | 0,044 / 0,071 |
| Page churn median / p95, ms mỗi 1.000 row | 152,749 / 197,359 | 203,053 / 522,146 |
| Event churn median / p95, ms mỗi 1.000 row | 92,871 / 149,309 | 117,349 / 169,761 |
| Page churn WAL median / p95, byte | 2.501.240 / 2.789.768 | 2.592.248 / 2.871.448 |
| Event churn WAL median / p95, byte | 2.291.016 / 2.360.776 | 2.369.304 / 2.442.216 |

Buffer ở first sample: pages 1.072 hit/0 read →2 hit/0 read;
events 5.455 hit/0 read →1 hit/0 read. Các large leaves chọn index; leaf rất nhỏ
có thể Seq Scan. Không ép planner. Không lấy p95 thành công thay attempt timeout.
Candidate page p95 tăng trong smoke; chưa tách index overhead khỏi background
work/cache/scheduling nên **không kết luận không regression** hoặc quy toàn bộ
chênh lệch cho index. WAL tăng cho thấy chi phí không bằng 0.

Build wall time gồm Docker/psql startup: event 293,30 ms, parent ONLY 265,30 ms,
leaf build khoảng 263,54–339,71 ms; không server-only build time.
Catalog sau churn và functional fixtures: page leaf indexes tổng 229.376 byte,
event 245.760 byte; parent metadata 0 byte. Không suy disk/WAL budget production
từ indexes nhỏ với predicate ban đầu rỗng hoặc từ total relation size delta.

## Representative

Lần dừng đầu: page EXISTS 12 mẫu, median 67,380/p95 91,483 ms, first sample
256 hit/46.056 read. Sau đó DEAD read timeout 2 s, không có p95 event; không
công bố speedup, write overhead hoặc candidate từ run này.
Không coi baseline timeout là PASS hoặc dùng nó để tính p95/speedup.

Run `2e35aeeb` đã đo candidate: pages median/p95 0,191/0,302 ms;
events 0,057/0,090 ms. Page churn 210,657/483,298 ms; event
296,905/420,857 ms. WAL median/p95 page 2.798.864/2.853.064 byte, event
2.356.792/2.383.784 byte. Event build wall 9.696,19 ms, populated leaf tháng 9/10
484,74/785,63 ms; Docker/psql overhead bao gồm trong wall time. Catalog sau churn
có page leaf indexes tổng 262.144 byte và event 270.336 byte, matching coverage
9 leaf gồm future/default, valid/ready/live. Tuy nhiên final outcome **FAILED**
ở `after: functional/negative checks`; không dùng measurements để gọi run PASS.
Giả thuyết chính là query global sau rollback quay về baseline timeout; thiếu
checkpoint không đủ khẳng định bước lỗi. Runner mới lưu checkpoints, cho phép
post-rollback 57014 chỉ với outcome TIMEOUT/value unknown, kiểm target fixture
bằng PK riêng. Candidate measurement/functional read vẫn không chấp nhận timeout.

Baseline run mới `recovery-index-2e35aeeb-8183-4108-b806-6f7df7b35e99` đã xác
nhận actual 1.296.711 page/3.499.939 event trước timing. Page median/p95
60,117/105,285 ms, first sample 416 hit/45.896 read. DEAD timeout ngay attempt
đầu; estimated plan Gather→parallel Seq Scan, executionMs null, không boolean.
Page churn median/p95 188,546/467,049 ms; event 298,672/563,107 ms.
WAL median/p95 page 2.717.984/2.770.056 byte, event 2.370.592/2.411.584 byte;
page WAL max 14.376.032 byte, nhắc rằng delta/FPI/checkpoint không ổn định theo
mỗi sample. Kích thước relation trước candidate: hai tháng page tổng
922.836.992 byte; event 3.436.306.432 byte, không bằng relation size production.

### Lượt cuối hoàn tất, 2026-10-09 12:23:17 +07:00

Artifact `recovery-index-db149a93-b29e-4c32-825c-63bac65ad075`, source digest giữ
nguyên ở trên; runner SHA-256
`efd99607ab9d8cd9ebba6f6faa9c680c147e121bcf2e61a00fb8c4344d037e2a`;
migration CLI SHA-256
`12ae09a0022a750d10875c472c47340e2a6985c4ba48504293b988fd1c1edaec`.
Actual seed cardinality của cả hai DB: 1.296.711 page/3.499.939 event, trước
20 churn samples và hai future/default fixtures bổ sung.

| Số đo | Baseline | Candidate |
| --- | --- | --- |
| PERSISTING EXISTS median / p95, ms | 60,626 / 70,655 | 0,175 / 0,392 |
| DEAD EXISTS median / p95, ms | TIMEOUT 2 s, không percentile | 0,048 / 0,063 |
| Page churn median / p95, ms mỗi 1.000 row | 140,909 / 176,255 | 154,131 / 252,635 |
| Event churn median / p95, ms mỗi 1.000 row | 141,813 / 321,398 | 177,199 / 214,101 |
| Page churn WAL median / p95, byte | 2.717.888 / 2.770.056 | 2.798.864 / 2.853.064 |
| Event churn WAL median / p95, byte | 2.370.568 / 2.427.600 | 2.356.816 / 2.383.784 |

Page first sample: 69,086 ms/416 hit/45.896 read →0,175 ms/2 hit/0 read.
Event candidate first sample 0,048 ms/1 hit/0 read; baseline có estimated
parallel Seq Scan, timeout không cung cấp actual buffers. Mỗi measured lookup
có đủ 12 samples; candidate populated leaves chọn partial index, không force planner.
Build wall event 5.412,84 ms, parent 280,80 ms, leaf tháng 9/10
410,73/520,35 ms. Candidate catalog cùng sizes run trước: page leaves tổng
262.144 byte, event 270.336 byte, parent 0; không build-WAL/temp budget.

Page write median/p95 tăng, event median tăng nhưng p95 giảm; page WAL tăng
và event WAL giảm nhẹ. Không suy chi phí index bằng 0 hoặc nguyên nhân chênh lệch
từ các delta này. Background workload/cache/checkpoint/SQL synthetic không được
kiểm soát đủ; **non-regression production chưa được chứng minh**. Không đổi gate.

Các negative checkpoints đạt: writer lock→55P03→invalid index→concurrent cleanup;
reader lock→parent DROP 55P03→parent còn valid; drain→parent/event DROP→indexes
absent. Target fixtures vẫn SUCCEEDED/DELIVERED qua PK lookup, history checksum
không đổi. Page global sau rollback trả false; DEAD global sau rollback timeout
57014/2 s, value UNKNOWN. Đây là tái hiện baseline path khi bỏ index, không làm
rollback thành recovery sạch. Lượt này hỗ trợ giả thuyết lỗi proof sau rollback
ở run `2e35aeeb`, nhưng không bổ sung checkpoint hồi tố cho run cũ.
Final outcome `COMPLETED_WITH_BASELINE_TIMEOUT`, removed=true, phase complete;
owned server không OOM. Không còn test session hoặc owned container của probe.

## Functional/negative evidence

Smoke và representative candidate chứng minh absent/present, orphan terminal tháng 9/10/default/future,
rollback invisible, DEAD transition, timeout 57014 không false, parent invalid
trước đủ leaf rồi valid/ready/live, partition mới tự có attached matching index.
Migration history/checksums giữ nguyên. Không thay tenant/FK/check constraints.

Negative: held writer khiến concurrent build 55P03 và để invalid candidate test;
concurrent cleanup verify absent. Held reader chặn normal parent DROP 55P03,
parent còn valid; drain fixture rồi parent DROP/event concurrent DROP thành công,
candidate indexes absent và lookup facts không đổi. Đây là SQL fault fixture,
**không** bằng chứng kill/restart worker hoặc VM crash thật, không restore drill.
Ở representative, global DEAD proof sau rollback vẫn UNKNOWN như mô tả trên;
chỉ target fixture state được đối chiếu trực tiếp, không claim global false.

Offline suite hiện 9/9 PASS, 0 fail/skip; node syntax check PASS.
Owned containers/anonymous test data của các run đã hoàn tất được xóa sau kiểm
UUID label; không xóa evidence hoặc container khác. Tất cả run trong bảng đã dừng
và cleanup; evidence FAILED giữ nguyên. UTF-8 check PASS, không sửa mojibake.

Files thuộc subphase: recovery probe/test, load README, recovery proposal,
runbook, báo cáo này và cập nhật preflight. Worktree lớn vẫn dirty; không review
toàn release diff, không chạy lại full Java/Capture suites trong subphase index.

## Java Control Plane, root cause và roadmap

Không đổi Java SQL/entity/transaction/dispatcher/auth. Hai index ở Crawler DB
chỉ giúp global recovery gate có phép đọc trực tiếp; shared-host CPU/I/O/WAL có
thể ảnh hưởng API gián tiếp. Không thêm distributed transaction/broker/cache.
Admission production 146/150 với 4 timeout, API p95 1030,47 ms/pages 1692,09 ms
vẫn chưa có matched-after; root cause **UNKNOWN**. Query recovery không chọn lọc
có bằng chứng plan và local timeout, không chứng minh nguyên nhân admission/API.

1. P0: review [runbook revision 1](../database/RECOVERY_INDEX_RUNBOOK.md), bổ sung
   WAL/temp/backup budget, matched API baseline, restore và headroom/mutex proof.
   Chỉ production DDL sau phê duyệt cụ thể và mọi preflight đạt; không fake history.
2. P0: verify catalog/EXISTS thật; verifier change riêng với error/true/unknown
   tests. Hai recovery proofs cách 15 s cùng mọi nguồn khác trước mở workload mới.
3. P1: staging TLS full-stack cold/warm × burst/stagger, 3 lượt/cell, hai phía
   telemetry và per-request correlation; giữ timeout/429/503/unknown. Baseline và
   candidate API phải cùng data/auth/workload. Local admission PASS không thay bước này.
4. P1: real kill/restart, downstream slow/outage, ClickHouse receipt→PG ACK,
   object upload→COMMIT; không mất durable work, stale lease không publish.
5. P1: restore PostgreSQL/analytics/object/auth invariants, đo RPO/RTO; soak và
   alert/runbook ownership. Sau đó clean scoped review/build, backup/canary/rollback,
   production provenance/health/auth/queue verification và báo cáo hoàn thành.

## What the developer should understand before accepting this code

Durable acceptance khác workflow completion. Partial index không miễn phí và
không chứng minh distributed consistency; catalog valid khác backlog sạch.
Timeout không phải false. Autocommit maintenance restartable khác migration
transactional. Ponytail giữ thay đổi trong tooling/evidence, không thêm runtime
dependency; PostgreSQL/Flyway skill giữ transaction/rollback gates, UTF-8 Guard
bảo toàn tiếng Việt. Production chưa hoàn tất: **không lên lịch shutdown local,
không tắt VPS**.
