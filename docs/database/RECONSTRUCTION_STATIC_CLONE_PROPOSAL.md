# Đề xuất database cho bản clone tĩnh từ browser capture

Trạng thái: **ĐƯỢC PHÊ DUYỆT** ngày 2026-09-13 — revision 1

Tài liệu này là hồ sơ thiết kế đã được duyệt cho `reconstruction_jobs` và
`reconstruction_artifacts` trong lát cắt Pagesource. Nó cho phép migration và
runtime writer đúng phạm vi ADR-007; không cấp quyền mở rộng sang bảng RED.

## 1. Business requirements

- Sau một browser capture mới, người dùng có thể tải một archive chứa rendered
  HTML và các CSS, JavaScript, image, font đã capture thành công.
- Cây file giữ ý nghĩa đường dẫn URL theo hành vi Pagesource nhưng phải ổn định,
  an toàn trên Windows/Linux và không làm lộ query value.
- Archive có `manifest.json` mô tả version, nguồn, file, SHA-256, byte, resource
  bị thiếu/truncate và lý do để không báo clone hoàn chỉnh giả.
- Một capture chỉ công bố tối đa một generation clone chiến thắng.
- Capture evidence có thể hoàn tất dù clone `PARTIAL` hoặc `FAILED`.
- Chỉ owner của capture được xem trạng thái và tải artifact.
- Artifact lớn nằm ở MinIO/S3; PostgreSQL không giữ HTML, JavaScript hoặc ZIP.

Không thuộc phạm vi đầu tiên:

- clone toàn bộ scan/website nhiều trang;
- khôi phục React/Next.js source, source map không public hoặc backend;
- capture authenticated session, cookie, XHR/fetch response body;
- chạy clone trực tiếp trên origin của WebLens.

## 2. Expected workload đã duyệt

| Đại lượng | Giả định proposal |
| --- | ---: |
| Reconstruction/capture mới | tối đa 1 |
| Capture burst ban đầu | 2 capture/giây |
| Capture Worker concurrency | 2 mặc định, tối đa 10/process |
| File đủ điều kiện/clone | tối đa 100 |
| Tổng input resource + HTML | tối đa 50 MiB |
| Archive output | tối đa 64 MiB |
| Manifest | tối đa 1 MiB |
| Retention archive | 7 ngày |
| Lần thử tạo archive | tối đa 3, có fencing |
| Download đồng thời | chưa benchmark; phải đo trước production |

Giới hạn 100 file/50 MiB bám theo capture policy hiện tại. Việc nâng giới hạn
chạm workload của `capture_jobs`, `page_snapshots` và `captured_resources` thuộc
RED, nên không được suy ra chỉ từ nhu cầu clone.

## 3. Query patterns

Đường đọc tương tác:

1. Lấy reconstruction summary theo `(owner_id, capture_job_id)` khi mở snapshot.
2. Lấy job theo `(owner_id, id)` để polling trạng thái.
3. Lấy artifact `PUBLISHED` theo `(owner_id, reconstruction_job_id, kind)` để
   authorize download.
4. Liệt kê lịch sử theo owner bằng keyset `(created_at DESC, id DESC)` nếu UI cần.

Đường vận hành:

1. Tìm job `QUEUED/RUNNING` stale để reconcile.
2. Tìm artifact đến hạn xóa theo `delete_after`.
3. Đối chiếu object `STAGED` không được publish hoặc metadata `PUBLISHED` nhưng
   object mất.

Không có query theo nội dung HTML/JS, filename substring hoặc JSONB manifest trong
PostgreSQL. Manifest lớn được đọc từ object storage.

## 4. Write patterns

- Khi Capture Worker accept command lần đầu, tạo `capture_jobs` và một
  `reconstruction_jobs` trong cùng local transaction.
- Winning capture attempt thu resource, map logical path, tạo manifest và stream
  archive ra temporary file/object **ngoài transaction**.
- Sau khi upload, một transaction ngắn khóa/kiểm tra capture lease generation,
  ghi snapshot/result, artifact metadata và terminal state của reconstruction.
- Retry hoặc duplicate command không tạo job/artifact logic thứ hai.
- Stale worker không được publish generation mới sau khi mất capture lease.
- Object upload thành công nhưng database commit thất bại tạo orphan candidate;
  reconciler xóa sau grace period. Metadata commit nhưng object mất trả lỗi
  integrity, không trả archive rỗng.

## 5. Expected data volume

PostgreSQL chỉ tăng khoảng một job và tối đa hai artifact metadata cho mỗi capture
(`STATIC_ARCHIVE`, `MANIFEST`). Dung lượng lớn nằm ở MinIO. Với 2 capture/giây và
retention 7 ngày, trần lý thuyết là khoảng 1,2 triệu job/tuần; đây chỉ là phép tính
envelope, không phải traffic dự báo.

Không partition ngay vì bảng metadata chưa có bằng chứng đạt hàng chục triệu row
hoặc VACUUM/retention trở thành bottleneck. Nếu production tiến gần envelope,
phải benchmark trước khi chọn range partition theo `created_at`.

## 6. Consistency và concurrency requirements

- Dùng `READ COMMITTED` cùng row lock/conditional update; chưa có anomaly buộc
  phải dùng `SERIALIZABLE` cho workflow một capture.
- `capture_job_id` duy nhất bảo đảm một logical reconstruction trên mỗi capture.
- Composite FK `(reconstruction_job_id, owner_id)` ngăn artifact khác owner.
- Terminal state monotonic; `PUBLISHED/PARTIAL/FAILED/EXPIRED` không quay lại
  `RUNNING` cùng generation.
- Capture lease owner + generation là fencing authority. Transaction publish phải
  kiểm tra generation ở parent `capture_jobs` trước khi ghi kết quả.
- Artifact chỉ khả dụng khi state `PUBLISHED` và object vượt kiểm tra byte/hash.
- PostgreSQL và MinIO không có distributed transaction; correctness dựa trên
  staged upload, checksum, conditional publish và reconciliation.

## 7. Retention requirements

- Đề xuất archive và manifest giữ 7 ngày, đồng bộ với resource body hiện tại.
- Hết hạn chuyển artifact sang `DELETE_PENDING`; xóa object thành công mới đánh
  dấu `DELETED`/ẩn khỏi API.
- Metadata job tối thiểu có thể giữ 30 ngày để giải thích kết quả, nhưng không giữ
  storage key của object đã xóa lâu hơn nhu cầu vận hành.
- Xóa capture/owner phải phát deletion workflow tới Capture Worker; object clone
  không được tồn tại ngoài retention của owner/source.

## 8. Schema alternatives

### A. Thêm cột clone vào `page_snapshots`

Ít bảng nhưng trộn lifecycle snapshot RED với clone YELLOW, làm mọi capture mang
semantics clone và khó retry/xóa độc lập. Không đề xuất.

### B. Chỉ thêm `reconstruction_artifacts` liên kết trực tiếp capture

Đơn giản nhưng không biểu diễn queued/running/partial/failure, attempt hoặc
completeness. Không đủ cho recovery và UI trung thực.

### C. Hai bảng YELLOW riêng trong Capture PostgreSQL

Đề xuất chọn. `reconstruction_jobs` giữ lifecycle/summary;
`reconstruction_artifacts` giữ object reference. Không thêm service hoặc
ClickHouse table.

### D. Lưu mỗi cloned file thành một row PostgreSQL

Không đề xuất vì tăng write amplification, index bloat và duplicate metadata đã
có ở ClickHouse/object references. Chi tiết file nằm trong manifest object.

## 9. PK, FK và constraints đề xuất để review

### reconstruction_jobs

| Trường | Kiểu dự kiến | Ý nghĩa/ràng buộc |
| --- | --- | --- |
| `id` | `uuid` | PK do ứng dụng tạo |
| `owner_id` | `uuid` | opaque owner từ Control Plane |
| `capture_job_id` | `uuid` | FK cùng database, `UNIQUE` |
| `source_snapshot_id` | `uuid NULL` | FK snapshot chiến thắng, chỉ có sau capture |
| `kind` | `text` | chỉ `STATIC_PAGE_ARCHIVE` ở version đầu |
| `engine_name` | `text` | `pagesource-adapter` |
| `engine_version` | `text` | version WebLens + upstream commit |
| `status` | `text` | `QUEUED/RUNNING/PUBLISHED/PARTIAL/FAILED/EXPIRED` |
| `include_external` | `boolean` | mặc định `false` |
| `max_files` | `integer` | `1..100` theo policy đã duyệt |
| `max_input_bytes` | `bigint` | `1..52428800` |
| `max_archive_bytes` | `bigint` | `1..67108864` |
| `discovered_count` | `integer` | không âm |
| `packaged_count` | `integer` | `0..discovered_count`, không vượt `max_files` |
| `skipped_count` | `integer` | không âm |
| `input_bytes` | `bigint` | không âm, không vượt budget |
| `archive_bytes` | `bigint` | null trước publish, không vượt budget |
| `completeness_code` | `text NULL` | mã bounded; không lưu raw website text |
| `failure_code` | `text NULL` | mã phân loại bounded |
| `source_lease_generation` | `bigint NULL` | generation đã publish |
| `created_at/started_at/finished_at/updated_at` | `timestamptz` | thứ tự thời gian hợp lệ |
| `version` | `bigint` | optimistic version, không âm |

Job cần `UNIQUE (id, owner_id)` để artifact dùng composite FK cùng owner. Các
constraint terminal phải yêu cầu `finished_at` cho terminal state; `PUBLISHED`
và `PARTIAL` cần `archive_bytes > 0` và `source_snapshot_id` khác null.

### reconstruction_artifacts

| Trường | Kiểu dự kiến | Ý nghĩa/ràng buộc |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `owner_id` | `uuid` | thuộc cùng owner với job |
| `reconstruction_job_id` | `uuid` | composite FK với owner, `ON DELETE RESTRICT` |
| `kind` | `text` | `STATIC_ARCHIVE` hoặc `MANIFEST` |
| `generation` | `integer` | bắt đầu từ 1, không âm |
| `logical_filename` | `text` | server sinh, bounded; không nhận từ website |
| `storage_bucket/storage_key` | `text` | private object reference, key unique |
| `content_type` | `text` | allowlist `application/zip`/`application/json` |
| `byte_size` | `bigint` | `1..67108864` |
| `sha256` | `bytea` | đúng 32 byte |
| `state` | `text` | `STAGED/PUBLISHED/DELETE_PENDING/DELETED` |
| `created_at/published_at/delete_after/deleted_at` | `timestamptz` | lifecycle/retention hợp lệ |

Tính duy nhất dự kiến: `(reconstruction_job_id, kind, generation)`. Không lưu
presigned URL, query secret, HTML, JS hoặc manifest JSON trong bảng này.

## 10. Indexing strategy đề xuất

```sql
-- Minh họa cho review, KHÔNG phải migration được phép chạy.
UNIQUE (capture_job_id)
INDEX (owner_id, created_at DESC, id DESC)
INDEX (status, updated_at, id)
  WHERE status IN ('QUEUED', 'RUNNING')

UNIQUE (reconstruction_job_id, kind, generation)
INDEX (owner_id, reconstruction_job_id, kind)
  WHERE state = 'PUBLISHED'
INDEX (delete_after, id)
  WHERE state IN ('PUBLISHED', 'DELETE_PENDING')
```

Equality column đứng trước sort/range column. Chỉ tạo partial index cho hàng cần
claim/GC để giảm write amplification. Không tạo GIN cho JSONB vì proposal không
truy vấn nội dung manifest trong PostgreSQL.

## 11. Transaction strategy

1. Accept capture: dedup inbox, insert capture job và reconstruction job; commit.
2. Claim capture bằng `FOR UPDATE SKIP LOCKED`; tăng lease generation; commit.
3. Render, thu response, map path, tạo file tạm, upload object; không giữ DB tx.
4. Publish: lock capture/job theo thứ tự cố định, xác minh lease generation, insert
   artifact `STAGED`, xác minh metadata, chuyển artifact/job terminal và stage
   event/result; commit.
5. Xóa file tạm. Nếu bước 4 thất bại, đăng ký/để reconciler phát hiện orphan.
6. Download: owner-scoped lookup, đọc object ngoài transaction, kiểm tra size/hash,
   trả `attachment`, `no-store`, `nosniff`.

Không retry riêng statement sau serialization/deadlock; nếu sau này nâng isolation,
phải retry toàn bộ local transaction với bounded backoff/jitter.

## 12. Benchmark queries và scenarios

```sql
-- Status theo owner/capture.
SELECT id, status, packaged_count, skipped_count, archive_bytes, finished_at
FROM reconstruction_jobs
WHERE owner_id = $1 AND capture_job_id = $2;

-- Artifact download owner-scoped.
SELECT storage_bucket, storage_key, byte_size, sha256, delete_after
FROM reconstruction_artifacts
WHERE owner_id = $1
  AND reconstruction_job_id = $2
  AND kind = 'STATIC_ARCHIVE'
  AND state = 'PUBLISHED';

-- GC batch.
SELECT id, storage_bucket, storage_key
FROM reconstruction_artifacts
WHERE state IN ('PUBLISHED', 'DELETE_PENDING')
  AND delete_after <= now()
ORDER BY delete_after, id
FOR UPDATE SKIP LOCKED
LIMIT $1;
```

Benchmark cần đo:

- burst 2 capture/giây ở concurrency 2 và 10;
- package 100 file/50 MiB với collision/query/Unicode;
- MinIO chậm, hết disk, timeout sau upload và retry stale worker;
- 100/1.000 download đồng thời để quyết định proxy streaming hay presigned URL;
- p50/p95/p99 thời gian capture, package, publish và download;
- RSS/disk tạm, object throughput, PostgreSQL lock/pool wait và orphan count.

## 13. Quyết định đã được người dùng phê duyệt

- Clone đầu tiên là **một trang**, không phải toàn bộ website.
- Giữ mặc định same-origin và không thu XHR/fetch body.
- Chỉ cho tải xuống; chưa chạy live preview.
- Budget là 100 file, input 50 MiB và archive 64 MiB.
- Retention archive là 7 ngày.
- Capture thành công độc lập với clone thất bại.
- Hai bảng thuộc Capture Worker PostgreSQL; không thêm service hay ClickHouse table.

Quyết định review: **Accepted**, ngày 2026-09-13. ADR-007 và TASK-013 được phép
triển khai đúng revision này.

## 14. Review an toàn migration

- Môi trường đã kiểm tra: PostgreSQL 17.6; migration runner của Capture Worker chạy
  từng file trong transaction và khóa advisory toàn cục cho schema của service.
- Migration `002_create_static_reconstruction.sql` chỉ tạo hai bảng/index mới,
  không sửa hoặc backfill `capture_jobs`/`page_snapshots`, nên không rewrite bảng
  lịch sử. Capture cũ cố ý không có reconstruction.
- Migration forward `003_index_staged_reconstruction_gc.sql` chỉ thêm partial
  B-tree `(delete_after, id) WHERE state = 'STAGED'` để reconciler không phải
  sequential scan artifact mồ côi. Migration 002 đã áp dụng không bị sửa checksum.
- Rủi ro khóa chỉ nằm ở catalog và FK metadata trong lúc DDL; deployment phải đặt
  `lock_timeout`/maintenance window phù hợp khi production có DDL đồng thời.
  Index 003 dùng build thông thường trong transaction của runner nên giữ
  `SHARE` lock và chặn writer trong thời gian build; chỉ phát hành khi bảng còn
  nhỏ hoặc trong maintenance window. Nếu bảng đã lớn, phải thay bằng quy trình
  `CREATE INDEX CONCURRENTLY` ngoài transaction có kiểm tra invalid index riêng.
- Compatibility là expand-only: worker cũ bỏ qua bảng mới; worker mới tạo job mới
  sau khi migration hoàn tất. Không có bước drop/rename trong release này.
- Xác minh: migration ledger có file 002, constraints tồn tại, duplicate command
  và 003; duplicate command chỉ tạo một job, stale lease không stage/publish,
  composite FK chặn artifact sai owner, artifact đi qua `STAGED → PUBLISHED`, và
  GC chuyển artifact hết hạn sang `DELETED` cùng job `EXPIRED`.
- Khôi phục là roll-forward. Không xóa migration đã áp dụng; nếu deploy runtime
  thất bại, giữ bảng trống/không được dùng và sửa bằng migration version tiếp theo.
