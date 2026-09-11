# Tách crawler thành microservice dựa trên CrawlObserver

Trạng thái: Accepted  
Ngày: 2026-09-11  
Thay thế: phần quyết định "một Spring Boot deployable" của ADR-001

Sửa đổi ngày 2026-09-11: [ADR-006](ADR-006-tich-hop-clickhouse-cho-analytics.md)
đã chọn ClickHouse làm analytical store. Những đoạn trong ADR này ghi
"ClickHouse chưa được chọn" chỉ còn là bối cảnh lịch sử.

## Bối cảnh

WebLens cần crawler có thể phát triển, triển khai, scale và lỗi độc lập với API
tương tác. Người dùng đã quyết định chuyển kiến trúc V1/V1.5 sang microservice và
sử dụng, sửa đổi phần core của
[CrawlObserver](https://github.com/SEObserver/crawlobserver) cho crawler.
CrawlObserver viết bằng Go, dùng ClickHouse cho analytics, SQLite cho cấu hình và
API key, frontier trong RAM, cùng Rod/Chromium cho JavaScript rendering. Những
lựa chọn đó không thể được nhập nguyên trạng vì WebLens yêu cầu công việc đã nhận
phải bền vững, nhiều worker xử lý at-least-once, PostgreSQL là authoritative store
và browser capture phải được cô lập.

CrawlObserver phát hành theo
[GNU AGPL-3.0](https://github.com/SEObserver/crawlobserver/blob/main/LICENSE).
Việc tách process hoặc gọi qua HTTP không được coi là bằng chứng tự động loại bỏ
nghĩa vụ giấy phép.

## Các phương án đã xem xét

- Giữ crawler trong Spring Boot modular monolith.
- Fork toàn bộ CrawlObserver, giữ nguyên server, auth, frontier và ClickHouse.
- Tự viết crawler clean-room, chỉ dùng CrawlObserver làm tài liệu và test oracle.
- Fork phần core có giá trị của CrawlObserver nhưng thay thế orchestration,
  persistence, authentication và browser runtime để phù hợp invariant của WebLens.

## Quyết định

Chọn phương án thứ tư với ba deployable chính trong V1/V1.5:

1. **WebLens Control Plane** dùng Java 21/Spring Boot. Service này sở hữu identity,
   website, authorization, quota, public scan/capture request và projection trạng
   thái phục vụ UI.
2. **Crawler Service** dùng Go và nằm trong repository riêng của bản fork
   CrawlObserver. Service này sở hữu crawl execution, durable frontier/page work,
   HTTP collection, parsing, deterministic measurements/findings và recovery.
3. **Capture Worker** dùng Node.js/Playwright/Chromium. Service này thực thi mã web
   không tin cậy trong sandbox có giới hạn và ghi artifact lớn vào S3-compatible
   object storage.

Control Plane tiếp tục tổ chức nội bộ theo modular-monolith boundaries; quyết định
microservice không cho phép chia nhỏ tùy ý thành nhiều service khác.

### Phần CrawlObserver được phép sử dụng và sửa đổi

- URL normalization và crawl-scope logic, sau khi có contract/version/test riêng.
- HTTP fetch, redirect tracking, timeout, body limit và phân loại lỗi.
- HTML parser và danh mục SEO signal làm đầu vào cho deterministic rules.
- Pipeline bounded fetch → parse → persist, retry/backoff và politeness.
- robots.txt và sitemap parsing.

### Phần phải thay thế hoặc thiết kế lại

- Frontier, dedup và session queue trong RAM.
- Manager chỉ đánh dấu work là `crashed`/`stopped` khi restart.
- ClickHouse `ReplacingMergeTree` làm nguồn trạng thái nghiệp vụ.
- SQLite project/API-key store và Basic Auth.
- Batch buffer có thể bỏ dữ liệu sau số retry hữu hạn.
- Rod/Chromium chạy chung process và không có browser egress sandbox đầy đủ.
- Cloudflare bypass và TLS impersonation không thuộc V1/V1.5.

### Giao tiếp và tính nhất quán

- Bắt đầu bằng REST nội bộ có version, idempotency key, timeout và bounded retry.
- Control Plane persist scan request và outbox record trong cùng local transaction.
- Dispatcher gửi lệnh bằng `scan_id`; Crawler tạo execution idempotently và có
  inbox/dedup tương ứng.
- Crawler persist result/outbox trước khi báo progress hoặc terminal event. Control
  Plane consume event idempotently để cập nhật projection.
- Không dùng distributed transaction. Mất kết nối, duplicate, out-of-order và
  callback thất bại là tình huống bình thường phải kiểm thử.
- Chưa thêm Kafka hoặc Redis. Broker chỉ được thêm bằng ADR sau benchmark.

### Quyền sở hữu dữ liệu

- Có thể dùng chung một PostgreSQL 17 cluster để giảm vận hành, nhưng mỗi service
  có database hoặc schema, role và migration ownership riêng.
- Service không đọc/ghi trực tiếp bảng của service khác; không tạo cross-service
  foreign key hoặc join runtime.
- `scan_id`, `website_id`, `owner_id` và correlation ID đi qua contract dưới dạng
  opaque identifiers. Crawler không tự quyết định authorization của người dùng.
- PostgreSQL lưu trạng thái workflow bền vững. S3/MinIO lưu HTML rendered,
  screenshot và resource body. ClickHouse lưu analytical facts theo ADR-006,
  nhưng không làm queue hoặc nguồn lifecycle.

### Bảo mật service và crawler

- Service-to-service authentication, authorization, secret rotation và replay
  protection phải được chốt trước production; network location không phải trust.
- Crawler kiểm tra protocol, DNS/IP và từng redirect; chỉ kết nối đích được policy
  cho phép, tôn trọng robots và per-host limits.
- Capture Worker có egress policy riêng, browser context cô lập, timeout, CPU/RAM,
  network byte và object byte limits; browser không dựa vào Go safe dialer.
- Raw header/cookie/token/body nhạy cảm không được lưu hoặc log mặc định.

### Giấy phép và provenance

- Crawler fork ở repository riêng và giữ đầy đủ copyright/license notices.
- Mọi file lấy hoặc sửa từ CrawlObserver phải giữ provenance rõ ràng.
- Trước khi cung cấp service cho người dùng production, phải có review pháp lý về
  cách cung cấp Corresponding Source của crawler đã sửa đổi và legal notices.
- Không trộn source AGPL trực tiếp vào repository proprietary của Control Plane
  nếu chưa có kết luận pháp lý hoặc giấy phép thương mại phù hợp.

## Hệ quả

- Crawler và browser có fault/scale/security boundary rõ hơn; Go core được tận
  dụng mà không nhập nguyên các giả định desktop/local-first.
- Phải vận hành nhiều deployable, contract, timeout, retry, tracing và reconciliation.
- Không còn foreign key hoặc ACID transaction xuyên service; invariant phải được
  bảo vệ bằng local transaction, idempotency, fencing và repair process.
- Schema V1/V1.5 đã đề xuất theo một database ownership phải được xem xét lại;
  không được chuyển DDL đó thành migration trước khi ownership mới được duyệt.
- AGPL trở thành yêu cầu phát hành, không chỉ là ghi chú dependency.

## Tiêu chí xác minh quyết định

- Accepted scan sống qua restart của bất kỳ service nào.
- Duplicate dispatch/event không tạo job hoặc tăng progress hai lần.
- Worker cũ không ghi đè attempt mới sau khi lease hết hạn.
- Control Plane vẫn phục vụ auth/progress/report đã có khi Crawler hoặc Capture
  Worker bị chậm; yêu cầu mới được queue hoặc từ chối có kiểm soát.
- Crawler và browser không thể truy cập private/internal network ngoài policy.
- Có source-offer/legal-notice workflow cho crawler fork trước production.

## Khi nào xem xét lại

- Chi phí vận hành ba deployable vượt lợi ích isolation ở traffic thực.
- PostgreSQL staging hoặc ClickHouse không đạt ingestion/report SLO sau khi tối ưu
  schema, batching, key, pooling và benchmark.
- REST outbox/inbox không đạt queue-age hoặc throughput mục tiêu đã benchmark.
- Chủ sở hữu CrawlObserver cấp giấy phép thương mại làm thay đổi boundary pháp lý.
