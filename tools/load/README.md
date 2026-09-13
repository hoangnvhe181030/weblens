# Bộ công cụ load test WebLens

Thư mục này cung cấp hai chương trình Node.js 24 không cần cài package:

- `fixture.mjs`: website HTTP xác định, sinh tối đa 100.000 trang theo yêu cầu.
- `run.mjs`: chạy tải API hoặc điều phối một scan qua Control Plane rồi theo dõi đến trạng thái cuối.

Bộ công cụ chỉ tạo tải và ghi số đo. Nó không sửa migration, không tự đổi giới hạn
server và không tuyên bố hệ thống đạt production capacity. Kết quả luôn được ghi
dưới `tmp/load/*.json`; thư mục `tmp/` đã được Git bỏ qua.

WebLens chỉ còn một runtime. Các ví dụ bên dưới gọi Control Plane ở `8080`, Crawler
ở `8081` và fixture ở `9090`. Bài thử sẽ tạo dữ liệu trong database chính đang
kết nối, vì vậy chỉ chạy với tài khoản/website do bạn sở hữu và lập kế hoạch dọn
dữ liệu benchmark sau khi đã lấy metric.

## Nguyên tắc an toàn của runner

- Mặc định chỉ gọi `127.0.0.1` và luôn chạy health preflight trước khi tạo tải.
- Cấu hình lớn phải có `--acknowledge-high-load`. Cờ này không làm giảm tải; nó
  giúp tránh chạy nhầm một lệnh có thể làm cạn CPU, RAM, socket hoặc dung lượng đĩa.
- Mọi scenario đều hữu hạn: API cần `--operations`, `--duration`, hoặc cả hai;
  crawl chạy thật cần `--timeout`.
- Mỗi request có timeout và giới hạn số byte response mà load generator đọc.
- Không nhận password, bearer token, cookie hoặc header tùy ý từ CLI. Password chỉ
  được đọc từ `WEBLENS_LOAD_PASSWORD`; token tùy chọn chỉ từ
  `WEBLENS_LOAD_ACCESS_TOKEN`.
- Report và console không ghi email, password, token, cookie hoặc response body.
- URL có userinfo hoặc query key nhạy cảm bị từ chối.
- Target ngoài loopback cần đồng thời `--allow-non-loopback` và
  `--confirm-target-ownership`. Chỉ dùng chúng với môi trường kiểm thử do bạn sở hữu
  và đã cô lập; không dùng bộ công cụ này để tạo tải lên website công cộng.

## 1. Chạy crawl fixture

Ví dụ nhỏ:

```powershell
node tools/load/fixture.mjs --port 9090 --pages 100 --fanout 10 --delay 2ms --body-bytes 4096
```

Fixture 100.000 trang:

```powershell
node tools/load/fixture.mjs `
  --port 9090 `
  --pages 100000 `
  --fanout 32 `
  --delay 0ms `
  --body-bytes 4096 `
  --robots allow `
  --acknowledge-high-load
```

Các endpoint:

- `GET /`: trang số 0.
- `GET /page/{id}`: trang từ 1 đến `pages - 1`.
- `GET /robots.txt`: trả chính sách chọn bằng `--robots allow|deny`.
- `GET /__fixture/health`: health và cấu hình máy sinh trang.

Đồ thị link là cây xác định. Trang `i` liên kết tới các trang từ
`i * fanout + 1` đến `i * fanout + fanout` nếu ID còn trong phạm vi. Với 100.000
trang và fanout 32, crawler cần `maxDepth >= 4`.

Fixture không tạo mảng 100.000 trang trong RAM. Nó tính link khi nhận request và
stream phần padding bằng buffer dùng chung. `--body-bytes` là kích thước chính xác
của mỗi HTML response; chương trình từ chối cấu hình quá nhỏ để chứa toàn bộ link.
Nhấn `Ctrl+C` để dừng fixture.

> Crawler phải dùng `CRAWLER_LOCAL_TARGETS_ONLY=true` khi gọi fixture local nhưng vẫn chặn
> public IP, link-local và metadata endpoint. Không tắt toàn bộ SSRF guard chỉ để
> truy cập fixture.

## 2. Chạy tải API

Smoke test health với 20 virtual user và 2.000 request:

```powershell
node tools/load/run.mjs api `
  --base-url http://127.0.0.1:8080 `
  --path /actuator/health `
  --virtual-users 20 `
  --operations 2000 `
  --request-timeout 2s
```

Tải một endpoint cần đăng nhập bằng một tài khoản dùng chung:

```powershell
$secret = Read-Host 'WEBLENS_LOAD_PASSWORD' -AsSecureString
$env:WEBLENS_LOAD_PASSWORD = [System.Net.NetworkCredential]::new('', $secret).Password

node tools/load/run.mjs api `
  --base-url http://127.0.0.1:8080 `
  --path /api/v1/me `
  --email load-owner@example.test `
  --virtual-users 1000 `
  --duration 2m `
  --request-timeout 5s `
  --acknowledge-high-load

Remove-Item Env:WEBLENS_LOAD_PASSWORD
```

100.000 virtual user, mỗi user thực hiện tối đa một request:

```powershell
node tools/load/run.mjs api `
  --base-url http://127.0.0.1:8080 `
  --path /actuator/health `
  --virtual-users 100000 `
  --operations 100000 `
  --request-timeout 10s `
  --report-interval 2s `
  --acknowledge-high-load
```

`virtual-users` ở đây là số vòng lặp request đồng thời trong load generator, không
phải 100.000 row `users` khác nhau. Khi có `--email`, các virtual user dùng chung
một access token. Việc seed 100.000 identity là workload riêng và không nên trộn
với benchmark latency của một endpoint.

## 3. Lập kế hoạch một scan lớn

Khởi động fixture trước, sau đó kiểm tra ba health endpoint và khả năng cung cấp
đủ trang mà không tạo user, website hoặc scan:

```powershell
node tools/load/run.mjs crawl `
  --base-url http://127.0.0.1:8080 `
  --crawler-health-url http://127.0.0.1:8081/health/ready `
  --fixture-url http://127.0.0.1:9090/ `
  --pages 100000 `
  --plan-only `
  --acknowledge-high-load
```

Kế hoạch cho biết `maxPages` và `maxDepth` tối thiểu mà server phải cung cấp.
Control Plane hiện không có capability endpoint công khai, nên runner chỉ đọc
được `effectiveConfig` sau khi API đã tạo scan.

## 4. Chạy một scan tối đa 100.000 trang

```powershell
$secret = Read-Host 'WEBLENS_LOAD_PASSWORD' -AsSecureString
$env:WEBLENS_LOAD_PASSWORD = [System.Net.NetworkCredential]::new('', $secret).Password

node tools/load/run.mjs crawl `
  --base-url http://127.0.0.1:8080 `
  --crawler-health-url http://127.0.0.1:8081/health/ready `
  --fixture-url http://127.0.0.1:9090/ `
  --pages 100000 `
  --email load-owner@example.test `
  --timeout 6h `
  --poll-interval 2s `
  --request-timeout 10s `
  --report-interval 5s `
  --acknowledge-high-load

Remove-Item Env:WEBLENS_LOAD_PASSWORD
```

Runner thực hiện theo thứ tự:

1. Kiểm tra health của Control Plane, Crawler và fixture.
2. Xác thực bằng bearer token đã cấp qua biến môi trường hoặc login một lần.
3. Tìm website có canonical URL trùng fixture; nếu chưa có thì đăng ký website.
4. Tạo đúng một scan với idempotency key ngẫu nhiên.
5. Đối chiếu `effectiveConfig.maxPages` và `maxDepth` với fixture. Nếu chưa đủ,
   runner yêu cầu hủy scan và báo lỗi rõ ràng.
6. Poll trạng thái đến terminal hoặc hết `--timeout`. Mặc định runner yêu cầu hủy
   khi timeout; dùng `--no-cancel-on-timeout` nếu muốn scan tiếp tục chạy.

Nếu đã biết website ID, truyền `--website-id <uuid>` để bỏ bước tìm/tạo website.
Runner vẫn đọc website này và yêu cầu `canonicalUrl` trùng chính xác với fixture
đã chuẩn hóa; nếu lệch, nó dừng trước khi tạo scan để tránh tải nhầm target.
Runner không truyền `maxPages` trong body vì API V1 hiện lấy giới hạn từ cấu hình
Control Plane; nó chỉ xác minh snapshot cấu hình mà API trả về.

## 5. Đọc kết quả

Trong khi chạy, console chỉ in aggregate metrics định kỳ. Report JSON cuối gồm:

- profile máy phát tải: phiên bản Node, OS, kiến trúc, số CPU logic và RAM;
- cấu hình scenario đã loại dữ liệu xác thực;
- request đã bắt đầu/hoàn tất, thành công/thất bại, timeout và max in-flight;
- throughput trung bình;
- latency `min`, `mean`, `p50`, `p95`, `p99`, `max` theo milliseconds;
- histogram HTTP status và nhóm lỗi mạng;
- với crawl: scan ID, tiến độ cuối, effective config và trạng thái terminal.

Latency percentile dùng histogram độ phân giải 1 ms. Giá trị vượt request timeout
được gom vào bucket tràn, còn `max` vẫn giữ latency quan sát thực tế.

Runner không áp một SLO pass/fail vì mục tiêu saturation là quan sát điểm gãy.
HTTP/network error vẫn được ghi là `COMPLETED_WITH_ERRORS`; lỗi cấu hình, preflight
hoặc contract làm tiến trình trả exit code khác 0.

Smoke test hoàn toàn local, dùng mock Control Plane/Crawler và fixture ở cổng ngẫu
nhiên:

```powershell
node tools/load/smoke-test.mjs
```

## Giới hạn cần hiểu trước khi kết luận

- Một tiến trình Node và một máy Windows có thể cạn socket, ephemeral port, CPU
  hoặc RAM trước server. 100.000 virtual user không đồng nghĩa chắc chắn có
  100.000 TCP connection hoạt động cùng một thời điểm.
- Muốn phân biệt load-generator saturation với server saturation, theo dõi đồng
  thời CPU/RAM/socket của cả hai phía và chạy lại từ nhiều máy phát tải.
- `run.mjs crawl` tạo một scan; số crawler worker thật do Crawler Service quyết
  định. Script không giả lập 10.000 worker và không bypass lease/fencing.
- Fixture đo pipeline crawl trong mạng local, không đại diện DNS, TLS, bandwidth,
  politeness hay độ trễ Internet.
- Report page-level hiện có thể bị API giới hạn số item trả về; dùng progress và
  database/ClickHouse metrics để xác nhận đủ 100.000 page result.
- Trước khi công bố capacity trong CV, ghi lại cấu hình phần cứng, container,
  PostgreSQL, ClickHouse, connection pool, dataset, thời lượng, cache state và tỷ
  lệ lỗi. Một lần chạy đến khi sập chỉ xác định một failure point của cấu hình đó.
