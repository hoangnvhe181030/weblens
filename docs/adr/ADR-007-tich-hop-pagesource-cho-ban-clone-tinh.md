# ADR-007 — Tích hợp Pagesource để tạo bản clone tĩnh từ browser capture

Trạng thái: Accepted — người dùng phê duyệt ngày 2026-09-13
Ngày: 2026-09-13

## Bối cảnh

WebLens V1.5 đã có Playwright Capture Worker, HTML sau render, screenshot,
network metadata, một tập resource body có giới hạn và MinIO. Người dùng muốn
dùng [timf34/pagesource](https://github.com/timf34/pagesource) để bổ sung chức
năng clone website kết hợp với browser capture.

Pagesource là CLI Python giấy phép MIT. Phiên bản được đánh giá là `0.1.2`, commit
`f59ed61dfc42a901b412a4cc6803fc238e879405`. Công cụ thu các response do
Playwright quan sát, suy luận phần mở rộng từ `Content-Type`, làm sạch đường dẫn,
giữ cấu trúc URL và xử lý tên file trùng. Tuy nhiên, implementation upstream:

- giữ toàn bộ response body trong RAM rồi mới ghi ra đĩa;
- bật `bypass_csp` và chấp nhận download;
- không có DNS/redirect SSRF guard tương đương WebLens;
- không có giới hạn file, byte, thời gian hoặc retention phù hợp multi-tenant;
- không viết lại đầy đủ HTML/CSS để bảo đảm bản sao chạy offline;
- chỉ thu một trang, không khôi phục source React/Next.js, backend, database,
  private API hoặc component boundary gốc.

Vì vậy không thể chạy nguyên CLI Pagesource như một production worker của
WebLens. Việc tạo thêm Python service cũng mâu thuẫn với boundary ba deployable
đã duyệt tại ADR-005 nếu chưa có ADR mới.

## Các phương án đã xem xét

1. Chạy nguyên CLI Python Pagesource như deployable thứ tư.
2. Cài Python và gọi subprocess Pagesource từ Capture Worker Node.js.
3. Port có ghi attribution các thuật toán phù hợp vào Capture Worker hiện tại,
   dùng chung một Playwright session và giữ toàn bộ security/budget của WebLens.
4. Không tích hợp; chỉ tiếp tục cho tải từng resource body riêng lẻ.

## Quyết định

Chọn phương án 3, với các giới hạn sau:

- Giữ đúng ba deployable. Không thêm Python runtime hoặc service mới.
- Pagesource là nguồn ý tưởng và provenance cho lớp ánh xạ URL thành đường dẫn
  local, suy luận extension, tránh trùng tên và tạo cây resource. Nếu port đoạn
  code đáng kể, phải giữ copyright MIT trong third-party notice và tại file nguồn.
- Một lần browser capture mới tạo tối đa một **bản clone tĩnh của một trang**.
  Đây là gói source export/best-effort offline, không phải source code gốc và
  không phải bản sao backend có thể vận hành độc lập.
- Main rendered HTML cùng CSS, JavaScript, image và font đủ điều kiện được đóng
  thành archive. Chỉ resource body thực sự đã thu mới được công bố là có trong
  clone; manifest phải liệt kê resource thiếu, bị chặn, lỗi hoặc bị truncate.
- Mặc định chỉ đóng gói same-origin. Resource ngoài origin chỉ có thể được bật
  sau review policy; mọi DNS, redirect và connection vẫn phải qua egress/SSRF
  guard của Capture Worker.
- Không dùng `bypass_csp`, không bật download và không hạ sandbox để tăng độ đầy
  đủ của clone.
- Query value không xuất hiện trong logical filename hoặc manifest. Có thể dùng
  hash của URL đầy đủ trong RAM để tạo tên ổn định và phân biệt collision.
- Archive và manifest nằm trong MinIO. PostgreSQL chỉ giữ lifecycle, object
  reference, checksum và số byte; ClickHouse không giữ payload clone.
- WebLens không thực thi HTML/JavaScript clone trên origin của ứng dụng. Vòng đầu
  chỉ cho tải archive dưới dạng attachment. Preview chạy được chỉ được xem xét
  trên một origin/container cô lập bằng ADR riêng.
- Toàn bộ resource được thu và map trong cùng Playwright session với capture để
  tránh chạy website hai lần và để giữ URL mapping trước khi redaction.
- Lỗi clone không được làm mất screenshot, rendered evidence hoặc analytical
  result hợp lệ. UI phải thể hiện clone `PARTIAL`/`FAILED` độc lập với capture.

Phạm vi này chưa bao gồm clone toàn bộ các trang của một website. Site-wide clone
cần fan-out từ scan, cross-page resource dedup, URL graph rewrite, budget và
retention lớn hơn; nó phải có workload/design review riêng.

## Hệ quả

- Tận dụng được Playwright, MinIO, lease/fencing và SSRF policy đang có mà không
  tăng số deployable hoặc duplicate browser session.
- Implementation không phụ thuộc Python package lúc runtime, nhưng phải có test
  tương thích hành vi với Pagesource và notice giấy phép rõ ràng.
- Một archive làm tăng CPU, RAM, disk tạm, object bandwidth và storage cho mỗi
  capture. Phải stream ra file/object có giới hạn thay vì giữ thêm một bản archive
  không giới hạn trong RAM.
- Bản clone có thể không hoàn chỉnh vì CSP, service worker bị chặn, response body
  không còn khả dụng, resource vượt policy, request cần đăng nhập hoặc backend
  động. Manifest và UI phải công bố chính xác các giới hạn này.
- `reconstruction_jobs` và `reconstruction_artifacts` thuộc nhóm YELLOW. Proposal
  database tương ứng đã được người dùng phê duyệt ngày 2026-09-13.

## Hồ sơ phê duyệt

Người dùng đã phê duyệt đồng thời ngày 2026-09-13:

1. Đơn vị clone ban đầu là một trang, không phải toàn bộ scan/website.
2. Same-origin mặc định; không capture XHR/fetch body hoặc dữ liệu người dùng.
3. Archive download-only; chưa có live preview chạy JavaScript.
4. Budget và retention trong hồ sơ database reconstruction.
5. Hai bảng YELLOW thuộc Capture Worker PostgreSQL.
6. Capture thành công vẫn độc lập với kết quả clone.

## Khi nào xem xét lại

- Người dùng cần clone toàn bộ website thay vì một trang.
- Archive generation trở thành bottleneck theo benchmark.
- Cần preview tương tác hoặc chạy JavaScript đã clone.
- Cần capture response nhạy cảm, authenticated session hoặc API body.
- Pagesource thay đổi giấy phép hoặc cung cấp library API có security contract phù
  hợp trực tiếp với WebLens.
