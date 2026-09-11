# Tự triển khai PostgreSQL cho WebLens

Trạng thái: Accepted  
Ngày: 2026-09-10

## Bối cảnh

ADR-002 đã chọn PostgreSQL làm authoritative database. Hồ sơ workload V1/V1.5
đặt mục tiêu tải production và trước đây có nhắc đến Neon. Người dùng quyết định
không sử dụng Neon mà tự triển khai PostgreSQL.

Lựa chọn này không thay đổi domain model, nhưng chuyển toàn bộ trách nhiệm về
availability, capacity, upgrade, backup, restore, PITR, replication, failover,
security patch và monitoring sang đội vận hành WebLens.

## Các phương án đã xem xét

- Neon PostgreSQL được quản lý.
- PostgreSQL tự triển khai một primary duy nhất.
- PostgreSQL tự triển khai với primary, WAL archive và standby/replica khi RPO/RTO yêu cầu.

## Quyết định

- Dùng PostgreSQL 17.x tự triển khai làm database production.
- Trước mỗi production rollout, dùng minor release mới nhất đã được kiểm thử. Tại
  ngày ADR này, PostgreSQL 17.11 là minor release mới nhất; môi trường dự án đang
  pin 17.6 và cần một task nâng cấp riêng.
- Dùng PgBouncer transaction pooling cho traffic ứng dụng; HikariCP vẫn có giới
  hạn nhỏ trên mỗi process và có connection timeout.
- Thiết lập base backup, continuous WAL archiving và kiểm thử PITR/restore trước
  khi tuyên bố production-ready.
- Không mặc định chọn công cụ tự động failover hoặc read replica trong ADR này.
  Topology HA phải dựa trên RPO/RTO đã phê duyệt và có failure drill.
- Binary capture lớn tiếp tục nằm ở S3-compatible object storage, không nằm trong
  PostgreSQL data directory.

## Hệ quả

- Có toàn quyền cấu hình và không phụ thuộc dịch vụ Neon.
- Chi phí vận hành, trực on-call và rủi ro cấu hình sai tăng đáng kể.
- Tăng CPU/RAM không sửa được query xấu, hot row, bloat hoặc connection storm;
  capacity vẫn phải được benchmark trên cấu hình phần cứng đã ghi nhận.
- Backup trên cùng máy hoặc cùng disk không bảo vệ trước lỗi máy/disk.
- Standby bất đồng bộ có thể mất transaction mới nhất khi failover; synchronous
  replication giảm RPO nhưng tăng commit latency.
- Connection pool và worker concurrency phải được tính chung, không cấu hình độc
  lập theo từng instance.

## Khi nào xem xét lại

- Chi phí/on-call tự vận hành vượt lợi ích kiểm soát.
- RPO/RTO không đạt sau khi đã thử standby và restore.
- Throughput hoặc latency không đạt sau khi tối ưu schema, query, autovacuum,
  pooling và phần cứng.
- Chuyển sang managed PostgreSQL được chứng minh giảm rủi ro hoặc tổng chi phí sở hữu.
