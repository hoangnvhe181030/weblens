# Thiết kế workload cho `scans` và `scan_pages`

Trạng thái: bước 1–7 đã được người dùng phê duyệt ngày 2026-09-10. Bản schema
đề xuất được phép chuẩn bị để review; chưa được phép tạo migration hoặc entity.

## Phạm vi

Hoàn tất quy trình thiết kế RED cho `scans` và `scan_pages` theo
docs/database/DESIGN_GATES.md. V1 hiện có `scans` trong migration nền tảng; giữ
nguyên V1 và entity hiện có cho đến khi thiết kế, migration chuyển tiếp và kế
hoạch tương thích được phê duyệt riêng.

## Kế hoạch

1. Ghi nhận business requirements và benchmark profile đã duyệt.
2. Chốt workload, query/write pattern, volume, consistency và retention còn thiếu.
3. Chỉ sau khi bước 1–7 hoàn tất mới so sánh schema alternatives.
4. Sau phê duyệt phương án mới thiết kế PK/FK/constraint, index và transaction.
5. Viết benchmark workload/query và tiêu chí đúng đắn trước schema cuối cùng.
6. Không tạo Flyway migration hoặc JPA entity trong task thu thập này.

## Rủi ro cần giải quyết

- Hot row `scans` khi nhiều worker cập nhật progress.
- Duplicate/out-of-order/late result do at-least-once execution.
- Worker crash, lease expiry và stale owner.
- Cancellation cạnh tranh với page completion hoặc scan terminalization.
- Query progress/report tranh tài nguyên với background writes.
- Cardinality, bloat, autovacuum và retention của `scan_pages`.
- SSRF, redirect, DNS rebinding, per-host rate limit và nội dung crawl không tin cậy.

## Sản phẩm bàn giao

- docs/database/WORKLOAD_PROFILE_V1_V1_5.md
- docs/database/SCANS_SCAN_PAGES_WORKLOAD.md
- docs/adr/ADR-004-self-hosted-postgresql.md
- docs/database/V1_V1_5_SCHEMA_PROPOSAL.md
- docs/database/V1_V1_5_BENCHMARK_QUERIES.md

Không có thay đổi runtime, migration hoặc entity.
