# Production deployment — 2026-10-04

## Release và phạm vi

- Trạng thái: đã kích hoạt và xác minh trực tiếp trên VPS; script deploy báo healthy.
- Release: `6ade9332e2e4c4df12b304edecad5d756462143f` trên `hoangptkd/weblens`, nhánh `main`.
- Bản trước: `9e87e8b0c95ea1791dcc4814793e45b1e391ca36`.
- CI: https://github.com/hoangptkd/weblens/actions/runs/37185611408.
- URL production: https://jobnext.top.
- Artifact: 944.850.330 bytes; SHA-256 `43f2f33d931d6f55e318f817eecd3c86ff6c9560f4d15d02b05e7b5b3f4b2360`.

Người dùng phê duyệt sửa và deploy, dùng PostgreSQL local cổng 5433, commit/push
`main` vào repository trên. Release được tạo trong worktree riêng từ production
main để giữ các sửa đổi metrics và analytics batching đang chạy. Workspace gốc,
nhánh đang mở và các thay đổi của người dùng không bị reset hoặc ghi đè.
Giữ migration đã áp dụng và ba application deployable; không chuyển dữ liệu từ Neon.

## Backup và database

Preflight xác nhận `WebLensPostgres` đang chạy, listener `127.0.0.1:5433` và cả ba
URL database effective trỏ tới loopback: `weblens`, `weblens_crawler`, `weblens_capture`.
Không in, sao chép ra máy local hoặc đưa credential vào release.

Backup trước rollout ở VPS:
`C:\ProgramData\WebLens\backups\performance-preflight-20261004T071626Z`.
Custom-format dumps đều qua `pg_restore --list` và được ghi hash trong manifest:

| Database | Bytes | SHA-256 |
| --- | ---: | --- |
| weblens | 255952893 | cd16e0369069da20969b452cab71d61ae9bc028e341d082be586a5c87998a1fd |
| weblens_crawler | 715492840 | d778229657074b6c5e302c097d6683449885c5477941db7c403ed76e81fd1cca |
| weblens_capture | 186424 | 05d5fca0bd5feb59d292af3eb694a83de71a65fcff3b299993fdc16016706d5e |

Không có restore drill, backup globals, PITR, ClickHouse hoặc R2 trong lần này.
Ba dump là snapshot từng database, không phải một transaction snapshot liên database.

## Kiểm tra bản release

- Backend clean verify: 94 tests qua; 24 integration tests skip cục bộ vì thiếu Docker.
- Crawler: `go test -count=1 ./...` và `go vet ./...` qua; PostgreSQL tạm 18.4 chạy thật.
- Capture: 54/61 tests qua, 7 skip; integration riêng có 2 PostgreSQL tests qua,
  1 MinIO test skip. Typecheck/build qua.
- Frontend: 39 tests qua; lint/build qua.
- Release runtime helper: 7 scenarios qua; scripts parse và static gate check qua.
- UTF-8: 92 release files qua; diff whitespace check qua.
- CI backend, crawler, capture, frontend và Windows release đều success. Windows
  release job chạy Camoufox headless smoke trước publication. Không tải được log
  CI qua API anonymous (HTTP 403), nên không báo số integration tests CI như số đã quan sát.

## Trở ngại tải artifact

VPS nhận HTTP 206 nhưng tải 1 MB bị timeout 20 giây, chỉ nhận 195638 bytes ở lần
diagnostic. Download 1 KB thành công; cùng 1 MB qua máy local hoàn tất trong khoảng
2 giây. Tác vụ poll chưa chuyển current junction trong lúc tải thất bại.

Artifact đầy đủ tải qua máy local và qua SHA-256. Truyền toàn bộ sang VPS tiếp tục
chậm; đã dừng riêng lần upload đó, giữ file partial. Runtime manifest trong artifact
mới khớp checksum thực tế của runtime cũ trên VPS (lock và Camoufox executable).
Tạo ZIP runtime-reuse từ artifact đã xác minh, giữ nguyên 102 file ứng dụng/migration,
loại riêng runtime trùng lặp và tạo lại SHA256SUMS. Gói 65.666.670 bytes có SHA-256
`b54043eb89ce3103700a0b2bc1611a0c9c5efa8a21c23bba4942f96761ea0763`.
Hash được kiểm trên VPS; cả 5 capture migrations so với previous release đều khớp.

Deploy trực tiếp qua SSH bị từ chối ACL của mutex global, trước khi thay đổi dịch vụ.
Chạy cùng script deploy của previous release bằng one-shot Scheduled Task dưới
SYSTEM, cùng principal của tác vụ pull hiện có. Script cũ hỗ trợ checksum-verified
runtime reuse, nên không đổi binary hoặc hạ kiểm runtime. Không đổi credential,
database port, DNS/TLS hoặc bỏ checksum. Đường tải tự động VPS/GitHub vẫn cần sửa.

## Xác minh sau rollout

- Current junction và public `/release.json` đều là `6ade9332e2e4c4df12b304edecad5d756462143f`.
- Crawler migration hoàn tất; backend/capture log xác nhận restart trên release mới.
- Backend, Crawler, Capture, Caddy và PostgreSQL đều Running.
- Crawler/capture readiness, backend actuator health và HTTPS loopback đều HTTP 200.
- Public homepage HTTP 200; `/api/v1/auth/me` không đăng nhập HTTP 401.
- Backend `/actuator/metrics` không có service token HTTP 401.
- Cả ba effective database URL vẫn loopback 5433; listener chỉ `127.0.0.1:5433`.
- Capture migration metadata: 5 applied versions, cả 5 có checksum.
- Deploy log: `WebLens release 6ade9332e2e4c4df12b304edecad5d756462143f is healthy.`
- One-shot deployment task kết thúc với result 0 và đã xóa. Poll task vẫn enabled,
  trạng thái Ready; không tạo service hoặc lịch deploy mới lâu dài.
- Release trước `9e87e8b0c95ea1791dcc4814793e45b1e391ca36` giữ lại cho binary rollback.
- Script deploy dọn binary releases cũ hơn và staging cũ, giữ current/previous.
  Binary cũ có thể lấy lại từ GitHub releases; backup PostgreSQL không bị xóa.
  Artifact relay local và transfer partial trên VPS vẫn được giữ, không phải backup DB.
- CI deploy verification failed sau khoảng 32 phút, trước activation vì thời gian tải.
  Bốn test jobs và Windows release job success. Không coi workflow overall xanh;
  bằng chứng rollout là log script, services/readiness và release ID trực tiếp.

Không có đăng nhập/scan/clone end-to-end, live S3 integrity check, load/fault test,
restore drill hoặc rollback drill trong lần deploy. Không khẳng định mọi luồng đúng.

## What the developer should understand before accepting this code

- CI success và readiness không chứng minh mọi luồng nghiệp vụ đúng. Các skip và
  rủi ro trong `AUDIT_FIXES_2026-10-04.md` vẫn có hiệu lực.
- Backup đọc được TOC chưa chứng minh restore được. Binary rollback không hoàn tác
  schema; checksum metadata bổ sung phải tương thích với release trước.
- Artifact lớn và đường mạng VPS có thể làm rollout quá hạn dù code/build đều qua.
  Chuyển tiếp artifact có checksum là workaround, không phải cải thiện downloader.
