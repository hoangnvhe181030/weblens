# Hồ sơ workload cho SEO metadata, rendered evidence và performance

Trạng thái: **Đã được người dùng duyệt và cho phép triển khai ngày 2026-09-13**.
Các migration được triển khai theo hướng tiến tới, không sửa migration đã áp dụng.

Tài liệu này tuân theo `DESIGN_GATES.md`. Các giá trị đã có nguồn được kế thừa từ
`WORKLOAD_PROFILE_V1_V1_5.md` và `PRODUCTION_HIGH_CAPACITY_WORKLOAD.md`. Giá trị
chưa được người dùng quyết định được ghi là **chưa biết**, không được thay bằng
giả thuyết ngầm.

## 1. Yêu cầu nghiệp vụ

Đã xác nhận từ yêu cầu hiện tại:

- WebLens cần thu thêm SEO metadata và Social/SEO signal tương ứng với phần có ích
  của CrawlObserver.
- WebLens cần quan sát DOM sau JavaScript và performance bằng browser thật.
- Crawler HTTP và browser capture tiếp tục là hai service boundary riêng.
- Kết quả phải phục vụ page detail/report và không được trình bày dữ liệu thiếu
  như phép đo thành công.

Phạm vi đã duyệt:

- Static SEO: meta keywords, H3–H6, canonical self/non-self, indexability reason,
  `X-Robots-Tag`, hreflang, Open Graph title/description/image và Schema.org type.
- Rendered SEO: title, description, canonical, robots, H1, word/link/image count,
  Open Graph, Schema.org type và diff với static observation.
- Lab performance: LCP, CLS và navigation TTFB.
- Không lưu toàn bộ response header hoặc raw JSON-LD mặc định.

- Capture chạy on-demand cho từng page.
- Structured data chỉ giữ type/count/validation summary; không lưu raw JSON-LD
  trong PostgreSQL hoặc ClickHouse.
- V1.5 thu Open Graph; Twitter Card nằm ngoài lát cắt này.

## 2. Workload dự kiến

Đã được duyệt ở mức toàn hệ thống:

- 20.000 scan/ngày, trung bình 30 page/scan, khoảng 600.000 page result/ngày.
- Đỉnh chuẩn 200 page result/giây; runtime cho phép scan tối đa 100.000 page và
  10.000 active page-fetch slot để stress test.
- 10 browser worker đồng thời; capture duy trì 0,2/giây và burst 2/giây.
- Public target tối đa hai request đồng thời trên một hostname.

Biến số phải đo khi benchmark thực tế:

- Tỷ lệ page được người dùng yêu cầu browser capture trên tổng page crawl.
- Tỷ lệ retry/browser failure trên tập website mục tiêu.
- Phân bố SSR/CSR/SPA, tỷ lệ trang có JSON-LD/hreflang và cardinality p50/p95/max
  của từng mảng mới.
- Kích thước trung bình/p95/max của rendered HTML và screenshot thực tế trong tập
  website mục tiêu.

Nếu capture tự động cho toàn bộ 600.000 page/ngày, baseline 10 browser worker và
0,2 capture/giây không còn phù hợp. Quyết định trigger phải có trước khi tính
capacity và schema.

## 3. Mẫu truy vấn

Đã biết:

- Page detail lấy toàn bộ static metadata theo `(owner_id, scan_id, page_id)`.
- Page explorer phải có cursor pagination và filter hữu hạn.
- Snapshot detail lấy rendered evidence, diff và performance theo owner/capture.
- Report phải công bố watermark/freshness và trạng thái unavailable.

Baseline filter/sort đề xuất để review:

- Thiếu/trùng title, description, H1, canonical, Open Graph hoặc Schema.org type.
- Indexable/non-indexable reason; canonical self/non-self.
- Có/không có hreflang và số hreflang.
- JavaScript làm thay đổi title, H1, canonical hoặc content đáng kể.
- LCP/CLS/TTFB theo ngưỡng và trạng thái measurement.

Giới hạn đã duyệt:

- Snapshot lookup theo owner/capture là đường đọc tương tác quan trọng nhất.
- V1.5 chưa tìm tự do trong raw JSON-LD và chưa tạo aggregate toàn website cho
  Open Graph, hreflang hoặc CWV.
- Page explorer ưu tiên cursor pagination và filter hữu hạn; mục tiêu p95 chỉ được
  công bố sau benchmark trên hardware profile được ghi lại.

## 4. Mẫu ghi

Static crawl:

- Một page completion tạo một versioned analytical payload chứa scalar và bounded
  array; payload được stage bền vững trong Crawler PostgreSQL trước khi batch sang
  ClickHouse.
- Retry có thể gửi lại cùng logical version; correction gửi version lớn hơn.
- HTTP timing được ghi cùng observation; phase không xảy ra do connection reuse
  phải phân biệt với giá trị bằng không.

Browser capture:

- Capture Worker claim job bằng lease/fencing, render và upload ngoài transaction.
- Metadata/object reference/analytics staging được commit bằng transaction local
  ngắn; ClickHouse/S3 retry không được double count hoặc để stale worker ghi muộn.
- Static và rendered observation không ghi đè nhau.

- Mỗi page chỉ có một capture đang hoạt động; các capture terminal là observation
  độc lập và được giữ theo retention.
- V1.5 chỉ có profile `desktop-lab-v1`.
- Diff được Capture Worker tính một lần từ static observation immutable trong
  command và rendered observation, sau đó persist cùng timestamp của cả hai phía.

## 5. Khối lượng dữ liệu

Đã biết:

- Static page fact trung bình khoảng 600.000 row/ngày, nhưng scan cực đại có thể
  chứa 100.000 row.
- Analytical fact hiện giữ 180 ngày.
- Capture tối đa 500 network row, 100 resource body và 50 MiB object/capture theo
  baseline đã duyệt.

Công thức cần benchmark:

```text
static SEO bytes/ngày
  = page result/ngày × byte trung bình của các scalar/array SEO mới

rendered fact rows/ngày
  = page result/ngày × tỷ lệ page được capture × số profile/capture

artifact bytes kỳ giữ
  = capture/ngày × byte trung bình HTML+screenshot+resource × số ngày giữ
```

Số liệu còn phải đo, không phải quyết định schema:

- Byte trung bình/p95 của metadata mới sau cap.
- Tỷ lệ capture thực tế. Số profile/capture trong V1.5 cố định là một.
- Raw JSON-LD không được lưu trong ClickHouse.

## 6. Nhất quán và đồng thời

Đã xác nhận:

- PostgreSQL giữ workflow; ClickHouse giữ analytical fact; S3/MinIO giữ artifact.
- Delivery at-least-once, logical version, receipt, watermark và reconciliation.
- Không transaction xuyên service/datastore và không giữ transaction khi fetch,
  render hoặc upload.
- Lease generation/fencing từ chối kết quả stale.
- Report owner-scoped và static/rendered observation có source/timestamp/version.

Quyết định đã chốt:

- `COMPLETED` chỉ được phát sau khi HTML, screenshot, snapshot metadata và
  analytical acknowledgement đã bền vững.
- Materialized diff summary được giữ cùng analytical fact; artifact hết hạn không
  làm mất summary.
- Cửa sổ đo kết thúc tại `load + 5 giây`, có hard timeout 30 giây và không chờ
  `networkidle` vô hạn.

## 7. Retention

Đã được duyệt ở baseline:

- Page/SEO analytical detail: 180 ngày.
- Capture network/resource analytical fact: 180 ngày.
- Public scan summary: 365 ngày.
- Deletion hợp lệ hoàn tất trong 7 ngày; backup có disclosure riêng.

Đã duyệt:

- Rendered SEO/performance và network/resource metadata giữ 180 ngày.
- Rendered HTML và screenshot giữ 30 ngày; resource body giữ 7 ngày.
- Sau khi object hết hạn vẫn giữ metadata, hash, performance và materialized diff
  tới hết retention analytical.

## 8. Phương án schema đã xem xét

- Một PostgreSQL chung cho cả Control Plane và Capture Worker bị loại vì làm mờ
  service ownership và cho worker quyền truy cập dữ liệu người dùng không cần thiết.
- Chỉ dùng ClickHouse bị loại vì lease, claim, retry và outbox cần transaction OLTP
  cùng row lock mạnh.
- Lưu HTML/screenshot trong PostgreSQL bị loại vì gây phình WAL, backup và buffer
  cache. Phương án chọn là PostgreSQL cho workflow/reference, ClickHouse cho fact
  phân tích và MinIO/S3 cho byte artifact.
- Không partition PostgreSQL ở V1.5: bảng workflow có retention và lưu lượng thấp
  hơn fact; chỉ partition khi số đo cho thấy bảng đạt hàng chục triệu row hoặc GC
  theo thời gian trở thành bottleneck.

## 9. Khóa logic, PK/FK và constraint

- `capture_jobs.id` là capture request UUID do Control Plane cấp; logical command
  key là `command_message_id` duy nhất và payload hash phát hiện collision.
- `page_snapshots.capture_job_id` duy nhất, bảo đảm một winning attempt chỉ công bố
  một snapshot. Resource object duy nhất theo `(capture_job_id, ordinal)`.
- `analytics_outbox.capture_job_id` duy nhất; mỗi capture có một batch analytical
  tổng hợp. `event_outbox` duy nhất theo `(capture_job_id, event_version)`.
- Các `CHECK` khóa status, lease-state, attempt, hash length, byte/count cap và
  terminal timestamp. FK dùng `ON DELETE RESTRICT` để deletion workflow không thể
  xóa workflow trước artifact/reference liên quan.
- `owner_id` có mặt trong mọi đường đọc public; Control Plane luôn kiểm tra owner
  trước khi gọi report/artifact nội bộ.

## 10. Chiến lược index và sắp xếp

- Claim queue dùng partial B-tree `(available_at, accepted_at, id)` với
  `status = 'QUEUED'`; lease recovery dùng `(lease_expires_at, id)` cho
  `status = 'RENDERING'`.
- Snapshot owner lookup dùng `(owner_id, captured_at DESC, id DESC)`; page history
  dùng `(scan_id, page_id, captured_at DESC)`.
- Outbox claim dùng partial B-tree theo `(available_at, created_at, id)` cho trạng
  thái chưa giao. Không tạo GIN trên JSONB vì V1.5 không query tùy ý trong payload.
- ClickHouse fact dùng khóa sắp xếp bắt đầu bằng owner/scan/page/capture và version;
  receipt theo owner/capture/batch ngăn replay bị tính hai lần.

## 11. Chiến lược transaction và concurrency

- Dùng `READ COMMITTED` với transaction ngắn, `FOR UPDATE SKIP LOCKED` để nhiều
  worker claim song song và lease generation làm fencing token.
- Render, network fetch, upload S3 và gửi ClickHouse luôn ở ngoài transaction.
- Stage snapshot/reference/analytics outbox và chuyển job sang `PERSISTING` trong
  một transaction local. Stale worker chỉ ghi được khi `(id, lease_owner,
  lease_generation)` còn khớp.
- Delivery là at-least-once; ClickHouse receipt, logical version và payload hash
  tạo idempotency. Event version giúp Control Plane từ chối event cũ/duplicate.
- Không cần nâng toàn hệ thống lên `SERIALIZABLE`; invariant hiện tại được khóa bằng
  unique constraint, atomic update và row lock cụ thể.

## 12. Benchmark query bắt buộc

Chạy với dữ liệu scale mục tiêu và lưu `EXPLAIN (ANALYZE, BUFFERS)`:

```sql
-- Claim đồng thời; p95 lock wait và throughput là kết quả chính.
SELECT id
FROM capture_jobs
WHERE status = 'QUEUED' AND available_at <= now()
ORDER BY available_at, accepted_at, id
FOR UPDATE SKIP LOCKED
LIMIT 1;

-- Snapshot detail owner-scoped.
SELECT *
FROM page_snapshots
WHERE capture_job_id = $1 AND owner_id = $2;

-- Batch GC object đã hết hạn.
SELECT id, storage_bucket, storage_key
FROM capture_object_references
WHERE delete_after <= now()
ORDER BY delete_after, id
LIMIT 1000;
```

Benchmark bổ sung phải đo duplicate command, 10 worker claim đồng thời, worker
crash trước/sau upload, ClickHouse outage/replay, event delivery lại và burst 2
capture/giây. Không tuyên bố p95 nếu chưa ghi CPU/RAM/disk/network profile.

## 13. Schema cuối đã duyệt cho V1/V1.5

Schema runtime nằm trong các forward migration thuộc đúng service owner:

- Crawler ClickHouse: `crawler/migrations/clickhouse/002_expand_static_seo_metrics.sql`.
- Capture PostgreSQL: `capture-worker/migrations/postgresql/001_create_capture_runtime.sql`.
- Capture ClickHouse: `capture-worker/migrations/clickhouse/001_create_capture_analytics.sql`
  và `002_store_sha256_as_hex.sql`.
- Control Plane PostgreSQL: migration V8 giữ capture request projection và outbox;
  không chứa HTML, screenshot hoặc resource body.

Các giá trị đã khóa trong schema/parser:

1. Capture **on-demand theo một page**. Không tự động render 100.000 page của một
   scan bằng baseline 10 browser worker.
2. V1.5 thu Open Graph giống CrawlObserver; Twitter Card để ngoài task này.
3. Structured data lưu type, item count, valid/error/warning count và bounded
   issue code. Không lưu raw JSON-LD trong PostgreSQL/ClickHouse; rendered HTML ở
   object storage là evidence gốc có thời hạn.
4. Filter ưu tiên: status/indexability; thiếu title/description/H1/canonical/OG;
   canonical self/non-self; có hreflang/Schema.org; JavaScript thay đổi title/H1/
   canonical/content; LCP/CLS/TTFB theo trạng thái và ngưỡng.
5. Hard cap parser trước staging:
   - H1/H2/H3/H4/H5/H6 tối đa lần lượt 50/100/150/100/50/50 phần tử, tổng tối đa
     500 heading; mỗi text tối đa 2.048 byte.
   - Hreflang tối đa 100 entry; language tối đa 64 byte, URL tối đa 8.192 byte.
   - Schema.org tối đa 100 type; mỗi type tối đa 255 byte.
   - JSON-LD chỉ parse tối đa 20 block và 1 MiB tổng input/page; không persist raw.
   - Meta keywords 4.096 byte; Open Graph title 2.048 byte, description 4.096 byte,
     image URL 8.192 byte; `X-Robots-Tag` 512 byte.
6. Một profile `desktop-lab-v1`: viewport 1365×768, DPR 1, Chromium được pin,
   không CPU/network throttle. Response phải ghi browser version, profile version
   và collection timestamp; không so sánh tuyệt đối qua hardware khác nhau.
7. Cửa sổ đo từ navigation start đến `load + 5 giây`, hard timeout 30 giây; không
   chờ `networkidle` vô hạn. Image không bị chặn trong lần đo LCP.
8. Rendered SEO/performance và network/resource metadata giữ 180 ngày; rendered
   HTML/screenshot giữ 30 ngày; resource body giữ 7 ngày. Deletion hợp lệ hoàn tất
   trong 7 ngày và backup theo disclosure hiện hành.
9. `COMPLETED` yêu cầu rendered HTML, screenshot, snapshot metadata và analytical
   acknowledgement. Metric không phát sinh hợp lệ được ghi `UNAVAILABLE`, không
   làm capture partial. Mất một nhánh evidence tạo `PARTIAL_SUCCESS` nếu vẫn còn
   evidence cốt lõi; không có evidence cốt lõi tạo `FAILED`.
