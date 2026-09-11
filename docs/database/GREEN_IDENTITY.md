# Thiết kế định danh GREEN

Trạng thái: dùng lại phần nền tảng đã triển khai; V2 bổ sung hai ràng buộc cho
giá trị bắt buộc. Phạm vi gồm `users` và `auth_sessions`. Không cần tạo thêm
`user_sessions` hoặc `refresh_tokens` vì `auth_sessions` đã đáp ứng contract
xác thực hiện tại.

## Thiết kế vật lý

`users` dùng khóa chính UUID `id`; các trường bắt buộc gồm `email` và
`normalized_email` (varchar 254), `display_name` (varchar 80), `password_hash`
(varchar 200), `status` (varchar 16), `created_at`/`updated_at` (timestamptz)
và `version` để optimistic locking (bigint, mặc định 0). Trạng thái hợp lệ là
`ACTIVE` và `DISABLED`.

Ứng dụng chuẩn hóa email trước khi lưu hoặc truy vấn. Database yêu cầu
`normalized_email` đã được chuyển thành chữ thường, loại bỏ khoảng trắng hai
đầu và không trùng lặp. V2 bổ sung việc cấm normalized email và password hash
rỗng. Các check hiện có từ chối email/display name trống và không cho
`updated_at` đứng trước `created_at`. Không tạo thêm unique index dư thừa trên
email hiển thị.

`auth_sessions` dùng khóa chính UUID `id`, đồng thời là session ID trong JWT.
Các trường bắt buộc gồm UUID `user_id`, `refresh_jti_hash` và `csrf_token_hash`
(varchar 64), `expires_at`, `created_at` (timestamptz) và `version` (bigint,
mặc định 0). `revoked_at` và `rotated_at` là timestamptz có thể null.

FK đến user sử dụng `ON DELETE RESTRICT`. Hash định danh refresh phải là duy nhất;
cả hai hash phải có đúng 64 ký tự hexadecimal viết thường. Thời điểm hết hạn phải
sau thời điểm tạo; thời điểm revoke/rotate không được đứng trước thời điểm tạo.

Giữ nguyên chiến lược sinh UUID và độ dài trường hiện tại để bảo toàn tương thích.
Task này không cần đổi sang UUIDv7 hoặc tách session thành bảng lịch sử token.
Không thêm dependency hoặc ánh xạ JPA mới.

## Quy ước truy vấn và giao dịch

| Thao tác | Đường truy cập và hành vi hiện có |
| --- | --- |
| Đăng ký/đăng nhập | Tra cứu theo normalized email duy nhất; database constraint là lớp bảo vệ cuối cùng khi đăng ký trùng. |
| Refresh/đăng xuất | Tra cứu session theo khóa chính bằng `SELECT FOR UPDATE` qua repository; thay đổi được commit trong transaction của service. |
| Kiểm tra user | Tra cứu theo khóa chính user và kiểm tra trạng thái `ACTIVE`. |
| Tra cứu session đang hoạt động | Partial index `(user_id, expires_at)` với điều kiện `revoked_at IS NULL`; index vẫn chứa session hết hạn nhưng chưa revoke nên phía đọc phải lọc thêm thời hạn. |
| Dọn session hết hạn trong tương lai | Dùng index `expires_at` hiện có; chưa triển khai job dọn dẹp tự động. |

Đăng ký tạo user và session trong cùng transaction. Refresh lock một session,
kiểm tra thời hạn, trạng thái revoke, owner, trạng thái user, hash refresh JTI và
hash CSRF, sau đó thay cả hai hash và thời hạn trong cùng transaction. Khi hai
yêu cầu đồng thời dùng lại một credential cũ, chỉ một yêu cầu được rotate; yêu cầu
còn lại bị từ chối. Logout ghi nhận revoke theo cách idempotent. Session ID không
thay đổi qua các lần rotate.

JPA `@Version` phát hiện stale update; row lock tuần tự hóa toàn bộ chuỗi
đọc/kiểm tra/ghi khi refresh. Đây là lựa chọn riêng cho định danh, không phải thiết
kế cho tính đồng thời giữa worker/scan thuộc nhóm RED.

## Ranh giới bảo mật và vòng đời

- Password dùng `DelegatingPasswordEncoder` hiện có với BCrypt cost 12; password
  UTF-8 bị giới hạn theo đầu vào 72 byte của BCrypt. Database check có thể từ chối
  dữ liệu rỗng nhưng không thể chứng minh một chuỗi bất kỳ là password hash hợp lệ
  về mật mã. Việc encode thuộc trách nhiệm ứng dụng.
- Database lưu SHA-256 hash của refresh JTI và CSRF ngẫu nhiên, không lưu JWT thô
  hoặc password plaintext. Chữ ký và claim của refresh JWT được kiểm tra trước.
- Contract trình duyệt hiện tại gồm access token bearer trong bộ nhớ, refresh
  cookie HttpOnly, bảo vệ CSRF cho refresh/logout dựa trên cookie, cookie Secure
  ngoài môi trường development và danh sách origin được cấu hình.
- Mặc định hiện tại: access token sống 15 phút, refresh token sống 7 ngày. Rotate
  gia hạn thời gian refresh; chưa có giới hạn tuyệt đối cho tuổi thọ session.
- Logout hiện tại thu hồi khả năng refresh. Việc xác minh access JWT không truy
  vấn trạng thái revoke của session, vì vậy access token đã phát có thể dùng đến
  khi hết hạn, với điều kiện user vẫn active. Không được tuyên bố schema này cung
  cấp khả năng thu hồi access token tức thời.
- Credential refresh cũ bị từ chối nhưng chưa có lịch sử token-family hoặc cơ chế
  revoke toàn family khi phát hiện replay. Yêu cầu thua trong cuộc đua đồng thời
  không revoke credential của yêu cầu thắng.
- Chưa có API xóa tài khoản. `RESTRICT` ngăn session bị cascade ngoài ý muốn;
  các phụ thuộc RED hiện có được giữ nguyên và không được thiết kế lại ở đây.
- Việc dọn session, tuổi thọ tuyệt đối, reset password/xác minh email, rate limit
  và key rotation vẫn là quyết định hoặc task của từng release. Một schema theo
  mẫu thông thường không tự làm toàn bộ hệ thống xác thực sẵn sàng production.

## Đánh giá migration: an toàn có điều kiện

`V2__harden_identity_required_values.sql` chỉ thay đổi `users`. V1 được giữ
nguyên từng byte, bao gồm `websites` và `scans` có từ trước. V2 thêm hai CHECK
constraint, không backfill dữ liệu, thêm index hoặc sửa credential. Các thao tác
ghi hiện tại của ứng dụng đã cung cấp đủ hai giá trị; mapping và API response
không thay đổi.

Mục tiêu là PostgreSQL 17.6 từ Compose/Testcontainers; Spring Boot 3.5.16 quản lý
Flyway. PostgreSQL thực thi migration này trong transaction. Trước khi deploy,
phải xác nhận cấu hình Flyway và phiên bản database thực tế.

Preflight mà không để lộ giá trị credential:

```sql
SELECT count(*) AS invalid_users
FROM users
WHERE btrim(normalized_email) = '' OR btrim(password_hash) = '';

SELECT pg_size_pretty(pg_total_relation_size('users')) AS users_total_size;
```

Chỉ tiếp tục khi `invalid_users` bằng 0 và kích thước/lưu lượng của bảng phù hợp
với deployment window. `ALTER TABLE` lấy lock mạnh và kiểm tra các hàng hiện có;
thay đổi metadata này không phải thao tác không lock. Migration đặt
`lock_timeout` cục bộ là 5 giây và `statement_timeout` là 60 giây. Phải dừng
nếu timeout hoặc có dữ liệu không hợp lệ. Transaction rollback giữ nguyên V1;
cần chẩn đoán rồi chạy lại migration đang chờ, không dùng Flyway repair hoặc sửa
lịch sử đã áp dụng.

Với bảng identity production lớn hoặc có lưu lượng cao, cần review quy trình chia
giai đoạn `NOT VALID` rồi `VALIDATE` trước khi deploy migration này. Hiện chưa
có số liệu về kích thước production, tốc độ ghi, khoảng thời gian bảo trì hoặc
backup/RPO.

Sau deploy, xác minh hai constraint đã được validate trong `pg_constraint`,
Flyway ghi nhận V2 thành công và luồng đăng ký/đăng nhập/refresh/logout vẫn hoạt
động. Mọi thay đổi sau này phải dùng forward migration mới; khôi phục backup
không thay thế một kế hoạch phục hồi đã được kiểm thử rõ ràng.

## Bằng chứng xác minh

`mvnw.cmd verify` hoàn tất thành công bằng Java 21. Cả 17 unit test đều pass,
không có failure hoặc error. Toàn bộ 14 test tích hợp PostgreSQL bị skip vì không
có môi trường Docker; số này gồm chín test method persistence định danh mới, hai
test method authentication persistence mới, cùng các test API và foundation
persistence hiện có. CI hoặc máy developer có Docker vẫn phải chạy các test này
với image PostgreSQL 17.6 đã pin.

Một smoke test migration có giới hạn đã chạy V1 rồi V2 trong cluster PostgreSQL
18.4 cục bộ và tách biệt. Test xác nhận hai constraint mới tồn tại, đã validate,
từ chối normalized email rỗng và password hash chỉ có khoảng trắng, từ chối V2
khi có user không hợp lệ từ trước và rollback migration lỗi một cách nguyên tử.
Cluster được dừng sau test. Kết quả này hỗ trợ xác minh ngữ nghĩa SQL nhưng không
thay thế Testcontainers PostgreSQL 17.6 hoặc test thời gian giữ lock với kích
thước production.

Các test tích hợp mới bao phủ trường bắt buộc, tính duy nhất/chuẩn hóa của email,
FK/hash/thời hạn session, tính duy nhất của refresh identifier, hạn chế khi xóa
user, khả năng lưu và đọc lại trạng thái rotate/revoke, refresh đồng thời và việc
từ chối refresh khi user bị disable. Test API hiện có bao phủ luồng xác thực trên
trình duyệt và rotation có ràng buộc CSRF.

## Những điều developer cần hiểu trước khi chấp nhận phần mã này

- Constraint bảo vệ mọi nguồn ghi; validation DTO bảo vệ biên API.
- Unique constraint, không phải tra cứu trước khi insert, mới giải quyết race khi
  đăng ký trùng.
- Hash password và hash token ngẫu nhiên có thuộc tính bảo mật khác nhau.
- Row lock bảo vệ toàn bộ transaction refresh; test đồng thời cần transaction đã
  commit riêng biệt để mô phỏng đúng hành vi.
- `timestamptz` lưu một thời điểm tuyệt đối; expiry và retention là hai quy tắc
  vòng đời khác nhau.
- Auth session hỗ trợ thu hồi refresh, không tự động thu hồi JWT tức thời.
- Lịch sử Flyway đã áp dụng là bất biến; phê duyệt thiết kế RED là quy trình riêng.
