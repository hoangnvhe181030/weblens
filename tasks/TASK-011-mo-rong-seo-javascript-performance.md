# TASK-011 — Mở rộng SEO metadata, JavaScript rendering và performance

Trạng thái: **Hoàn tất lát cắt chức năng và E2E ngày 2026-09-13**. Capacity
production vẫn phải được chứng minh bằng benchmark trên phần cứng triển khai;
task này không tuyên bố đã đạt tải production.

## Mục tiêu

Mở rộng WebLens theo hai lát cắt độc lập:

1. V1 thu thập và hiển thị SEO metadata tĩnh cùng một tập Social/SEO nâng cao
   tương thích về ý nghĩa với CrawlObserver.
2. V1.5 dùng Playwright Capture Worker cô lập để thu metadata sau render,
   khác biệt static/rendered và lab performance gồm LCP, CLS, TTFB.

Không chạy Chromium trong Control Plane hoặc Go Crawler. Không biến ClickHouse
thành workflow store và không lưu artifact lớn trong PostgreSQL/ClickHouse.

## Lý do

Crawler hiện đã thu title, meta description, canonical, meta robots, HTML lang,
H1/H2, word count, link và image count nhưng public report chỉ trả một phần. Các
field DNS/connect/TLS/TTFB trong ClickHouse hiện chưa được đo thực. WebLens chưa
có H3–H6, hreflang, Open Graph, Schema.org type hoặc kết quả sau JavaScript.

## Yêu cầu đã duyệt

### V1 — HTML tĩnh

- Trả hết signal đã thu hiện nay qua API có phân trang, filter và owner scope.
- Bổ sung `meta keywords` như metadata legacy, không mô tả nó như ranking signal.
- Bổ sung H3–H6, canonical self/non-self, lý do không indexable và
  `X-Robots-Tag`.
- Bổ sung hreflang, Open Graph title/description/image và Schema.org type lấy từ
  JSON-LD/microdata.
- Đo DNS, connect, TLS, TTFB và total time bằng HTTP client instrumentation; giá
  trị thiếu phải có trạng thái thay vì bị trình bày như số `0` đo được.
- Không lưu toàn bộ response header, cookie, authorization header hoặc raw
  JSON-LD trong analytical fact mặc định.
- Mọi chuỗi và mảng lấy từ website phải có byte/count cap trước khi staging.

### V1.5 — JavaScript và lab performance

- Capture chỉ chạy qua Playwright Capture Worker đã cô lập, không chạy trong Go
  Crawler hoặc Spring Boot.
- Lưu riêng static evidence và rendered evidence; không ghi đè kết quả static.
- Trích xuất rendered title, meta description, canonical, robots, H1, word count,
  link/image count, Open Graph và Schema.org type.
- Tính diff static/rendered cho title, description, canonical, H1, content,
  link/image count và Schema.org type.
- Thu LCP, CLS và navigation TTFB trong điều kiện lab có profile/version rõ ràng.
- Không chặn image trong lần đo LCP. Measurement không có dữ liệu phải trả
  `UNAVAILABLE` cùng reason code, không thay bằng `0`.
- Rendered HTML và screenshot nằm trong S3/MinIO; UI chỉ hiển thị nội dung đã
  escape hoặc object an toàn, không inject HTML/JavaScript đã crawl.

## API contract đã triển khai

Data shape đã được khóa theo các nguyên tắc:

- Thay đổi crawler analytical payload bằng schema version mới; consumer cũ vẫn
  xử lý được payload cũ trong giai đoạn rollout.
- Public page report thêm field theo kiểu additive và có cursor pagination.
- Kết quả performance gồm `status`, `value`, `unit`, `source`, `profileVersion`
  và `unavailableReason` khi phù hợp.
- Capture command mang immutable target, viewport, timeout, byte/request cap,
  correlation ID và measurement profile version.
- API không trả object-storage credential hoặc URL tồn tại lâu; quyền truy cập
  artifact phải được authorize bởi Control Plane.

## Thay đổi dữ liệu

Các thay đổi này chạm nhóm RED:

- Mở rộng Crawl ClickHouse `page_metrics` cho SEO signal tĩnh.
- Bổ sung analytical fact cho rendered SEO và lab performance thuộc ownership
  của Capture Worker.
- Có thể cần mở rộng PostgreSQL `page_snapshots` chỉ cho metadata workflow/evidence
  nhỏ; artifact lớn vẫn ở S3/MinIO.

Không sửa migration đã áp dụng. Mọi thay đổi là forward migration trong đúng
repository/service owner. Khóa logic, index, transaction và benchmark query được
ghi tại `docs/database/SEO_RENDERED_PERFORMANCE_WORKLOAD.md`.

Phần HTTP timing dùng các cột ClickHouse hiện có đã được triển khai trước vì không
thay đổi schema: crawler đo DNS/connect/TLS/TTFB và total time, đồng thời giữ cờ
observed trong analytical payload để forward migration sau này phân biệt phase
không xảy ra với giá trị đo bằng không.

## Trường hợp biên

- HTML malformed, metadata lặp, mảng heading/hreflang cực lớn và URL dài.
- Canonical/hreflang tương đối, sai scheme hoặc trỏ ra ngoài scope.
- JSON-LD invalid, `@graph`, `@type` là chuỗi/mảng hoặc payload cực lớn.
- `X-Robots-Tag` xuất hiện nhiều lần hoặc khác nhau theo redirect/final response.
- DNS cache hit làm phase timing không xuất hiện; connection reuse không có
  connect/TLS timing mới.
- Trang không phát sinh LCP, navigation bị timeout, SPA không bao giờ idle, layout
  shift sau cửa sổ đo hoặc browser crash.
- Static crawl và capture xảy ra ở hai thời điểm khác nhau; diff phải ghi thời
  điểm và không khẳng định mọi khác biệt đều do JavaScript.
- ClickHouse/S3 unavailable sau khi browser đã chạy; accepted capture vẫn phải
  retry/reconcile mà không double count.

## Bảo mật

- Giữ SSRF defense ở từng redirect và browser egress policy tại network/container
  layer; Playwright không được kế thừa quyền mạng rộng của host.
- Không lưu/log cookie, token, request/response body nhạy cảm hoặc raw header.
- HTML, metadata, console error, URL và Schema.org content đều là input không tin
  cậy; cap trước khi log, persist hoặc trả qua API.
- Capture context cô lập, tắt download/popup ngoài policy, có process-kill timeout
  và CPU/RAM/disk/network budget.
- Mã tái sử dụng từ CrawlObserver phải giữ provenance và nghĩa vụ AGPL-3.0; không
  copy renderer Rod vào WebLens.

## Nhất quán và đồng thời

- Static page fact và rendered capture fact là hai observation độc lập có
  `observed_at`, collector/parser/browser version riêng.
- Worker ghi staging bằng lease generation/fencing; external fetch, render và
  upload chạy ngoài transaction.
- PostgreSQL staging → ClickHouse là at-least-once, dùng logical version và receipt
  để query không double count.
- Capture terminal chỉ được công bố sau khi metadata/object reference hợp lệ và
  analytical watermark đạt mức đã cam kết, hoặc phải là partial/failure rõ ràng.
- Retry capture không được ghi đè kết quả attempt mới hơn bằng kết quả stale.

## Kế hoạch triển khai sau khi được duyệt

1. Chốt hồ sơ workload bước 1–7 và data shape RED.
2. Viết forward migration review, benchmark query và failure-test matrix.
3. Mở rộng Go parser/fetch instrumentation cùng contract test/provenance.
4. Mở rộng analytical staging, ClickHouse sink và owner-scoped report API.
5. Mở rộng Spring BFF và React page detail/report; phân biệt missing/unavailable.
6. Bootstrap Playwright Capture Worker, PostgreSQL/ClickHouse migration runner và
   S3/MinIO adapter.
7. Thực hiện rendered/static diff, LCP/CLS/TTFB và snapshot viewer.
8. Chạy unit, integration, E2E, SSRF, duplicate/retry, ClickHouse outage và load
   benchmark trên hardware profile được ghi lại.

## Kiểm thử bắt buộc

- Parser table test cho case-insensitive metadata, duplicate, relative URL,
  malformed HTML, caps và Unicode tiếng Việt.
- HTTP timing test cho DNS/connect/TLS/TTFB có connection reuse và phase missing.
- Contract compatibility test giữa payload schema cũ/mới.
- ClickHouse replay/out-of-order/version-safe query test.
- Playwright test cho SSR, CSR, SPA timeout, missing LCP, layout shift và browser
  crash.
- Authorization test owner chéo; artifact viewer không thực thi HTML đã capture.
- Benchmark page ingest/report ở tải chuẩn và capture burst đã duyệt.

## Definition of Done

- Người dùng xem được metadata static và rendered với source/timestamp rõ ràng.
- LCP/CLS/TTFB không bị báo sai là `0` khi không đo được và luôn gắn profile/version.
- API page explorer có cursor pagination, filter hữu hạn và không còn `LIMIT 100`
  ngầm.
- Accepted crawl/capture không mất và không double count khi retry/restart/outage.
- Không raw secret/header/body nào đi vào log hoặc analytical fact ngoài policy.
- Build/test/encoding check pass và migration được review theo cổng RED.

## Kết quả triển khai và xác minh

- Go Crawler trả static SEO mở rộng, HTTP timing có trạng thái đo và contract
  page detail có cursor pagination/owner scope.
- Playwright Capture Worker riêng đã có lease/fencing, PostgreSQL staging,
  ClickHouse receipt, MinIO artifact và event callback idempotent.
- Control Plane authorize capture/snapshot/screenshot; frontend chỉ hiển thị
  screenshot qua Blob URL và không thực thi HTML đã thu.
- E2E thật đã hoàn tất theo luồng đăng ký → website → scan → page evidence →
  capture → snapshot. Ba lỗi về contract/indexability, breadcrumb demo và liên
  kết snapshot demo được phát hiện, sửa và xác minh lại trong
  `dogfood-output/task011/report.md`.
- Backend đạt 40 test unit/security và 18 test integration bằng Java 21; Go đạt
  toàn bộ unit, PostgreSQL integration và ClickHouse replay integration; frontend
  đạt 12 test; Capture Worker đạt 3 unit và 1 PostgreSQL integration test.
- Capture integration test dùng schema PostgreSQL tạm và tự xóa sau khi chạy,
  không còn phát event thử vào worker runtime.
- PostgreSQL, ClickHouse và MinIO đã được đối chiếu cho cùng capture E2E; outbox,
  inbox và receipt đều khớp, hai object HTML/screenshot tồn tại đúng metadata.

Benchmark saturation cho 100.000 page, 10 browser worker và burst 2 capture/giây
chưa được thực hiện trong TASK-011. Đây là cổng vận hành trước khi công bố SLO,
không phải bằng chứng thiếu của luồng chức năng đã triển khai.

## Điều developer cần hiểu trước khi chấp nhận

Static HTML và DOM sau JavaScript là hai observation khác thời điểm, không phải hai
giá trị thay thế cho nhau. LCP/CLS/TTFB ở đây là lab measurement phụ thuộc viewport,
network, browser và cửa sổ đo; nó không phải field data của người dùng thật. Tính
đúng khi ghi nhiều datastore đến từ staging, fencing, idempotency, version-safe
query và reconciliation, không đến từ distributed transaction.
