# Local admission baseline — 2026-10-08

Trạng thái: admission-only cục bộ đạt gate ở ba lượt burst 25 user. Không deploy, không chạy tải
production, không sửa runtime Java/schema/index/migration. Không coi kết quả này
là production capacity hoặc root cause admission timeout production.

## Phạm vi và phương pháp

`tools/load/local-admission-probe.mjs` dùng standard library Node và k6 đã có.
Ponytail giữ phạm vi ở tooling/evidence, không thêm runtime abstraction hoặc
dependency. PostgreSQL skill hướng dẫn đối chiếu durable state bằng SELECT;
không thay đổi dữ liệu workflow để ép recovery hay acceptance. Giữ ba deployable
và DESIGN_GATES; probe không bổ sung deployment topology/profile.

1. Copy backend source và admission k6 vào thư mục mới, giữ SHA-256 từng file;
   kiểm copy/build không đổi source. Build snapshot bằng `mvn -B clean verify`,
   yêu cầu critical integration suites không skip trước khi chạy Java.
2. Tạo PostgreSQL 17.6-alpine và Redis 7.4-alpine riêng, pin theo compose hiện có;
   ghi image ID thực tế. Cổng Docker/Java chỉ bind loopback, cấp ngẫu nhiên.
   Java 21 dùng application.yml hiện hữu, không active profile mới.
3. Auth thật: registration/login pace 1,1 giây, Redis session và durable
   PostgreSQL revocation vẫn bật. Mỗi lượt có user, website, UUID correlation,
   idempotency key riêng. Không tái sử dụng active website hoặc bypass quota.
4. Dispatcher tắt bằng cấu hình hiện có. `admission.invalid` chỉ là target
   metadata, không được fetch. Scan/outbox phải thực sự commit trước response.
5. k6 mỗi VU gửi đúng một POST, timeout 5s. Lưu elapsed của mọi attempt, kể cả
   status 0; giữ HTTP duration riêng. Không retry POST và không tăng timeout.
6. Đối chiếu response ID/owner/website/correlation với scan + SCAN_REQUESTED
   outbox bằng SELECT bounded 5s; yêu cầu đúng một enter/exit/COMMITTED timing.
   Thiếu, trùng hoặc lệch evidence không được công bố pass.
7. Gate k6 và reconciliation đều phải đạt. Lỗi dừng lượt tiếp theo; finally
   dừng Java và chỉ xóa container/data có đúng UUID ownership. Giữ artifact.

## Artifact và provenance

- `source-manifest.json`: source SHA-256 từng file, source digest, Git HEAD và
  dirty flag, hash runner/helper, phiên bản công cụ, cấu hình workload.
- `runtime-manifest.json`: hash JAR sau clean verify, image ID, port và giới hạn
  tài nguyên của môi trường đo.
- `build.log`, `source/backend/target/*-reports`: bằng chứng build/test riêng,
  không ghi đè target của backend chính.
- `seed-N.json`, `k6-N.log`, `k6-summary-N.json`, `backend.log`, `result-N.json`,
  `final.json`: synthetic identity, observation, reconciliation và cleanup.

Source snapshot xuất phát từ workspace dirty và ghi `releaseEligible=false`.
Nó gắn phép đo với source/build cụ thể, **không** thay thế review diff, clean
release checkout, dependency reproducibility hay verification binary production.
Không commit thay đổi của người dùng để vượt clean-release gate.

## Lượt thăm dò và lỗi công cụ đã sửa

Run `0d96a778-96e7-4b32-af6f-573ed2754dc1` dừng sau lượt 1 do runner đọc summary
k6 theo `metric.values`, trong khi bản k6 cài đặt export metric dạng flat.
Đây là lỗi tooling, không là lỗi backend hay admission timeout.

- 25/25 response 202; 25 scan/outbox đúng owner/website đã commit; đủ correlation
  và transaction evidence; status 0 = 0; k6 exit 0.
- Elapsed p95 304ms, HTTP duration p95 302,5789ms.
- p99 không có trong summary mặc định. Không coi run này là benchmark ba lượt
  hoàn tất; `final.json` giữ outcome FAILED của runner.
- Cả hai container/data riêng đã xóa; source/build/evidence được giữ.

Sửa nhỏ: đọc flat hoặc wrapped metric, yêu cầu percentile đầy đủ và explicit
`--summary-trend-stats ...p(95),p(99)`. Thêm regression test cho hai định dạng và
missing p99. Chặn thêm DOCKER_HOST TCP/SSH để environment override không chuyển
probe sang daemon ngoài local. Không sửa request timeout hay admission workload.

## Kết quả benchmark ba lượt

Run `c3f4a28e-2be5-40c9-bc66-1691a08565ff`, hoàn tất 18:34:02 +07:00.
Cell A: không chủ động warm connection, không stagger, 25 user riêng/lượt.
Ba lượt trên cùng Java process; không thay runtime hoặc backend source giữa lượt.

| Lượt | Accepted / committed | Status 0 / unresolved | Elapsed p95 | Elapsed p99 | HTTP duration p95 | Gate |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 25 / 25 | 0 / 0 | 344,8ms | 354,88ms | 343,12434ms | PASS |
| 2 | 25 / 25 | 0 / 0 | 91,6ms | 100,36ms | 90,05148ms | PASS |
| 3 | 25 / 25 | 0 / 0 | 81,8ms | 94,64ms | 79,783ms | PASS |

Tổng 75/75 attempt được accepted và có đúng durable scan/outbox cùng correlation,
owner và website; đầy đủ enter/exit/COMMITTED timing. Cả ba k6 process exit 0;
`final.json` outcome PASS. Không có timeout, response lỗi hay evidence chưa rõ.
Gate elapsed p95<1s/p99<2s và admission failure<1% đạt cho workload này.
Mỗi lượt chỉ 25 admission: p99 gần cực đại mẫu, không đủ để cam kết tail latency
hay error budget dài hạn. Không gộp ba percentile thành một percentile chung.

Provenance:

- Backend/k6 source: 218 file, digest
  `a55d17da56b78c175a3edfa77b37b35d3498b19e88256daa4ab5ffac08f083b0`.
  Khớp lượt thăm dò; không có bản sửa backend giữa hai run.
- JAR: `bbd40ef7ff09e20ed8a5160762e6ca9f3d49e2bda365f33c1fa265b2827bf85b`.
- Java 21, Node v24.11.1, k6 v2.2.0; Windows x64, 16 logical CPU, RAM
  33.622.609.920 byte. Java heap 256–768MiB, Hikari max64/min16; PostgreSQL
  container 512MiB, Redis container 128MiB; local Redis timeout 1s, không TLS.
- Snapshot clean verify: 102 unit + 44 integration test, 0 fail/error/skip;
  BUILD SUCCESS 18:29:47 +07:00. Critical integration evidence gate PASS.
- Tooling: 6 Node tests PASS; k6 offline smoke PASS; syntax và UTF-8 check PASS.
  Không chạy lại Go/Capture trong đợt tooling này.

Evidence nằm ở `tmp/load/admission-c3f4a28e-2be5-40c9-bc66-1691a08565ff/`.
Hai container/data riêng đã xóa; kiểm Docker không còn label admission-probe.
Source/build/report giữ lại ở tmp, không phải release artifact được phê duyệt.

### Ý nghĩa chẩn đoán, không suy đoán root cause

Không tái hiện timeout 5s ở workload 25 admission-only. Lượt 1 chậm hơn lượt 2–3
trong cùng binary/config; **không** phải benchmark trước/sau sửa code.
Runtime warm-up, pool/cache và tải nền cần telemetry riêng để phân biệt.

Ví dụ request chậm nhất lượt 1: elapsed 358ms; filter elapsed 353,3435ms;
controller service-call 298,7025ms; service body 56,2609ms và completion sau body
3,3945ms. Đây là các interval của **cùng request**, không là phép trừ p95.
Khoảng thời gian còn lại trong service-call chưa tách transaction setup/proxy,
connection acquisition, JVM scheduling và cleanup. Chưa có bằng chứng để quy
nó thành SQL chậm hoặc Hikari wait; không thêm index hay tăng pool dựa vào số này.

## Giới hạn và acceptance tiếp theo

- Chưa có Caddy/TLS, background crawler, ClickHouse, Capture hoặc object storage.
  Không thay thế matrix full-stack 25→50→150 trên staging.
- Generator và target cùng máy; không có telemetry host/DB liên tục, tải ngoài
  có thể ảnh hưởng kết quả. Không là phép đo capacity của hardware production.
- Cell A không chủ động warm, nhưng không bảo đảm mọi POST dùng socket mới;
  cần đọc connecting/TLS timings, không suy ra socket reuse từ nhãn cell.
  Không có JVM/cache lạnh sau seed và auth setup. PostgreSQL dataset tăng giữa lượt; không có historical matched
  baseline. Không so với API p95 trước Redis hoặc dispatcher microbenchmark.
- DEBUG timing chỉ có stage application/transaction, không tách từng SQL,
  Hikari acquisition hay auth cost. Không cộng/trừ percentile để suy ra latency
  thành phần; phải đối chiếu từng request nếu cần.
- Crash/kill hẳn runner hoặc máy có thể không thực thi finally. Khi đó kiểm đúng
  UUID label/manifest trước khi dọn; không dùng cleanup rộng tới container khác.
- Production admission 146/150 accepted và 4 timeout 5s vẫn có root cause UNKNOWN.
  Kết quả local thành công không loại trừ DNS/TCP/TLS, ingress, generator hoặc
  contention chỉ xuất hiện khi có full workload.

Bước tiếp: full-stack staging, ít nhất ba lượt mỗi cell A/B/C/D; ghi source/hash,
runtime config, data volume, generator/target telemetry và ingress log đầy đủ.
Giữ một POST/key, timeout 5s, và giải thích mọi timeout bằng trace hoặc UNKNOWN.
API report p95, heartbeat cost, worker kill và restore drill vẫn là gate riêng.

## What the developer should understand before accepting this code

- HTTP timeout có thể xảy ra sau commit. Accepted response và committed state
  là hai bằng chứng riêng; không gửi lại key mới để chữa kết quả chưa rõ.
- Admission accepted chỉ chứng minh scan/outbox bền vững, không chứng minh scan
  đã dispatch/crawl/terminal hoặc analytical result đã sẵn sàng.
- Source HEAD của workspace dirty không định danh toàn bộ binary. File digest,
  clean build và JAR hash giúp truy vết phép đo; release vẫn cần review riêng.
- Percentile/error gate và completeness/correctness gate độc lập. Không bỏ
  status 0 hay request lỗi để làm đẹp p95; không coi thiếu log là chưa tới server.
