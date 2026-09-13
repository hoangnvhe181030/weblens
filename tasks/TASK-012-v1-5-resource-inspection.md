# TASK-012 — Hoàn thiện kiểm tra resource capture của V1.5

Trạng thái: **Hoàn tất**.

## Mục tiêu

Hoàn thiện lát cắt `CAP-003` để người dùng phân biệt network request chỉ được quan
sát với resource body thực sự đã lưu, xem metadata bounded của body và tải bằng
endpoint có kiểm tra owner mà không thực thi nội dung không tin cậy.

## Lý do

Snapshot viewer hiện gọi mọi network request là resource nhưng chưa ghép fact
`captured_resources`. Người dùng chưa thấy SHA-256, số byte body đã lưu hoặc trạng
thái bị cắt theo giới hạn. Object resource đã nằm trong MinIO nhưng chưa có đường
truy cập public được authorize. Lỗi object mất cũng đang bị làm phẳng thành lỗi
dịch vụ chung, khiến trạng thái evidence khó hiểu.

## Yêu cầu

- Truy vấn network fact và captured-resource fact theo cùng `owner_id` và
  `capture_request_id`, sau đó ghép bằng sequence bất biến của request.
- Public response phân biệt `bodyCaptured`, `capturedBodyId`, byte body đã lưu,
  SHA-256 và `bodyTruncated`.
- Resource body chỉ tải được qua Control Plane sau khi capture thuộc đúng owner và
  ở trạng thái ready.
- Nội dung tải xuống luôn là `application/octet-stream`, `attachment`, `no-store`
  và `nosniff`; không dùng MIME/filename do website cung cấp để render inline.
- Kiểm tra kích thước và SHA-256 sau khi đọc object. Reference tồn tại nhưng object
  mất/hết hạn trả lỗi domain rõ ràng thay vì thành công rỗng.
- URL analytical loại userinfo, fragment và giá trị query trước khi persist; vẫn
  giữ tên query parameter để hỗ trợ chẩn đoán.
- Không thêm dependency, service, datastore hoặc migration mới.

## API contract

- Mở rộng additive từng item trong `GET /api/v1/captures/{captureId}/snapshot`:
  `bodyCaptured`, `capturedBodyId`, `capturedBodyBytes`, `bodySha256`,
  `bodyTruncated`.
- Thêm `GET /api/v1/captures/{captureId}/resources/{resourceId}/content`.
- Endpoint nội bộ tương ứng nhận `ownerId` từ Control Plane đã xác thực bằng
  service token; `resourceId` phải thuộc đúng capture và owner.
- Object còn tồn tại trả `200`; reference không thuộc scope trả `404`; reference
  còn nhưng object mất hoặc hash/size sai trả problem detail có mã ổn định.

## Thay đổi dữ liệu

Không có migration. Lát cắt chỉ đọc các bảng RED theo thiết kế đã duyệt tại
`docs/database/SEO_RENDERED_PERFORMANCE_WORKLOAD.md`:

- ClickHouse `network_requests` và `captured_resources`.
- PostgreSQL `capture_jobs` và `capture_object_references`.
- MinIO/S3 object đã được ghi bởi capture workflow hiện tại.

## Trường hợp biên

- Network request không có body được lưu vì loại không hợp lệ, vượt count cap,
  response body lỗi hoặc byte budget đã hết.
- Body bằng đúng/vượt giới hạn và bị truncate.
- Duplicate/replayed analytical fact trước khi ClickHouse merge.
- Resource ID hợp lệ nhưng thuộc owner hoặc capture khác.
- Reference tồn tại nhưng object đã bị retention xóa; object bị thay đổi kích
  thước hoặc hash.
- URL chứa userinfo, fragment, duplicate query key, token có key viết hoa/thường.
- Người dùng nhấn tải nhiều resource đồng thời hoặc rời trang khi request đang chạy.

## Bảo mật

- Không chuyển access token người dùng cho Capture Worker hoặc MinIO.
- Không trả storage bucket/key, service token hoặc content type không tin cậy.
- Byte tải xuống không được render inline và frontend không inject HTML/JavaScript.
- Mọi lookup chứa đồng thời owner, capture và resource identifier; opaque UUID
  không được coi là authorization.
- URL và metadata tiếp tục bị cap; giá trị query bị redaction trước analytics.

## Nhất quán và đồng thời

- ClickHouse được đọc bằng logical latest fact (`FINAL`) và ghép bằng
  `(owner_id, capture_request_id, request_sequence)`.
- PostgreSQL là nguồn xác thực reference object; ClickHouse chỉ cung cấp metadata
  phân tích và không cấp quyền truy cập object.
- Hash/size được kiểm tra sau khi đọc object để phát hiện object thiếu hoặc sai,
  không giả định metadata và S3 có transaction phân tán.
- Endpoint là read-only; retry tải không thay đổi workflow.

## Kế hoạch triển khai

1. Đồng bộ quyết định artifact delivery trong tài liệu kiến trúc.
2. Ghép network/resource analytical facts và thêm owner-scoped object lookup ở
   Capture Worker.
3. Thêm endpoint download an toàn qua Capture Worker và Control Plane.
4. Mở rộng DTO, frontend service và snapshot resource inspector.
5. Bổ sung test authorization, integrity, contract, download và URL redaction.
6. Chạy typecheck/build/test liên quan, review diff, UTF-8 và secret scan.

## Kiểm thử

- Capture Worker unit/API: service token, owner/capture/resource scope, metadata
  merge, attachment headers, size/hash mismatch và object missing.
- Capture PostgreSQL integration: resource reference chỉ trả về đúng owner và
  capture.
- Spring MVC security: authentication bắt buộc, response attachment không lộ
  service token/storage reference.
- Frontend: hiển thị trạng thái body, hash/truncated và download qua authenticated
  API mà không tạo iframe/script.
- Toàn stack: backend verify; Capture Worker test/typecheck/build; frontend
  lint/test/build.

## Definition of Done

- Snapshot cho biết chính xác request nào có body evidence và lý do nhìn thấy byte
  ít hơn response khi truncate.
- Resource body được tải an toàn theo owner, không thực thi và được kiểm tra hash.
- Object mất/sai integrity có lỗi phân loại, không trả dữ liệu sai.
- Không có migration RED, dependency mới, secret, mojibake hoặc thay đổi ngoài V1.5.

## Kết quả xác minh

- Backend: `mvnw.cmd verify` đạt với 45 unit/security/architecture test và 18
  Testcontainers integration test trên Java 21.
- Capture Worker: typecheck, build, 5 unit test và 1 PostgreSQL integration test
  đạt.
- Frontend: lint, 13 test và production build đạt.
- Dogfood bằng UI thật với `https://www.wikipedia.org/`: scan hoàn tất, capture
  quan sát document/image/script, hiển thị byte và SHA-256 của body, vô hiệu hóa
  tải khi body không tồn tại, và tải image body thành công qua Control Plane.
- Response tải resource trả `application/octet-stream`, `attachment`, `no-store`,
  `nosniff`; không có lỗi console trong luồng kiểm thử.
- Không thêm migration, dependency hoặc datastore.

## Điều developer cần hiểu trước khi chấp nhận

Network request metadata và captured body là hai fact khác nhau: quan sát request
không đồng nghĩa đã lưu payload. Authorization lấy từ PostgreSQL workflow/reference,
trong khi ClickHouse chỉ phục vụ analytics. Hash xác minh integrity chứ không thay
thế authorization; tải dưới dạng attachment ngăn trình duyệt diễn giải HTML/JS
không tin cậy như nội dung của WebLens.
