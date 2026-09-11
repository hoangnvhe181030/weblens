# Bản schema review cho V1 và V1.5

Trạng thái: tạm dừng và được thay thế về mặt kiến trúc bởi TASK-006/ADR-005. Bản
schema sinh ra từ task này không được triển khai; cần task schema mới theo từng
data owner sau khi cross-service contract được duyệt.

## Mục tiêu

Đề xuất schema PostgreSQL production-ready cho toàn bộ phạm vi V1/V1.5 sau khi
đã áp dụng cổng thiết kế GREEN/YELLOW/RED và hồ sơ workload được phê duyệt.

## Phạm vi

- Ghi lại schema GREEN hiện hữu của `users` và `auth_sessions`.
- Đề xuất schema RED cho `websites`, `scans`, `scan_pages`, `page_metrics`,
  `findings`, `capture_jobs`, `page_snapshots`, `captured_resources` và
  `network_requests`.
- Đánh giá `page_links` theo đúng requirement; không tạo bảng chỉ vì tên đã có
  trong danh sách RED.
- Đề xuất bảng phụ `capture_objects` để quản lý metadata và dedup object storage;
  bảng này cần được người dùng phê duyệt rõ ràng trước khi triển khai.
- Không đưa bảng YELLOW hoặc bảng từ V2 trở đi vào V1/V1.5.

## Ranh giới thay đổi

- Chỉ tạo tài liệu review bằng tiếng Việt.
- Không sửa migration đã áp dụng.
- Không tạo Flyway migration, JPA entity, repository hoặc runtime code.
- Mọi thay đổi vật lý sau khi review phải dùng forward-only expand/contract.

## Rủi ro cần giải quyết

- Hot row và lost update khi nhiều worker hoàn tất page đồng thời.
- Duplicate, out-of-order và late result trong mô hình at-least-once.
- Lease expiry, stale worker và cancellation race.
- Cardinality lớn của page, finding và network metadata.
- URL dài làm hỏng hoặc làm phình B-tree index.
- Object upload và database commit không thể nằm trong một distributed transaction.
- Retention xóa khối lượng lớn gây WAL, bloat hoặc ảnh hưởng control plane.

## Definition of Done

- Có ma trận bảng theo use case và version.
- Mỗi nhóm RED có bước 1–7, alternatives, constraints, index và transaction.
- Có DDL logic để review, nhưng không phải migration thực thi.
- Có benchmark query và tiêu chí đúng đắn/concurrency.
- Các giả định chưa được người dùng phê duyệt được đánh dấu rõ.
- Tài liệu qua kiểm tra UTF-8 tiếng Việt.

## Điều cần hiểu trước khi chấp nhận thiết kế

Schema chỉ đặt ra invariant và đường truy cập dữ liệu. Capacity thực tế còn phụ
thuộc query plan, transaction, pool, autovacuum, disk/WAL và backpressure. Việc
phê duyệt schema không đồng nghĩa với tuyên bố hệ thống chịu tải vô hạn.
