# TASK-013 — Tích hợp Pagesource để tạo bản clone tĩnh

Trạng thái: **HOÀN TẤT** ngày 2026-09-14

## Mục tiêu

Mở rộng browser capture V1.5 để mỗi capture mới có thể tạo một archive clone tĩnh
best-effort của trang, sử dụng các hành vi phù hợp từ Pagesource nhưng vẫn giữ
security, storage và concurrency contract của WebLens.

## Lý do

Capture Worker đã lưu rendered HTML, screenshot và tối đa 100 resource body,
nhưng người dùng phải tải từng body và chưa có cây source/manifest/archive. Dự án
Pagesource giải quyết tốt URL-to-path, extension inference và source tree, nhưng
không thể được chạy nguyên trạng trong production boundary của WebLens.

## Yêu cầu đã duyệt

- Dùng cùng Playwright session với capture; không mở browser lần hai.
- Đóng gói rendered HTML và body đủ điều kiện thành ZIP có đường dẫn ổn định.
- Port/adapt path mapping, extension inference và collision handling từ Pagesource
  commit đã pin; thêm attribution MIT.
- Filename không chứa query value, credential hoặc path traversal component.
- Manifest versioned ghi URL đã redaction, URL hash, local path, MIME, byte,
  SHA-256, truncate/skip/failure reason và completeness.
- Same-origin mặc định. Chỉ CSS, JS, image và font; không lưu XHR/fetch body.
- Gói vượt budget phải thành `PARTIAL` hoặc `FAILED` có lý do, không silently drop.
- Capture/screenshot/analytics hợp lệ không bị mất khi packaging thất bại.
- Archive tải qua Control Plane sau owner authorization, size/hash verification,
  với `application/zip`, `attachment`, `no-store`, `nosniff`.
- UI snapshot hiển thị trạng thái, packaged/skipped count, byte và nút tải clone.
- UI không iframe, import hoặc thực thi HTML/JavaScript đã clone.

## API contract đề xuất

- Mở rộng additive response snapshot với `reconstruction`:
  - `id`, `status`, `kind`, `engineVersion`;
  - `packagedCount`, `skippedCount`, `archiveBytes`;
  - `completenessCode`, `failureCode`, `expiresAt`;
  - `downloadAvailable`.
- Thêm `GET /api/v1/captures/{captureId}/reconstruction`.
- Thêm `GET /api/v1/reconstructions/{reconstructionId}/artifacts/archive`.
- Endpoint nội bộ nhận đồng thời `ownerId`, capture ID và reconstruction ID; UUID
  không được dùng thay authorization.
- Capture cũ không có reconstruction trả `null`/`404` có code ổn định, không báo
  lỗi snapshot.

## Thay đổi dữ liệu

Proposal sử dụng hai bảng YELLOW trong Capture Worker PostgreSQL:

- `reconstruction_jobs` cho lifecycle và completeness summary.
- `reconstruction_artifacts` cho private object reference của ZIP/manifest.

Chi tiết ở `docs/database/RECONSTRUCTION_STATIC_CLONE_PROPOSAL.md`, đã được người
dùng phê duyệt ngày 2026-09-13.

Không thêm ClickHouse table và không lưu archive trong PostgreSQL.

## Trường hợp biên

- Hai URL chỉ khác query, URL encoded path, Unicode, Windows reserved name,
  filename không extension và MIME sai.
- Redirect, duplicate response, response body đã giải phóng, empty body, 206,
  compressed body, resource vượt byte hoặc count cap.
- HTML/CSS tham chiếu URL tương đối, absolute, protocol-relative, `srcset`,
  `@import`, `url()`, data/blob URL và fragment.
- SPA lazy-load sau cửa sổ chờ, service worker bị chặn, CSP và dynamic API.
- Browser crash, disk tạm đầy, MinIO timeout, DB commit fail sau upload, retry từ
  worker đã mất lease và archive object bị thay đổi.
- Capture cũ, snapshot đã hết hạn, resource body bị retention xóa và clone partial.

## Bảo mật

- Không dùng `bypass_csp`, `accept_downloads`, Cloudflare bypass hoặc TLS
  impersonation từ bất kỳ nguồn tham khảo nào.
- Mọi request/redirect tiếp tục qua SSRF/egress guard, kể cả external CDN.
- Không lưu cookie, authorization header, query value, XHR/fetch payload hoặc
  authenticated browser state vào clone mặc định.
- Archive entry chống `../`, absolute path, NUL, symlink và zip bomb; tổng số file,
  byte input/output và compression ratio phải có cap.
- Download không dùng filename/MIME do website cung cấp.
- HTML/JS clone là dữ liệu không tin cậy; không chạy trên origin có cookie/token
  WebLens. Live preview cần origin/container cô lập và ADR riêng.
- Giữ notice MIT của Pagesource cho code được port/adapt.

## Nhất quán và đồng thời

- Duplicate capture command tạo một logical reconstruction nhờ unique capture ID.
- Publish dùng capture lease generation làm fencing; stale attempt chỉ tạo orphan
  object để cleanup, không được đổi terminal metadata.
- Upload chạy ngoài transaction; metadata/object consistency dựa trên staged
  publish, SHA-256 và reconciler.
- Capture và reconstruction có terminal result riêng. Clone failure không rollback
  evidence đã hợp lệ.

## Kế hoạch triển khai

1. Chuyển ADR-007 sang `Accepted`, cập nhật PRODUCT/REQUIREMENTS/ARCHITECTURE.
2. Thêm MIT notice và utility path mapping có test parity với Pagesource.
3. Tạo Flyway-style migration thuộc Capture Worker sau review database safety.
4. Mở rộng capture collector để giữ raw URL mapping chỉ trong RAM và tạo manifest
   đã redaction.
5. Tạo ZIP theo streaming/temp-file budget, upload MinIO và publish có fencing.
6. Thêm owner-scoped internal API và Control Plane BFF/download endpoint.
7. Thêm UI trạng thái/nút tải clone; không thêm executable preview.
8. Chạy unit, PostgreSQL/MinIO integration, security, E2E, load và encoding check.
9. Chia commit theo provenance/path mapping, persistence, worker, API và UI.

## Bằng chứng hoàn tất

- Capture Worker: 8 unit test đạt; PostgreSQL integration test đạt trên PostgreSQL
  17.6; typecheck và production build đạt.
- Integration database xác minh migration ledger 001–003, duplicate command,
  stale lease, `STAGED → PUBLISHED`, owner scope, GC `DELETED/EXPIRED` và capture
  vẫn `COMPLETED` khi clone `FAILED`.
- Backend: 49 unit test và 18 Testcontainers integration test đạt bằng Java 21.
- Frontend: 14 test đạt; lint và production build đạt.
- E2E ngày 2026-09-14 với `https://example.com/`: capture
  `fb40fd3a-3bc2-42e8-ae17-38ff6f1822d5` tạo clone `PUBLISHED/COMPLETE`, một file
  nội dung, không bỏ qua file nào, archive 1.675 byte. ZIP tải qua UI chứa
  `example.com/index.html` và `manifest.json`; SHA-256 tải xuống khớp metadata
  PostgreSQL.
- Docker image runtime chứa `THIRD_PARTY_NOTICES.md`; Capture Worker liveness và
  readiness đều `UP` sau migration 003.

Các giới hạn vận hành còn lại được ghi tại `docs/DEVELOPMENT.md`: Control Plane
buffer archive tối đa 64 MiB, inventory sweep cho cửa sổ crash trước `STAGED` và
benchmark download đồng thời vẫn phải thực hiện trước production thực tế.

## Kiểm thử

- Unit: URL/path/extension/collision/Unicode/query redaction/traversal.
- Capture: same-origin/external policy, body eligibility, caps và completeness.
- Archive: ZIP entry allowlist, hash, file count, total byte và manifest mapping.
- PostgreSQL: duplicate accept, terminal constraint, owner composite FK,
  fencing/stale publish và GC claim.
- MinIO: upload timeout, orphan, missing/tampered object và retention.
- API/security: cross-owner 404, attachment headers, capture cũ và expired artifact.
- Frontend: status partial/failed/ready, download và không thực thi artifact.
- E2E: fixture SSR + SPA; không dùng website bên thứ ba làm test bắt buộc.
- Benchmark theo hồ sơ database đã duyệt.

## Definition of Done

- Capture mới tạo archive clone một trang có manifest trung thực.
- Archive chỉ chứa resource đủ policy và không làm lộ secret/query value.
- Duplicate/retry/restart không tạo hai artifact chiến thắng.
- Capture vẫn dùng được nếu clone thất bại; UI phân biệt rõ hai kết quả.
- Download owner-scoped, kiểm tra integrity và không render inline.
- Không thêm deployable, Python runtime hoặc ClickHouse payload table.
- Test/build/security/UTF-8 đạt và provenance MIT đầy đủ.

## Điều developer cần hiểu trước khi chấp nhận implementation

Pagesource thu browser-delivered source chứ không khôi phục source project gốc.
Một bản clone tĩnh chỉ phản ánh observation tại thời điểm capture; backend API,
authentication, dữ liệu động và code chưa được public không thể tái tạo. Tính đúng
giữa PostgreSQL và MinIO đến từ fencing, staged publish, checksum và reconciliation,
không phải distributed transaction.
