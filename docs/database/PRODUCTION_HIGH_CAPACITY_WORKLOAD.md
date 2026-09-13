# Hồ sơ runtime production dung lượng cao

Trạng thái: cấu hình mặc định được người dùng phê duyệt ngày 2026-09-12; capacity
thực tế vẫn phải được chứng minh bằng benchmark trên hạ tầng triển khai.

## Quyết định cấu hình

WebLens chỉ còn một runtime. Không có profile `dev`, profile `loadtest`, database
hay volume riêng cho load test. Cấu hình mặc định là:

| Thành phần | Giá trị mặc định |
| --- | ---: |
| Trang tối đa của một scan | 100.000 |
| Depth tối đa mặc định | 4 |
| Thời lượng scan tối đa mặc định | 86.400 giây |
| Concurrency snapshot của scan | 10.000 |
| Active page-fetch slot của một crawler instance | 10.000 |
| Request đồng thời trên một public hostname | 2 |
| Delay tối thiểu theo hostname | 1 giây |
| Tomcat connection | 100.000 |
| Tomcat accept backlog | 20.000 |
| Tomcat request thread | 512 |
| Hikari connection của một Control Plane instance | 64 |
| Virtual user tối đa mà load runner nhận | 100.000 |

Schema vẫn giữ hard cap cấu trúc 1.000.000 trang, 10.000 concurrency và bảy ngày.
Mặc định 100.000 thấp hơn hard cap để còn không gian vận hành, nhưng mỗi scan vẫn
là một aggregate rất lớn và phải quan sát storage/WAL/lock/queue age.

## Phân biệt các loại concurrency

- `Tomcat max-connections` là socket NIO có thể được chấp nhận, không phải số
  request chạy Java đồng thời.
- Tomcat thread là số request có thể chiếm thread xử lý; Hikari là số transaction
  database có thể mượn connection trên mỗi instance.
- Scan concurrency là trần page in-flight của execution.
- Crawler worker concurrency là số page fetch có thể hoạt động trên toàn instance.
- Host concurrency là giới hạn áp vào một website đích và mặc định luôn bằng hai
  cho public target.
- Virtual user là vòng lặp đồng thời trong load generator, không đồng nghĩa có
  100.000 row `users` hoặc 100.000 socket thật cùng lúc.

## Cơ chế tránh tự gây sập

Crawler không tạo một polling loop cho mỗi worker slot. Một dispatcher claim tuần
tự khi còn active slot; khi frontier rỗng nó chỉ polling theo một nhịp cấu hình.
Khi đủ slot, dispatcher chờ page hoàn tất trước khi claim thêm. PostgreSQL pool
vẫn hữu hạn và ClickHouse backlog quá tuổi vẫn dừng claim.

Network policy mặc định chỉ cho public target an toàn và chặn private, loopback,
link-local, metadata address ở DNS/dial/redirect. `CRAWLER_LOCAL_TARGETS_ONLY=true`
đổi sang policy chỉ cho loopback/private để chạy fixture do người vận hành sở hữu;
không có chế độ cho phép đồng thời toàn bộ public/private address.

## Cách benchmark runtime chính

1. Ghi cấu hình CPU, RAM, disk/IOPS, PostgreSQL, ClickHouse, pool, cache state và
   commit hiện tại.
2. Chạy health và smoke trước khi tăng tải.
3. Tăng tải theo bậc; ghi throughput, p50/p95/p99, error, timeout, pool wait,
   PostgreSQL lock/WAL/autovacuum, ClickHouse part/merge và queue age.
4. Với fixture local, bật local-only policy và không tắt SSRF guard.
5. Khi đạt điểm bão hòa, giảm tải và xác minh accepted work tự phục hồi, không mất
   job, không double-count và terminal state không quay ngược.
6. Lưu JSON report dưới `tmp/load/`; không commit token, cookie hoặc credential.

Load test bây giờ ghi vào runtime/database chính. Không xóa volume sau test trước
khi đã lấy metric và không dùng website công cộng của bên thứ ba làm target.

## Tiêu chí đánh giá

- Scan mới snapshot đúng 100.000 trang/depth 4/24 giờ/10.000 concurrency.
- Idle claim rate độc lập với 10.000 worker slot.
- Public hostname không vượt hai request đồng thời.
- API tương tác không mất toàn bộ connection vào background work.
- Duplicate command/event không tạo execution hoặc progress trùng.
- ClickHouse chậm làm queue/backpressure tăng có quan sát, không làm mất result đã
  được PostgreSQL chấp nhận.
- Kết quả công bố kèm hardware/dataset/duration/error rate; nếu chưa đo chỉ được
  gọi là “cấu hình mục tiêu”, không gọi là “đã chịu tải 100.000 user”.
