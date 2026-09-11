# Cổng thiết kế cơ sở dữ liệu và định danh GREEN

Trạng thái: đã hoàn tất triển khai; test tích hợp đúng phiên bản mục tiêu đang chờ
một môi trường có thể chạy Docker.

## Phạm vi

Áp dụng chính sách thiết kế GREEN/YELLOW/RED của người dùng. Dùng lại `users` và
`auth_sessions`. Đề xuất đủ chín khái niệm YELLOW nhưng không triển khai. Giữ cả
mười ba khái niệm RED ở trạng thái chờ đầu vào workload cho từng bảng, bao gồm
`capture_jobs` được bổ sung theo phê duyệt ngày 2026-09-10.

V1 hiện có `websites` và `scans`. Phải giữ nguyên migration và entity của chúng;
task này không phê duyệt thiết kế RED cuối cùng hoặc thay đổi schema hai bảng đó.

## Kế hoạch

1. Kiểm tra yêu cầu, SQL V1, service/entity định danh và thiết lập kiểm thử.
2. Lưu chính sách phân mức thiết kế và liên kết từ AGENTS.md, DATA_MODEL.md.
3. Tài liệu hóa thiết kế vật lý GREEN và hành vi xác thực hiện có; thêm migration
   chỉ tác động `users` để từ chối normalized email và password hash rỗng.
4. Xác minh ràng buộc GREEN, việc rotate/revoke session và refresh đồng thời bằng
   test PostgreSQL. Không thay đổi API contract xác thực.
5. Tạo đề xuất YELLOW có thể phê duyệt và biểu mẫu thu thập workload cho RED.
6. Build/test, kiểm tra hash các file thay đổi và báo cáo giới hạn môi trường.

## Rủi ro và ranh giới

- V1 là bất biến; không sửa lại dù migration này chứa các bảng RED.
- Ràng buộc GREEN có thể thất bại nếu dữ liệu định danh hiện có không hợp lệ.
  Phải preflight bằng số lượng, dừng khi có lỗi và không âm thầm sửa credential.
- Thời gian scan/lock khi PostgreSQL kiểm tra DDL phụ thuộc kích thước bảng và lưu
  lượng; đây không phải cam kết triển khai production không lock.
- Không được nhầm row lock khi refresh và ngữ nghĩa retry/revoke với bảo đảm
  exactly-once hoặc thu hồi access token tức thời.
- Không tạo migration, entity, runtime module, scheduler hay hạ tầng cho YELLOW.
- Không thêm dependency, thay đổi frontend hoặc tạo schema RED cuối cùng.

## Xác minh

Dùng Java 21 và Maven Wrapper. PostgreSQL Testcontainers cần Docker; mọi test bị
bỏ qua phải được ghi rõ. Kiểm tra SQL bổ sung bằng PostgreSQL cục bộ có thể xác
minh hành vi migration nhưng không thay thế test tích hợp đúng phiên bản mục tiêu.

Kết quả được ghi trong docs/database/GREEN_IDENTITY.md.
