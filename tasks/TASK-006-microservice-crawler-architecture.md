# Chuyển WebLens sang kiến trúc crawler microservice

## Mục tiêu

Ghi nhận quyết định kiến trúc mới, loại bỏ các tuyên bố modular-monolith-only và
định nghĩa boundary ban đầu giữa Control Plane, Crawler Service và Capture Worker
trước khi tiếp tục thiết kế schema hoặc runtime crawler.

## Lý do

Người dùng quyết định dùng và sửa đổi core CrawlObserver cho crawler, đồng thời
muốn crawler có fault và scaling boundary độc lập. Repository hiện mô tả crawler
nằm trong Spring Boot modular monolith nên các nguồn sự thật đang mâu thuẫn.

## Yêu cầu

- Tạo ADR phê duyệt kiến trúc mới và đánh dấu ADR-001 bị thay thế một phần.
- Xác định service responsibility, data ownership và communication semantics.
- Giữ PostgreSQL tự triển khai là authoritative durable store.
- Không tự động thêm Kafka, Redis, Kubernetes hoặc ClickHouse.
- Ghi nhận AGPL/provenance là release requirement.
- Đánh dấu schema proposal cũ cần review lại, không tạo migration/entity.

## API contract

Chưa tạo OpenAPI hoặc endpoint trong task tài liệu này. Contract tương lai phải có
version, `scan_id`, idempotency key, correlation ID, timeout, error classification
và authentication giữa service.

## Thay đổi dữ liệu

Không thay đổi database. Ownership mới chỉ là quyết định logic; outbox/inbox,
crawler execution và capture persistence vẫn phải qua cổng GREEN/YELLOW/RED trước
khi có DDL, Flyway migration hoặc entity.

## Trường hợp biên

- Control Plane commit scan nhưng chưa dispatch được.
- Crawler nhận cùng command nhiều lần.
- Event terminal đến trước progress event cũ.
- Worker chết hoặc lease hết hạn khi đang fetch.
- Crawler hoàn tất nhưng callback tới Control Plane thất bại.
- Capture upload object thành công nhưng metadata commit thất bại.
- Crawler hoặc Capture Worker không khả dụng khi API vẫn đang phục vụ.

## Cân nhắc bảo mật

- SSRF phải được chặn riêng ở HTTP crawler và Chromium network boundary.
- Service-to-service traffic phải xác thực và chống replay.
- Không truyền user credential hoặc raw authorization header cho crawler.
- Giữ license/provenance của CrawlObserver; review AGPL trước production.

## Cân nhắc đồng thời và nhất quán

- Delivery at-least-once, consumer idempotent và fenced completion.
- Local transaction + outbox/inbox, không có distributed transaction.
- Projection có thể trễ nhưng state không được quay ngược.
- Mỗi service có migration và connection budget độc lập.

## Kế hoạch triển khai

1. Đồng bộ ADR, PRODUCT, REQUIREMENTS, ARCHITECTURE, ROADMAP và README.
2. Bổ sung cross-service workload, failure và recovery SLO.
3. Đánh dấu schema proposal hiện tại cần thiết kế lại theo ownership.
4. Sau review, tạo task riêng cho service contract và crawler fork bootstrap.

## Kiểm thử

- Kiểm tra tất cả Markdown decode UTF-8 và không có mojibake.
- Tìm toàn repository các tuyên bố crawler trong một deployable hoặc microservice
  chỉ thuộc tương lai.
- Kiểm tra link ADR và trạng thái tài liệu schema.

## Definition of Done

- Nguồn sự thật hiện hành không còn mô tả crawler là module chạy trong Spring
  Boot; ADR-001 được giữ nguyên như hồ sơ lịch sử và đánh dấu superseded một phần.
- Có một data owner duy nhất cho mỗi loại dữ liệu ở mức kiến trúc.
- Failure/delivery/license boundary được ghi rõ.
- Không có schema/runtime implementation ngoài phạm vi.

## Điều tôi cần hiểu trước khi chấp nhận thay đổi

Microservice tạo isolation nhưng đổi local call/transaction thành network,
duplicate delivery và eventual consistency. Khả năng scale chỉ có ý nghĩa khi
queue, connection budget, backpressure, recovery và observability được kiểm thử.
