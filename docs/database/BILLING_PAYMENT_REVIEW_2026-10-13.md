# Billing và payment — hồ sơ review revision 1

Ngày: 2026-10-13. Trạng thái: **workload/policy và phạm vi bốn bảng revision 1
được người dùng phê duyệt bằng phản hồi “đồng ý” sau bàn giao**.
Schema/persistence/IPN local đã triển khai trong
[execution report](BILLING_SCHEMA_EXECUTION_2026-10-13.md); production/live chưa được bật.
Kiểm chứng PostgreSQL17/HTTP/auth/JVM crash sau đó nằm trong
[runtime recovery report](../testing/BILLING_RUNTIME_RECOVERY_2026-10-13.md).

Người dùng yêu cầu thanh toán VNPAY Sandbox, tính phí theo trang thành công,
cho phép agent chọn workload hợp lý và muốn đổi provider/môi trường sau này.
Các con số dưới đây là **giả định phục vụ thiết kế và kiểm thử**, không phải số
người dùng thực tế, capacity production hay cam kết của VNPAY.

## Phạm vi và cổng kiểm soát

- Billing là phần mở rộng riêng theo yêu cầu mới, không tự biến thành capability
  đã hoàn tất của V1/V1.5 trong `PRODUCT.md` hoặc đổi thứ tự V2/V3.
- Nhóm RED `credit_accounts`, `credit_ledger`, `usage_reservations`,
  `payment_orders` đã được phê duyệt riêng theo `DESIGN_GATES.md` cho schema và
  persistence/IPN local revision 1; không hạ mức các bảng RED khác.
- Java Control Plane sở hữu payment, credit, reservation và settlement.
  Không thêm deployable/datastore/dependency; Redis chỉ giữ vai trò auth hiện tại.
- Không sửa bảng `scans`/`websites` đã đóng băng. Quan hệ billing riêng tham chiếu
  scan theo ownership được review; không tạo cross-service FK.
- Giai đoạn review ban đầu chỉ có adapter/policy và unit test. Sau phê duyệt,
  bổ sung V14, persistence và API có feature flag, mặc định tắt. Chưa cấu hình
  secret thật, frontend checkout hoặc đường thu phí scan.

## 1. Nghiệp vụ và invariant

Người dùng mua gói credit từ catalog server, nhận checkout của provider, xem
trạng thái đơn hàng và số dư. Credit là đơn vị sử dụng nội bộ, **không phải ví
điện tử**, không chuyển giữa user, rút tiền hoặc đổi credit thành tiền mặc định.
Gói mẫu cho test: 10.000 VND mua 1.000 credit; 1 credit/trang. Đây không phải
giá thương mại. Order/reservation phải pin package, giá, currency và policy version;
client không gửi số tiền hoặc tỷ lệ credit đáng tin cậy.

Invariant bắt buộc:

- Không credit hai lần cho một payment order/provider transaction; không tạo
  hai reservation cho một explicit scan khi retry.
- `available = balance - held`, `balance >= held >= 0`. Ledger bất biến là
  bằng chứng; account là projection cập nhật nguyên tử với ledger.
- Reserve giữ hạn mức, chưa tiêu credit. Finalize giảm balance theo thực dùng
  và giải phóng toàn bộ hold của reservation trong cùng transaction.
- Mỗi reservation có tối đa một logical finalization; mọi replay giữ cùng kết quả.
- Không dùng số dư Java read-then-write thiếu lock; không đưa VNPAY/ClickHouse
  hoặc Crawler network call vào transaction giữ row lock.
- Browser ReturnURL không được cộng credit. Chỉ IPN đã xác thực/đối soát provider
  và so khớp đơn hàng bền vững mới có quyền settlement.
- Signature đúng không thay thế owner authorization, amount/currency/order
  comparison, transaction hoặc unique constraint.
- Không cascade xóa ledger/payment cùng user; phải quyết định pseudonymization,
  export và retention trước khi đưa tính năng xóa account vào billing.

### Policy thu phí `successful-html-v1`

Một billable page là một logical page ID duy nhất của explicit scan: final HTTP
2xx, HTML parse thành công, body không truncated, evidence usable đã publish và
được xác nhận bằng contract có version. Retry page, redirect hop và duplicate event
không tạo thêm credit usage. Không tự dedup các page ID khác nhau bằng body hash.

| Kết quả terminal có xác nhận | Thu phí | Phần giữ chỗ còn lại |
| --- | --- | --- |
| COMPLETED / PARTIAL_SUCCESS | Số billable page đã công bố × giá đã pin | Giải phóng |
| Người dùng hủy, Crawler xác nhận CANCELLED | Chỉ phần usable đã công bố đến terminal watermark | Giải phóng |
| Lỗi nội bộ đã xác nhận khiến job FAILED | 0, kể cả có kết quả một phần | Giải phóng toàn bộ |
| Progress, CANCEL_REQUESTED, timeout mạng hoặc trạng thái chưa rõ | Chưa chốt phí | Giữ và reconcile có giới hạn/SLO |
| Hủy trước khi có trang billable | 0 | Giải phóng toàn bộ khi xác nhận terminal |

HTTP 4xx/5xx, policy-blocked, non-HTML, parse error, truncation và final 3xx không
billable. Lỗi target có thể tạo PARTIAL_SUCCESS với trang khác billable; internal
failure cần mapping terminal reason được review, không suy ra từ mọi failed page.
Nếu complete thắng race với cancel, dùng terminal version thắng được Crawler xác
nhận; không dựa trên thời điểm browser bấm nút hủy.

Clone/capture và scan do clone tạo **chưa tính phí trong revision này**. Không áp
quota thanh toán vào `ScanService.create` dùng chung mà vô tình thu phí clone
hoặc cho phép user giả mạo origin miễn phí. Call path phải đặt origin server-side.
Giữ nguyên quota tối đa ba active scan/user; không tăng giới hạn crawl hiện tại.

Admission hiện không nhận page budget riêng; source default `max-pages=100000`.
Nếu reserve trực tiếp default này, gói test 1.000 credit sẽ không đủ dù scan chỉ
có 100 trang. Đề xuất cần review: explicit paid scan có server page budget tối
đa 500 cho gói test, effective maxPages bằng min(budget được chọn, trần crawl hiện
có), công khai trong effective config trước khi accepted. Reserve đúng effective
maxPages và pin cùng giá/policy; thiếu available credit thì reject, không âm số dư.
Không tự hạ budget theo balance sau khi accepted, không reserve 500 rồi cho
Crawler chạy 100.000 trang. Scan nội bộ clone giữ config đã duyệt, chưa billed.
Đây là điều chỉnh admission được đề xuất, chưa áp dụng vào `ScanService`.

## 2. Workload dự kiến

| Tham số | Giả định được agent chọn theo yêu cầu người dùng |
| --- | --- |
| Account có billing | 100.000, user/cardinality tương ứng cần seed độc lập |
| User hoạt động mỗi ngày | 10.000 |
| Order/ngày, gồm cả không thanh toán | 1.000 |
| Explicit scan có reservation/ngày | 10.000 |
| Trang/scan trung bình / p95 / tối đa fixture | 100 / 500 / theo cấu hình crawl đã được duyệt; không tự tăng trần |
| Client giả lập tối đa | 1.000 client; không đồng nghĩa 1.000 request đang chạy hoặc browser job |
| Tải synthetic billing baseline / burst | 50 RPS × 10 phút / 150 RPS × 3 phút |
| Soak synthetic | 50 RPS × 30 phút |
| Contention test riêng | 100 request đồng thời cùng account; 200 IPN replay cùng order |
| Phân bố owner | Baseline phân tán; test riêng 80% write vào 1% account |

RPS synthetic cố tình lớn hơn lưu lượng trung bình ngày để kiểm tra headroom;
không nhân RPS benchmark 24 giờ rồi dùng như forecast doanh thu/dung lượng.
Chạy callback **provider simulator** cho tải, chỉ vài case chức năng trên VNPAY
Sandbox/SIT. Không stress VNPAY, website bên ngoài hay production bằng bộ seed này.

## 3–7. Hồ sơ theo từng trách nhiệm dữ liệu

Các tên là candidate logical tables, **không phải schema cuối cùng**. Byte/row là
ước lượng payload phục vụ lập budget; phải thay bằng đo `pg_total_relation_size`,
index/WAL và footprint backup sau khi schema được duyệt.

| Candidate | Truy vấn (bước 3) | Ghi (bước 4) | Cardinality và dung lượng giả định (bước 5) | Consistency/concurrency (bước 6) | Retention (bước 7) |
| --- | --- | --- | --- | --- | --- |
| `credit_accounts` | Owner-scoped balance/held/available một row; cập nhật conditional cho reserve | Tạo một lần; topup, reserve, finalize cập nhật; không write mỗi page | 100k row; payload 0,1–0,3 KiB/row, khoảng 10–30 MiB chưa index/WAL | Serialize write theo account trong local transaction; read thấy commit sau khi ack; không hot global balance | Giữ khi account còn mở; close chỉ sau hold=0 và review giữ ledger |
| `payment_orders` | Owner detail; idempotency replay; callback lookup theo provider scope/reference; history keyset mới nhất; pending reconciliation batch | 1k insert/ngày; pin amount/credit package/provider/environment/merchant; update lifecycle/dedup marker khi callback/query về | 365k row/12 tháng; payload 0,5–1 KiB/row, khoảng 0,17–0,35 GiB | Nhiều IPN/query đồng thời; unique logical reference và provider transaction trong đúng merchant/environment scope; settle nguyên tử với account/ledger | 12 tháng online; unresolved/paid cần giữ dedup và audit kể cả khi archive |
| `usage_reservations` | Theo explicit scan+owner; unresolved due batch; owner history/detail | 10k insert/ngày; tối đa một finalization; snapshot maxPages, giá/policy và evidence version | 3,65m row/12 tháng; payload 0,25–0,5 KiB/row, khoảng 0,87–1,74 GiB | Scan event/cancel/reconciler race; terminal evidence monotonic, không bill progress; thao tác nguyên tử với account/ledger | 12 tháng online sau terminal; unresolved không TTL-delete; giữ dedup khi archive |
| `credit_ledger` | Owner history keyset, tối đa 100 row; reconcile projection bằng batch/snapshot, không sum toàn bộ trên API nóng | Append topup; append reserve; append FINALIZE gồm charge+release; không sửa/xóa entry để chữa số dư | Khoảng 7,665m row/12 tháng nếu 365k topup + 2×3,65m usage; đây là upper bound khi mọi order paid. Payload 0,2–0,5 KiB, khoảng 1,46–3,66 GiB | Unique source+operation; retry không append lần hai; balanceDelta và heldDelta cùng transaction với projection | 12 tháng online là giả định portfolio, không kết luận đủ cho kế toán/pháp luật; archive trước purge và giữ anchors |

History read tối đa 100 row, filter owner và khoảng thời gian; sort theo createdAt
và tie-breaker ổn định. Baseline mix: 60% balance/order/history read, 20% create
topup order, 10% reserve scan, 10% IPN/settle. Cần seed case zero balance, low
balance, heavy tenant, unpaid/expired và mixed terminal outcomes, không chỉ happy path.

Mục tiêu đề xuất: reconcile due mỗi phút, phát hiện hold/pending bất thường trong
5 phút. Network timeout không chứng minh scan/payment thất bại. Unresolved >15 phút
cảnh báo; không tự hoàn hold cho scan vẫn chạy. Muốn release orphan phải chứng
minh không còn execution hoặc cancel/fence trước. Late success payment đi qua
review/reconciliation, không bị discard chỉ vì expiry local.

Retention online không phải retention tài chính khi nhận tiền thật. Đề xuất backup
mỗi ngày + WAL/PITR nếu runtime hiện tại chứng minh hỗ trợ, giữ 30 ngày, RPO mục tiêu
≤5 phút/RTO ≤60 phút. **Chưa có bằng chứng đạt**, chưa cấu hình backup mới.
Restore phải giữ pending payments/holds, replay IPN và reconcile provider; không
ghi nhận mất payment như một sự cố đã tự giải quyết. Không lưu card, OTP, secret,
raw callback, raw query URL; chỉ normalized metadata tối thiểu và fingerprint cần thiết.

## Phương án sau khi nhóm được duyệt (bước 8–12, chưa DDL)

1. Chỉ có một mutable balance: ít bảng nhưng không có audit/rebuild hoặc bằng
   chứng chống duplicate đủ tốt. Không đề xuất.
2. SUM toàn ledger cho mọi admission: dễ nhìn nhưng chi phí read tăng theo history,
   còn cần cơ chế serialize admission. Không đề xuất cho hot path.
3. **Đề xuất** bốn trách nhiệm ở trên: immutable ledger + account projection +
   reservation + order snapshot. Dùng order settlement marker/semantic fingerprint
   thay callback-inbox table riêng; log diagnostic redacted không phải source of truth.

Chưa cần partition hoặc provider plugin framework. Khi khoảng 7–8 triệu row/năm
gây vấn đề thật về history/GC/VACUUM mới benchmark partition; unique dedup qua
partition/retention phải được thiết kế lại, không thêm theo tên tính năng.
PK/FK, constraints và index vật lý thuộc review kế tiếp; ưu tiên logical uniqueness
theo owner/idempotency scope, source operation và provider/environment/merchant.
Index candidate chỉ phục vụ lookup trên, owner keyset history và due unresolved
batch; phải kiểm tra EXPLAIN trên dữ liệu có skew trước chốt.

### Transaction và crash recovery dự kiến

- Create topup: authorize → lấy package server → persist immutable order và key
  fingerprint → commit → build checkout. Mất response thì retry cùng key trả cùng
  order; thay request phải conflict, không tạo order thứ hai.
- IPN: bounded query multimap → verify checksum → kiểm tra merchant → lookup/lock
  order → so amount/currency/provider snapshot → lock account → insert unique topup
  ledger + cộng projection + đánh dấu settled → commit → ack `00`. Replay đã settle
  và cùng semantic transaction trả `02`; conflicting metadata không ack là replay
  bình thường. Crash trước commit rollback; crash sau commit trước ack replay không
  cộng thêm. DB không sẵn sàng phải retry/fail, tuyệt đối không ack thành công.
- Admission explicit scan: giữ owner/website authorization/quota/idempotency hiện có;
  reserve, ledger, public scan và command outbox phải commit cùng transaction trong
  Control Plane. Không gửi command trước commit; rollback không để lại hold/outbox.
- Terminal settlement: authenticated/versioned crawler evidence → inbox dedup và
  scan projection → reservation finalization + ledger + account trong cùng local
  transaction. Không remote query trong transaction; prepare/fetch evidence ngoài
  transaction rồi lock/recheck version, hoặc dùng contract terminal đủ bằng chứng.
- Lock order đề xuất: terminal/reconciler `scan → reservation → account`;
  payment `order → account`; admission giữ `user → website`, account là lock
  tài chính cuối, chỉ tạo scan mới. Không đường nào lock account rồi quay lại lock
  scan/order/user. Review toàn caller/delete/admin trước triển khai.
- Retry 40001/40P01 phải retry toàn transaction có giới hạn, jitter và metric;
  không retry từng statement trong transaction hỏng. External side effect ở ngoài.
- Reserve/settle idempotency là hiệu ứng logical đúng một lần dựa trên local
  constraints+transaction; delivery vẫn at-least-once, không hứa distributed exactly-once.
- Lost IPN, provider timeout, stale projection và crash worker cần due reconciler,
  lease/fencing hiện có và visibility metric. Không dùng ClickHouse SUM làm balance.

## Provider portability và VNPAY

`PaymentGateway` hiện có port checkout và normalized `VerifiedPayment`/identity.
VNPAY giữ riêng canonical signing, amount wire scale, IPN GET parser. Provider
khác có adapter và verifier HTTP/body riêng trả normalized notification; không ép
mọi webhook vào GET query. Currency sử dụng integer minor units; VND exponent 0,
VNPAY wire scale ×100 chỉ nằm trong adapter. Adapter chưa có query/refund API.

Mỗi order phải pin provider/environment/merchant và credential configuration
version; đổi provider chỉ áp dụng đơn mới. Order cũ còn pending phải route về
adapter/key cũ đủ lâu cho IPN/query/reconciliation. Không chuyển tất cả pending
order theo setting provider mặc định. Key rotation là operator workflow, không
tự thử vô hạn mọi secret hoặc log checkout/callback URL.

Đổi Sandbox → Live không chỉ là đổi URL: cần merchant contract, IPN đăng ký,
credential thật, kiểm thử merchant/provider và retention/refund policy review.
Runtime mặc định disabled; live cần operator enable riêng và host allowlist đã
xác minh. Adapter hiện validate HTTPS và tránh nhầm sandbox/live, nhưng LIVE host
được cấu hình bởi caller tin cậy, **không phải allowlist production hoàn chỉnh**.

Đã đối chiếu [tài liệu chính thức VNPAY PAY](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html)
ngày 2026-10-13: HMAC-SHA512 trên tham số đã sắp xếp/form-encode, timestamp UTC+7,
VND ×100, IPN HTTPS GET; ReturnURL chỉ hiển thị, không settlement. Success cần cả
ResponseCode và TransactionStatus là `00`. PHP demo có OR khác C# demo AND;
implementation chọn AND để không credit một giao dịch chưa thành công.
Verify dùng query decoded-once, reject duplicate, sign cả trường `vnp_*` mới,
bỏ SecureHash/SecureHashType và optional rỗng theo mẫu Java/C#. Không log payload.
UTF-8 cho form encoding, checkout description ASCII; chưa xác nhận edge Unicode
callback hoặc optional rỗng bằng SIT thật. VNPAY mã `00`/`02` dừng retry, nên không
trả chúng trước durable commit. Mã sai signature `97`, chưa thấy order `01`,
sai amount `04`, lỗi cập nhật `99`; controller mapping đã triển khai trong execution revision 1.

## Evidence gap phải xử lý trước runtime billing

1. `crawler/internal/crawl/engine.go` gán SUCCESS cho status <400, bao gồm final
   3xx và non-HTML. `ScanProgressPayload` chỉ có succeeded/failed và analytics
   expected/published: **không có publishedBillablePages**. Không dùng
   `min(succeededCount, analyticsPublishedCount)` làm phép đếm thay thế.
2. Cần versioned terminal billing evidence tính từ unique logical page outcomes
   và acknowledged publication watermark, replay/fencing-safe. Producer và Java
   inbox phải kiểm tra bound/count/version/policy; old contract không bill.
   Thay event contract không tự cấp quyền mở rộng schema Crawler RED.
3. Cần rà nguồn explicit scan/clone và terminal reason mapping; không chọn tất cả
   FAILED page là lỗi nội bộ hoặc tất cả PARTIAL_SUCCESS là billable.
4. VPS report ngày 2026-10-12 vẫn NO_GO cho full workload: projection mới trễ,
   fresh scan→capture timeout. Billing phải test trên nền đó, không tăng chain
   synchronous ở admission hoặc dùng stale public status để thu/hoàn phí.
5. Execution revision 1 đã có IPN/persistence và PostgreSQL concurrency/rollback
   tests; runtime review bổ sung PostgreSQL17, HTTP/auth và JVM kill/restart.
   Chưa có VNPAY SIT, billing load result hoặc evidence receipt audit. Những test
   này không thay thế full-workload/production verification.

## Kế hoạch triển khai và tiêu chí chấp nhận

| Ưu tiên / bước | Deliverable | Runnable checks và acceptance |
| --- | --- | --- |
| P0 — hiện tại | Workload/policy/provider port + VNPAY parser độc lập | Independent HMAC vectors, amount overflow/fractional, merchant/signature/duplicate rejection, AND statuses, late callback, policy conservation; module architecture pass |
| P0 — sau review RED revision 1 | Schema bước 8–13, forward Flyway, account/ledger/order/reservation service | PostgreSQL thật: 200 duplicate IPN chỉ một topup; 100 reserve cùng owner không âm available; same key/different payload conflict; cross-owner denied; rollback không lệch ledger |
| P0 | Versioned billable evidence và explicit origin routing | 2xx HTML vs 3xx/non-HTML/parse/truncation; retry/fencing/publish failure; duplicate/out-of-order terminal; cancel vs complete race; clone scan miễn phí; unknown/old evidence không bị charge |
| P0 | IPN/order API + recovery + provider query | Crash trước/sau commit, mất ack, mất IPN, late success, DB/provider down, orphan hold; pending không thành failed chỉ vì timeout; compensation không xóa ledger; reconcile đúng trong ≤5 phút khi dependency trở lại |
| P1 | Frontend mua credit, balance/held/history, trạng thái pending | Return spoof/replay không cộng tiền; amounts từ catalog; refresh/key replay; no URL/body/secret logging; VNPAY functional SIT có registered public HTTPS IPN |
| P1 | Controlled load và regression | Các invariant bên dưới pass trên seed/hardware ghi rõ; auth/report/admission hiện có không bị làm chậm; không gửi load vào VNPAY |
| P1 | Production readiness | Backup restore drill; merchant/live policy review; dashboard/alerts/runbook; billing default off, rollout có rollback giữ ledger/holds; không tự deploy production trong revision này |

Sau phê duyệt, test integration dùng PostgreSQL/Testcontainers, không thay bằng
mock/H2 cho row locking, uniqueness, rollback hoặc crash. API payment phải owner
scoped; IPN anonymous chỉ riêng endpoint, không tắt authentication/CSRF rộng.
Tin client IP chỉ từ peer/proxy chain đã cấu hình, không lấy X-Forwarded-For tùy ý.

Metrics cần có: IPN outcome/invalid/replay/conflict, order pending age,
reservation unresolved age/held credit, reconcile success/failure, transaction
retry/lock wait, pool wait và ledger projection mismatch. Tag chỉ provider,
environment, outcome/policy ổn định; không dùng user/order ID làm metric label.
Alert khi ledger mismatch (dừng charge), hold/order bất thường hoặc callback
failure tăng. Access log của reverse proxy và application phải bỏ query string
trên IPN/ReturnURL; che secret trong exception không đủ nếu proxy vẫn ghi raw URL.

### Benchmark trước/sau — kế hoạch, chưa phải kết quả

- B0: ghi commit/dirty diff, hardware, Java/PG/config, fixture seed/SQL plans và
  API auth/report/admission baseline không billing trên cùng môi trường.
- B1: billing enabled với 100k account, 100k rồi 1m payment orders, 1m reservation,
  3m ledger (seed synthetic độc lập với forecast). Warm và cold test riêng.
- B2: 50 RPS/10 phút, 150 RPS/3 phút, 50 RPS/30 phút; HTTP simulator cho provider.
  1.000 client là ceiling tạo tải, không số job thực. Báo cả offered/achieved RPS,
  in-flight, dropped arrivals, legitimate insufficient-credit responses và errors.
- Mục tiêu chưa đo: billing p95 <300 ms, p99 <1 s, unexpected error <0,1%, không
  dropped arrivals; outbox/projection lag không tăng mất kiểm soát. B0→B1 p95
  existing paths regression ≤10% cùng offered load; nếu B0 đã NO_GO, B1 không
  được gọi GO chỉ vì delta nhỏ. Hot account case có SLO riêng, không trộn percentile.
- Trước/sau chụp lock wait/deadlock, pool wait, query count/plan, DB CPU/WAL,
  ledger reconciliation, API latency, terminal event lag. Sau mỗi run assert
  `balance = SUM(balanceDelta)`, `held = SUM(heldDelta)`, không credit/charge trùng,
  reservation charge+release=reserved, không thất lạc accepted order/scan.
- Tách run parser throughput khỏi end-to-end database load. 64 callback verify
  trong unit test chỉ chứng minh thread safety, không chứng minh capacity.
- Kết quả hiện tại: **B0/B1/B2 chưa chạy**. Report read-load cũ không chứng minh
  payment/clone concurrency. Không viết con số target vào CV như kết quả đạt.

## Xác minh giai đoạn review ban đầu (trước schema)

Lệnh unit/architecture:

```powershell
cd backend
mvn '-Dtest=VnpayGatewayTest,UsageBillingPolicyTest,ModuleArchitectureTest' test
```

Kết quả ngày 2026-10-13:

- Targeted run ban đầu: 58 test, không failure/error/skipped.
- Full `mvn test` sau review cuối: **163 test pass**, không failure/error/skipped;
  gồm 48 VNPAY, 10 usage policy, 2 architecture và 103 test backend hiện có.
  BUILD SUCCESS, 2 phút 05 giây, kết thúc 14:47:09 UTC+7.
- Compile toàn main/test source đã pass. UTF-8 tài liệu đã pass; file Java mới
  chỉ dùng ASCII. Không trailing whitespace trong sáu file mới.
- Không chạy Maven Failsafe integration tests, PostgreSQL billing tests,
  VNPAY SIT, browser E2E hoặc billing benchmark. Không thay runtime production.
- Không secret sandbox nào được dùng trong test; chỉ merchant TEST0001 và key
  fixture không có quyền trên provider. Không thêm dependency.

Sáu file mới của giai đoạn này:

- `backend/src/main/java/com/weblens/billing/gateway/PaymentGateway.java`
- `backend/src/main/java/com/weblens/billing/gateway/VnpayGateway.java`
- `backend/src/main/java/com/weblens/billing/model/UsageBillingPolicy.java`
- `backend/src/test/java/com/weblens/billing/gateway/VnpayGatewayTest.java`
- `backend/src/test/java/com/weblens/billing/model/UsageBillingPolicyTest.java`
- Hồ sơ review này.

Ponytail giữ implementation ở JDK crypto/URI/time, một port checkout và một
adapter; không provider registry/plugin framework, billing microservice hoặc
callback table riêng. Encoding Guard bảo vệ tài liệu tiếng Việt. Các thay đổi
dirty có sẵn của người dùng được giữ nguyên, không commit/push/deploy.

## Quyết định đã được phê duyệt

Người dùng đã phê duyệt nhóm bốn trách nhiệm RED nêu trên,
**hồ sơ workload/policy revision 1** và bước 8–13/persistence/IPN local.
Không coi phê duyệt đó là quyền sửa schema `scans`/`websites`/Crawler RED khác,
nhận tiền thật, deploy production hoặc bỏ qua benchmark/migration review.

## What the developer should understand before accepting this code

- Integer money/credit khác wire amount; tiền callback không phải giá gói credit.
- HMAC xác thực message, còn idempotency/transaction/constraints bảo vệ tài khoản.
- Row lock bảo vệ invariant nhưng serialize hot owner; tăng thread/pool không
  làm biến mất contention và có thể tăng admission timeout.
- Outbox/inbox giải quyết retry giữa service, không tạo transaction chung với
  ClickHouse/provider. Publication evidence phải đủ trước khi charge.
- Một payment adapter không đồng nghĩa payment platform đã production-ready.
  Sức chịu tải cần run có dữ liệu, invariant và báo cáo, không chỉ số user giả định.
