# Kiểm thử chức năng Design Clone — 2026-10-15

## Kết luận

**PASS trong phạm vi fixture local cô lập.** Bốn job đều `PUBLISHED`, mỗi job
đóng gói 10 trang đại diện, tổng cộng 40 trang thành công và 0 trang lỗi. Archive
100 URL được mở bằng Chromium: 10/10 trang có nội dung, CSS và JavaScript hoạt
động, không thiếu resource local và không có browser console/page error.

Không sửa runtime code, không deploy, không chạy tải production, không thay đổi
schema hoặc DESIGN_GATES. Chỉ thêm báo cáo này và script chẩn đoán trong `tmp/`.
Đây không phải chứng nhận production readiness hay sao lưu đầy đủ website.

## Môi trường và cách tái hiện

- HEAD: `21a6a1d3e950f2d38ada142e886cde09d0c25e16`.
- Branch: `codex/reliability-local-evidence-20261014`.
- Git working tree sạch trước test; source hash giữ nguyên trong experiment.
- JAR backend và source đã đối chiếu khớp manifest của run `04bdeab4` trước test.
  Crawler/Capture dùng image benchmark `20261013` hiện có, không rebuild source.
- Docker local: PostgreSQL riêng cho ba deployable, Redis, ClickHouse, MinIO,
  Java Control Plane, Go Crawler, Capture Worker và fixture.
- Fixture `11.254.254.10:9090` chỉ nằm trong internal Docker bridge, không có
  Internet route. Public API chỉ publish loopback; không đọc cấu hình production.
- Billing tắt; không thử thanh toán hay lưu credential người dùng.
- Thời gian evidence dùng UTC ngày 14/10, tương ứng sau 00:00 ngày 15/10 UTC+7.

```powershell
node --test tools/load/local-platform-benchmark.test.mjs
node tools/load/local-platform-benchmark.mjs --acknowledge-high-load --clone-only
```

Self-test harness: **8 pass, 0 fail, 0 skip**. E2E exit code 0, outcome
`PASS_CLONE_ONLY_LOCAL_ONLY`.

Evidence directory:
`tmp/load/platform-4ac0b489-db3c-44ee-a610-519672305c55/`.
Manifest ghi `releaseEligible: false`. Trường `dirtySource: true` là giá trị
hardcoded của harness, không phản ánh Git status thực tế; không dùng manifest
này làm bằng chứng release sạch.

## Kết quả workflow

Thời gian là từ gửi yêu cầu đến tải/xác minh artifact, có polling khoảng 2 giây.
Không phải p95, throughput hay benchmark đủ mẫu để kết luận regression.

| Scenario | Discovery / packaged | Trạng thái | Tổng thời gian | ZIP + manifest |
| --- | --- | --- | --- | --- |
| Smoke | 100 / 10 | PUBLISHED | 67.530 ms | 62.017 byte |
| Large discovery | 1.000 / 10 | PUBLISHED | 190.194 ms | 511.675 byte |
| Concurrent A | 100 / 10 | PUBLISHED | 74.960 ms | 62.017 byte |
| Concurrent B | 100 / 10 | PUBLISHED | 119.818 ms | 62.015 byte |

Hai concurrent job được gửi đồng thời bởi **hai owner khác nhau**. Không dùng
kết quả này để phủ định invariant một active scan trên cùng website/owner.

So với run local `572afbca` ngày 13/10: smoke 65.246 → 67.530 ms; large
190.178 → 190.194 ms; concurrent A 74.977 → 74.960 ms; B 121.462 → 119.818 ms.
Đây là hai lần đo đơn, không có thay đổi runtime giữa chúng trong đợt này;
không tuyên bố cải thiện hay suy giảm hiệu năng có ý nghĩa thống kê.

## Các kiểm tra đã vượt

- Public API tạo clone/scan bằng HTTP 202; replay cùng idempotency key trả HTTP
  200 và đúng clone ID/scan ID cũ. Replay tuần tự, không phải double-submit race.
- Owner khác nhận 404 khi đọc job và tải từng artifact.
- `processedCount` không giảm trong các snapshot polling; website ID, scan ID
  và accepted timestamp giữ đúng contract (sai số persistence tối đa 1 ms).
- ZIP và manifest thực sự tải qua public API. SHA-256 và byte count khớp
  metadata; `totalArchiveBytes` bằng tổng ZIP + manifest, không bằng ZIP riêng.
- Download có attachment, `nosniff`, `no-store`.
- Manifest locale `vi`; có rejection `ALTERNATE_LOCALE`. Auth login/register/
  forgot-password, blog index/detail, use-case index/detail, pricing và error
  4xx đều có representative.
- Mỗi archive có 10 HTML + 1 CSS + 1 JavaScript; asset dùng chung deduplicate.
  Không có screenshot entry và policy `screenshot: false`.
- HTML có marker từ browser render; mọi `href/src` tương đối được harness
  kiểm tra đều resolve tới entry tồn tại. URL không được chọn có thể giữ
  absolute source URL theo TASK-018, không phải mọi link đều dùng được offline.

## Kiểm tra archive bằng Chromium

Chỉ archive smoke được render lại trong trình duyệt. Server tạm dùng Node
standard library và bộ đọc ZIP hiện có, bind `127.0.0.1`, phục vụ byte đã tải
xuống; không chạy archive trên origin của WebLens. Named browser session riêng,
network allowlist chỉ `127.0.0.1`; không dùng Chrome profile/cookie của người dùng.

- Mở đủ 10 trang đại diện; heading hiện đúng và computed CSS color là
  `rgb(18, 52, 86)` (`#123456`).
- Xóa marker trên DOM tạm rồi thực thi lại JavaScript asset local: marker
  `data-fixture="rendered"` được tạo lại ở cả 10 trang. Việc này phân biệt
  JavaScript chạy được với marker chỉ có sẵn trong HTML đã capture.
- 47 HTTP request trong evidence kiểm tra, không có resource archive bị thiếu;
  10 trang có zero console/page error. Không có resource fetch tới source origin.
- Click link login từ home và link Home từ trang detail dẫn đúng trang local.
- Đã xem screenshot login; không gặp lỗi render trong fixture đơn giản này.

Evidence: `browser-verified.json`, `browser-pages.json`,
`browser-http-requests.json`, `browser-home.png`, `browser-login-success.png`,
`browser-last-page.png`. `browser-login.png` là screenshot home trước lần click
bị shell làm mất argument; **không dùng nó làm bằng chứng trang login**.
Named browser và server tạm đã đóng.

## Integration, storage và cleanup

`capture-integration.log`: **4 pass, 0 fail, 0 skip** với PostgreSQL/MinIO thật:

1. Duplicate command, lease fencing và analytical completion.
2. Site-clone migration, phase retry, page fencing, cancellation partial và GC.
3. Heartbeat kiểm lại expiry sau khi row lock được giải phóng.
4. MinIO put/copy/integrity read/delete cho staged publish.

`clone-storage-inventory.json`: expected 8, observed 8, chỉ còn published
artifact — 4 ZIP + 4 manifest; không còn staging/page-bundle object ở thời điểm
kiểm tra. Cancellation được kiểm ở integration persistence, không phải cancel
giữa một browser E2E job trong run này.

Harness dọn đúng 8 container và 2 network do run sở hữu cùng volume tạm của chúng;
không còn container/network mang run label sau cleanup. Danh sách cleanup trong
`final.json` không chứa container ngoài run. `dictalab-redis` và `codex-lb` vẫn
chạy khi kiểm tra cuối. Container `dictalab-ui-audit-20261014-redis` có mặt lúc
preflight nhưng không còn tồn tại ở kiểm tra cuối; chưa xác định tác nhân/nguyên
nhân từ Docker event buffer hiện có. Không tự tạo lại hoặc thay đổi project khác.
Vì vậy không tuyên bố đã xác minh bảo toàn đủ ba container ban đầu. Raw evidence
vẫn trong `tmp/` ignored, không tự commit/push.

## Giới hạn và bước kiểm chứng tiếp theo

Không phát hiện lỗi chức năng mới trong phạm vi trên. Các phần sau vẫn **thiếu
bằng chứng của đợt này**, không được tính là pass hoặc suy thành lỗi thực tế:

- Frontend form/progress/cancel/download: job được tạo bằng API, không qua UI.
- Authenticated clone/OTP, synthetic-root fallback, scroll/click/hover trên
  website động và redaction credential thực tế.
- Process-kill/restart, stale worker publish, lỗi storage/network giữa job,
  retry sau crash và cancellation E2E; integration hiện có không thay thế toàn
  bộ fault-injection workflow.
- Image/font/CSS import, SPA, CSP/service worker và độ giống giao diện website
  thực; fixture chỉ có asset CSS/JS đơn giản, không có backend nghiệp vụ.
- Idempotency race đồng thời, cùng key nhưng payload khác và SSRF negative
  E2E không được chạy trong harness clone-only này.
- 1.000 URL là **discovery**, chỉ render/package 10 representative theo Design
  Clone. Chưa chứng minh render 1.000 trang, nhiều owner tải lớn hay production p95.

Ưu tiên tiếp theo: test luồng UI bằng fixture; fixture đa dạng asset + auth/dynamic;
sau đó fault-injection/cancel/restart và tải nhiều owner có error budget cụ thể.
Giữ ba deployable, SSRF guard, hard ceiling và DESIGN_GATES; chưa có bằng chứng
cần thêm công nghệ hoặc đổi kiến trúc.

Skill agent-browser bổ sung kiểm tra archive thực trong Chromium; Ponytail giữ
script chẩn đoán ở `tmp/`, không thêm dependency; Encoding Guard kiểm UTF-8 báo cáo.
