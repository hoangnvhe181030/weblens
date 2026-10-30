# Sửa luồng hủy scan khi event Crawler đến muộn

Ngày: 03/10/2026, giờ local UTC+7.
Phạm vi: code local và kiểm thử. Bản sửa chưa triển khai production.

## 1. Bằng chứng và bản sửa

Lượt `worker64-500-after-claimfix`, run ID `20261002T095900Z`, có 500 execution
Crawler COMPLETED nhưng Control Plane ghi 464 COMPLETED / 36 CANCELLED. Đủ 36
event cuối được giao, version khớp Crawler, nhưng inbox ghi IGNORED_STALE vì
projection local đã terminal sau yêu cầu hủy. Hồ sơ gốc:
`WEBLENS_500_SCAN_REVIEW_2026-10-03.md`.

Hai file runtime thay đổi:

- `backend/src/main/java/com/weblens/scan/entity/ScanEntity.java`: yêu cầu hủy
  QUEUED hoặc RUNNING chuyển sang CANCEL_REQUESTED; không tự chốt CANCELLED.
- `backend/src/main/java/com/weblens/scan/model/ScanStateMachine.java`: cho phép
  QUEUED → CANCEL_REQUESTED.

Luồng event hiện hữu đã áp dụng được terminal COMPLETED/PARTIAL_SUCCESS/FAILED/
CANCELLED từ CANCEL_REQUESTED và giữ yêu cầu hủy khi progress RUNNING đến muộn.
Giữ chốt version, terminal, owner, inbox dedup và lock theo scan. ScanService.cancel
và cancelForSiteClone đều dùng phương thức domain chung đã sửa, nên không cần
thêm một luồng hủy riêng. Một scan CANCEL_REQUESTED tiếp tục chiếm active quota
và chặn archive website cho tới khi nhận kết quả Crawler.

Crawler hiện hữu trả EXECUTION_NOT_READY khi cancel đến trước start; transaction
đó không ghi inbox, nên dispatcher có thể thử lại. Cancel sau remote completion
giữ terminal execution và event hoàn tất đã có trong outbox. Đây là hành vi đã
kiểm chứng, không có runtime Crawler mới trong bản sửa này.

Không có schema, migration, index hoặc dependency mới. Các thay đổi có sẵn trước
tác vụ trong worktree được giữ nguyên. Bản sửa không thay đổi các artifact hay
outcome FAILED của lượt tải gốc.

## 2. Kiểm thử và tái lập

Trước sửa runtime, các regression test mới thất bại đúng cơ chế của lỗi:
event COMPLETED bị IGNORED_STALE và scan bị chốt CANCELLED tại thời điểm yêu cầu.
Sau sửa, các kiểm thử domain, event, service và clone liên quan đã qua.

Build Backend bằng `.\mvnw.cmd -DskipITs verify`: **86 unit tests passed**, không
failure/error/skip; JAR đã đóng gói thành công. Integration suite mới được chạy
riêng như dưới đây; `-DskipITs` không được coi là bằng chứng các suite IT cũ đã qua.

`ScanCancellationIT` chạy trên PostgreSQL thật, không có transaction bao toàn
test. Mỗi lời gọi service tự commit; assertions đọc lại từ database:

1. Terminal đến muộn được áp dụng; event trùng và progress cũ không ghi đè.
2. Hai yêu cầu hủy đồng thời chỉ commit một cancel command.
3. Completion cạnh tranh với cancellation vẫn kết thúc COMPLETED.
4. Lỗi sau insert outbox rollback cả command và trạng thái yêu cầu hủy.
5. Clone đang chờ đã bị hủy không được dispatch khi completion của scan đến muộn.

Kết quả: **5 tests, 0 failures, 0 errors, 0 skipped**.
Database test là PostgreSQL 18.4 trên loopback, port 55449, hai database riêng
`weblens_test_scan_cancel` và `weblens_test_crawler_cancel`. Docker local không
khả dụng; chưa xác minh integration trên PostgreSQL 17 của production. Cluster
test đã dừng sau kiểm thử; thư mục dữ liệu test được giữ để truy lại evidence.

Chạy mặc định với Docker/PostgreSQL 17.6:

```powershell
cd backend
.\mvnw.cmd '-Dtest=ScanCancellationIT' test
```

Khi có native PostgreSQL test riêng:

```powershell
.\mvnw.cmd '-Dtest=ScanCancellationIT' '-Dweblens.test.postgres-url=jdbc:postgresql://127.0.0.1:55449/weblens_test_scan_cancel' test
```

URL tùy chọn chỉ chấp nhận host 127.0.0.1 và database bắt đầu bằng weblens_test_.
Phải tạo database test trước; Flyway chỉ áp dụng migrations hiện hữu. User mặc
định postgres/password rỗng chỉ dành cho cluster test loopback; có thể chỉ định
`weblens.test.postgres-user` và `weblens.test.postgres-password` cho môi trường test.
Không trỏ các lệnh này vào database ứng dụng.

Crawler workflow integration: **10 subtests passed**, gồm hai kiểm tra bổ sung
cancel trước start và cancel sau completion. Suite tạo schema test riêng và tự
dọn đúng schema đó. Kiểm thử unit liên quan của postgres/httpapi cũng đã qua;
package events hiện không có unit test riêng.

```powershell
cd crawler
$env:WEBLENS_TEST_POSTGRES_URL='postgres://postgres@127.0.0.1:55449/weblens_test_crawler_cancel?sslmode=disable'
go test ./internal/postgres -run '^TestStoreWorkflowIntegration$' -count=1 -v
go test ./internal/postgres ./internal/events ./internal/httpapi
```

FoundationApiIT được cập nhật: hủy lần đầu trả 202/CANCEL_REQUESTED, lặp lại trả
200/CANCEL_REQUESTED; archive vẫn bị chặn. Sau event CANCELLED từ Crawler, GET
trả CANCELLED và archive được phép. Fixture persistence cũ cũng được cập nhật
để kết thúc scan bằng terminal confirmation thay vì coi request là xác nhận.
Hai suite này cần Docker; chưa chạy lại đầy đủ trong môi trường local hiện tại.

## 3. Phương án sửa 36 scan lịch sử — đề xuất để duyệt

Chỉ áp dụng cho đúng run ID nêu trên. Bản sửa code không tự sửa 36 row cũ.
Không phát lại nguyên message ID vì inbox đã ghi nhận; không xóa inbox hoặc
gỡ terminal guard để ép replay.

36 ordinal trong `full-run-audit/share/cross-service-reconciliation.csv`:

`1, 49, 91, 96, 111, 214, 246, 247, 248, 250, 252, 260, 282, 288, 292,
300, 302, 305, 309, 317, 318, 328, 339, 340, 345, 371, 377, 381, 388, 395,
414, 417, 424, 437, 451, 483`.

Các bước cho thao tác sửa riêng sau khi được duyệt:

1. Đọc lại đúng 36 identity từ raw evidence private; đối chiếu owner, scan ID,
   Crawler COMPLETED, succeeded/expected/published=1.000, version terminal và
   outbox/inbox cuối. Không dùng ordinal làm khóa database.
2. Đọc lại Control Plane để xác nhận vẫn CANCELLED, remote_execution_version=0
   và không thay đổi counters/row version so với precheck. Kiểm tra liên kết
   capture/site-clone trước khi sửa; dừng nếu có side effect cần quyết định.
3. Chuẩn bị danh sách chính xác field trước/sau. Đề xuất sửa trực tiếp projection
   theo terminal Crawler đã xác minh trong transaction có giới hạn: trạng thái,
   counters, analytics status/watermark, remote version và timestamps thực.
   Giữ cancellation_requested_at để lưu lịch sử người dùng đã yêu cầu hủy.
4. Mỗi update phải có predicate scan ID + owner + expected local row version +
   CANCELLED + remote version0, tăng local version. Sai bất kỳ precondition hoặc
   row count thì rollback; không update theo status toàn bảng.
5. Giữ inbox IGNORED_STALE nguyên trạng làm evidence; lưu proof riêng về correction.
   Không tự dispatch clone/capture hoặc tạo command/event nghiệp vụ mới khi sửa.
6. Đọc lại 500 ID để xác nhận 500 COMPLETED và counters projection khớp execution.
   Giữ nguyên báo cáo benchmark gốc; ghi rõ correction diễn ra sau lượt test.

Đây là đề xuất thao tác DML có phạm vi; chưa viết/chạy script cập nhật production.
Không yêu cầu lại backup/global recovery/resource gate người dùng đã bỏ cho đo tải.
Không tuyên bố global DEAD/orphan PERSISTING sạch.

## 4. Triển khai và giới hạn

Trước rollout, kiểm thử tích hợp trên PostgreSQL 17; đối chiếu source/hash đúng
artifact đang deploy. Checkout có các thay đổi khác đang dở, nên cần đóng gói
bản sửa trên source runtime phù hợp và review diff trước khi deploy. Lưu hash
artifact hiện tại và artifact mới để rollback binary đúng phiên bản.

Rollout cần restart Backend theo quy trình deployment hiện có và lượt nhỏ có
kiểm soát: trì hoãn event, cancel, sau đó giao terminal; so sánh đúng identity
giữa Crawler/Control Plane/inbox và xác minh cleanup. Tác vụ hiện tại chưa rollout
hoặc phát workload production. Chưa chạy lại 500 hoặc 1.000.

Rollback binary cũ sẽ khôi phục hành vi hủy QUEUED sai; không ghi CANCELLED cho
scan CANCEL_REQUESTED còn chờ chỉ để làm sạch trạng thái. Phải theo dõi riêng các
scan đang chờ và giữ outbox/inbox để giao tiếp tiếp tục.

Nếu command/event hết 20 lần retry và chuyển DEAD, scan có thể tiếp tục
CANCEL_REQUESTED. Bản sửa không che lỗi đó bằng terminal giả; cần xử lý delivery
trong phạm vi được xác minh. Cũng chưa sửa độ trễ event, API/pool timeout, login
surge hoặc dispatch queue. startedAt/finishedAt hiện vẫn là thời điểm projection
áp dụng event; đổi sang timestamps Crawler cần contract tương thích riêng.

## 5. Điều cần hiểu trước khi nhận code

- Yêu cầu hủy là một ý định; CANCELLED là kết quả thực thi đã được xác nhận.
- Inbox dedup và version xử lý duplicate/out-of-order; terminal guard vẫn cần
  để bảo vệ kết quả cuối. Không dùng event timestamp để suy thứ tự thay cho version.
- Row lock tuần tự hóa cancellation/event theo scan; transaction gắn trạng thái
  với command outbox, tránh trạng thái đã đổi nhưng không có lệnh bền vững.
- Kiểm thử qua database sau commit khác với đọc entity đang được cache trong
  cùng transaction; rollback và cạnh tranh cần được kiểm chứng bằng transaction thật.
