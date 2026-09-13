# TASK-010 — Hợp nhất runtime production dung lượng cao

Trạng thái: đã được người dùng phê duyệt ngày 2026-09-12.

## Mục tiêu

Loại bỏ profile `dev`, profile/stack `loadtest` và chỉ duy trì một cấu hình runtime
production. Scan mới mặc định cho phép 100.000 trang; các trần HTTP, connection
pool và crawler được externalize để có thể điều chỉnh mà không sửa code.

## Phạm vi

- Hợp nhất cấu hình Spring vào `application.yml`.
- Xóa `application-dev.yml`, `application-loadtest.yml` và env stack load-test.
- Đặt mặc định scan 100.000 trang, depth 4, 24 giờ và 10.000 concurrency.
- Đặt Tomcat tối đa 100.000 connection, 20.000 backlog và 512 request thread.
- Đặt Hikari tối đa 64 connection cho mỗi Control Plane instance.
- Cho crawler tối đa 10.000 page fetch đang hoạt động, nhưng chỉ một dispatcher
  polling PostgreSQL khi frontier rỗng.
- Giữ tối đa hai request đồng thời trên mỗi public hostname và delay một giây.
- Giữ load runner 100.000 virtual user để tìm điểm bão hòa trên runtime chính.
- Cập nhật hướng dẫn chạy và hồ sơ workload bằng tiếng Việt.

## Ngoài phạm vi

- Không tuyên bố một máy đã chịu được 100.000 client hoặc 10.000 fetch nếu chưa có
  benchmark và artifact đo.
- Không bỏ authentication, authorization, SSRF guard, lease/fencing, timeout,
  idempotency, backpressure hoặc connection pool hữu hạn.
- Không thêm Kafka, Redis, Kubernetes, PgBouncer hay service mới.
- Không sửa migration đã áp dụng hoặc thiết kế lại bảng RED.

## Failure mode và invariant

- 10.000 worker slot không được tạo 10.000 vòng claim khi queue rỗng.
- Public target luôn bị giới hạn theo hostname; concurrency toàn hệ thống cao
  không được biến thành 10.000 request tới một website.
- Thiếu database credential, JWT secret hoặc service token phải làm startup fail.
- Khi ClickHouse backlog quá tuổi, crawler ngừng claim nhưng accepted work còn
  bền vững trong PostgreSQL.
- Scan đã tạo giữ nguyên effective-config snapshot; chỉ scan mới nhận mặc định mới.
- Scale nhiều instance phải chia lại tổng connection budget thay vì nhân 64 vô hạn.

## Kế hoạch triển khai

1. Hợp nhất Spring configuration và viết test binding/cap.
2. Loại environment switch khỏi crawler, giữ network policy fail-closed.
3. Đổi engine thành dispatcher + active-slot semaphore.
4. Xóa cấu hình stack riêng, cập nhật env mẫu, tài liệu và load runner examples.
5. Chạy unit/integration/build, encoding check và smoke runtime thật.
6. Dừng process/container load-test cũ nhưng không xóa volume dữ liệu nếu chưa có
   yêu cầu hủy dữ liệu rõ ràng.

## Definition of Done

- Backend khởi động không có active profile và scan mới trả `maxPages=100000`.
- Không còn source/runtime config tên `dev` hoặc `loadtest` ngoài test/build tooling
  có ý nghĩa kỹ thuật khác.
- Crawler chấp nhận 10.000 active slot, giữ public host concurrency bằng hai và
  idle polling không tăng theo số slot.
- Các test liên quan, build, static analysis và kiểm tra UTF-8 đều pass.
- Runtime chính ở `8080/8081`; dữ liệu PostgreSQL/ClickHouse chính được bảo toàn.

## Điều developer cần hiểu trước khi chấp nhận

Trần cấu hình là capacity envelope cần đo, không phải capacity đã chứng minh.
Tomcat có thể giữ nhiều socket hơn thread xử lý; Hikari nhỏ hơn số request là chủ
đích để tạo backpressure thay vì mở connection storm. Crawler worker slot cũng là
giới hạn công việc đang hoạt động, còn dispatcher kiểm soát tốc độ claim. Điểm
bão hòa cuối cùng vẫn phụ thuộc CPU, RAM, IOPS, PostgreSQL lock/WAL/autovacuum,
ClickHouse merge, độ trễ target và phần cứng của load generator.
