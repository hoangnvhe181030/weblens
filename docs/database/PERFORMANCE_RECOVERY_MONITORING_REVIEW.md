# Review phép kiểm recovery Crawler — revision 1

Ngày revision gốc: 2026-09-30. Trạng thái hiện tại (2026-10-09): **phạm vi và
runbook revision 1 đã duyệt có điều kiện; production vẫn BLOCK do preflight**.
Phạm vi: hai đường lookup phục vụ kiểm tra recovery của bài tối ưu performance.
Revision gốc không có migration, entity mới, DDL thực thi hoặc thay đổi dữ liệu.
Update ngày 2026-10-09 thử synthetic và restore/index rehearsal local; backup
production mới đã có bản off-host và PG restore proof. Không có DDL production
hoặc thay đổi runtime/migration. Xem [báo cáo subphase](../testing/RECOVERY_PRODUCTION_SUBPHASE_2026-10-09.md).

## Phê duyệt phạm vi ngày 2026-10-09

Người dùng trả lời “đồng ý” cho yêu cầu review riêng hai index logic ở revision 1,
để tiếp tục thiết kế và kiểm thử cách ly. Đây không phải phê duyệt schema cuối,
runbook thực thi hoặc DDL production. Tài liệu gốc bên dưới được giữ làm lịch sử;
không sửa applied migration, retention, quyền sở hữu hoặc transaction runner.

Đầu vào volume mới lấy chỉ đọc ngày 2026-10-09 01:25:50 +07:00:
outbox estimate 3.499.939 row / total relation size 4.302.225.408 byte;
page tháng 9 estimate 516.071 / total 457.097.216 byte, tháng 10 estimate
780.640 / total 695.148.544 byte. Có 8 partition kể cả default; hai lookup
EXISTS vẫn chọn Seq Scan. Estimate không thay actual count, total size không là
heap-only và không chứng minh PERSISTING/DEAD đang tồn tại.

Benchmark candidate ở `tools/load/recovery-index-probe.mjs` chỉ được tạo database
test riêng trên Docker local. SQL index của probe là thử nghiệm cho scope đã duyệt,
không nằm trong crawler migration runtime. [Runbook revision 1](RECOVERY_INDEX_RUNBOOK.md)
đã được duyệt có điều kiện theo SHA/revision ghi trong runbook; chưa đủ gate DDL.
Profile representative dùng cardinality
trên làm fixture synthetic, không clone dữ liệu production hoặc cam kết capacity.
Kết quả [benchmark 2026-10-09](../testing/RECOVERY_INDEX_BENCHMARK_2026-10-09.md):
candidate lookup/functional/negative checks đạt, baseline DEAD timeout 2 s.
Page p95 70,655→0,392 ms; DEAD candidate p95 0,063 ms. Chi phí ghi chưa được
chứng minh không regression. Scope approval không tự chuyển thành quyền DDL.

## Quyền hạn và mục tiêu

`DESIGN_GATES.md` giữ `scan_pages` và Crawler event outbox ở mức RED. Quyền thực
hiện các phase performance không tự phê duyệt index mới. Revision này trình bày
workload đã biết, các phương án và điều kiện kiểm thử; cần review riêng trước
khi viết migration hoặc triển khai trên production.

Mục tiêu là xác định chính xác có còn trang PERSISTING ở bất kỳ execution nào và
event DEAD ở Crawler hay không, để kiểm recovery trước/sau benchmark. Đây là
phép kiểm vận hành; chưa phải tối ưu đường tạo scan hoặc bằng chứng tăng capacity.

## 1–7. Workload và các yêu cầu giữ nguyên

| Bước | Đầu vào đã có |
| --- | --- |
| 1. Nghiệp vụ | Không công bố recovery sạch khi hai scope chưa được đo. Timeout/null giữ UNVERIFIED. Phải bao quát lịch sử đang giữ, không chỉ scan thuộc run hoặc execution active. |
| 2. Khối lượng | Lượt đã được yêu cầu là 150 scan × 1.000 trang và 150 tài khoản thao tác API. Cấu hình hiện tại 20 crawler worker, host 2. Đây là workload test, không phải capacity được bảo đảm hoặc dự báo tải production thật. |
| 3. Đọc | Hai truy vấn trả boolean tồn tại; false tương đương không còn row trong scope. Hai mẫu recovery cách 15 giây tại gate trước/sau lượt chạy. Giữ timeout đọc 2 giây/lock 500 ms, read-only. Không đưa count lịch sử vào collector chạy mỗi 5 giây. |
| 4. Ghi | Page đi LEASED → PERSISTING khi result/outbox/counter được ghi trong cùng transaction; analytics ACK chuyển terminal và giảm counter. Event insert PENDING, claim CLAIMED, ACK DELIVERED hoặc retry thành DEAD. Giữ nguyên toàn bộ write path, lease/fencing và atomicity. |
| 5. Dữ liệu | Snapshot catalog 21:15:27: page tháng 9 estimate 529.758 live tuples, heap 194.101.248 byte/index 262.914.048 byte. Event outbox estimate 1.437.930 live tuples, heap 1.421.230.080 byte/index 339.795.968 byte. Một lượt đủ workload có thể thêm đến 150.000 page; số event mới phụ thuộc runtime, chưa giả định tỷ lệ cố định. |
| 6. Nhất quán | Đọc committed state, không sửa trạng thái để làm gate đạt. Chỉ chấp nhận proof khi tất cả nguồn/health/resources/routes cùng đạt; hai mẫu không bảo đảm máy sẽ không nhận công việc mới sau mẫu cuối. Giữ nguyên owner/FK/check constraints, command version và counter invariants. |
| 7. Lưu giữ | Không đổi retention, purge, archive hoặc cơ chế xóa. Tài liệu D7 mô tả delivered/inbox 7 ngày, metadata poison/dead 30 ngày; code hiện chưa được xác nhận có job purge tương ứng. Kiểm scope mọi partition đang tồn tại, kể cả default; không loại lịch sử chỉ vì quá tuổi đề xuất trong tài liệu. |

Các tốc độ ghi thực tại đỉnh, số row DEAD/PERSISTING thực và kích thước index
mới chưa đo được. Chưa dùng mục tiêu workload V1/V1.5 trong tài liệu để tuyên bố
VPS hiện tại đáp ứng. Các giá trị estimate/MVCC dead tuple không thay actual count
hoặc số event DEAD.

## Bằng chứng và phần chưa giải thích

- Count toàn cục PERSISTING và event DEAD chọn Seq Scan lịch sử; đã dừng dùng.
- Audit page theo execution/status index cũng timeout; lượt chia 32 execution
  có SQLSTATE 57014. Không có offset/proof thành công, không lặp lại để thử may mắn.
- Plan gate cũ bỏ qua wrapper EXPLAIN `value/Count`; đã sửa và kiểm thử offline.
- Snapshot 21:15:27 xác nhận các page execution/status indexes valid/ready.
  Có ba session khác trong DB Crawler, không transaction đang mở được quan sát,
  idle-in-transaction/lock wait/IO wait đều 0. Chỉ là mẫu hiện tại, không giải thích
  timeout trước đó hoặc chứng minh không có contention dưới burst.
- `scan_pages` parent có estimate 0 vì dữ liệu thuộc partition; không dùng số
  parent để kết luận bảng rỗng. Các partition tương lai có estimate 0 không phải
  bằng chứng actual count bằng 0.
- Code tăng/giảm persisting_count trong transaction; counter active bằng 0 vẫn
  chưa đối chiếu page ngoài active execution. FK validated gồm execution/owner/
  retention month bảo đảm tham chiếu, không bảo đảm trạng thái/counter không lệch.

Artifacts: `tmp/load/phase3-recovery-catalog-20260930T2112.json`,
`tmp/load/phase3-indexed-recovery-plans.json`,
`tmp/load/phase3-admission-measurement-readiness.json`.

## 8–11. Phương án để review

| Phương án | Lợi ích | Giới hạn và chi phí |
| --- | --- | --- |
| Giữ index hiện tại, dùng counter/estimate | Không thêm chi phí ghi | Không chứng minh hai scope toàn cục; giữ gate UNVERIFIED, chưa mở tải mới. |
| Audit toàn bộ execution qua index hiện tại | Không đổi schema | Đã timeout; không chọn làm kiểm tra định kỳ và không nới timeout. |
| **Hai index giám sát chọn lọc (đề xuất)** | Lookup trực tiếp tập trạng thái cần kiểm, bao quát execution terminal và event DEAD | Phải build/validate, thêm index/WAL/write work và đo chi phí thực; không hứa latency khi chưa benchmark. |

Phạm vi đề xuất là **hai index logic**, không phải hai file index vật lý:

1. Event outbox: B-tree trên `message_id`, predicate chính xác `status='DEAD'`.
   Không include payload hoặc thêm constraint/uniqueness.
2. Scan pages: B-tree trên `id`, predicate chính xác `status='PERSISTING'`.
   Parent/leaf indexes phải bao quát tất cả partition hiện có và partition mới;
   không bỏ default hoặc chỉ làm partition của run.

PK/FK/check constraints và mọi index phục vụ claim/lease hiện tại được giữ nguyên.
Hai lookup chỉ cần EXISTS, không count hoặc đọc payload. Page chuyển vào/ra
PERSISTING tạo/loại entry; event chuyển DEAD tạo entry. Dù tập predicate nhỏ,
build vẫn phải đọc dữ liệu hiện hữu; không cam kết kích thước, thời gian build,
I/O hoặc overhead bằng 0. Không dùng cache/counter mới thay bằng chứng DB.

Đây là lựa chọn để review, chưa phải schema cuối cùng hoặc lệnh được phép chạy.

## 12. Validation và triển khai chỉ sau phê duyệt

1. Chốt kế hoạch thay đổi DB có version/checksum và rollback. Giữ applied
   migrations; không sửa lịch sử hoặc tự ghi schema history để vượt runner.
2. Chuẩn bị phép thử trên DB tách biệt: có/không PERSISTING ở execution terminal,
   có/không DEAD, nhiều tháng/default, transition/ACK/rollback và insert partition
   mới. Xác nhận hai lookup không bỏ sót row, timeout không trở thành false.
3. EXPLAIN trước thực thi phải dùng đường chọn lọc trên toàn bộ partition có dữ
   liệu. Benchmark đọc có giới hạn, kiểm write overhead/WAL và kích thước index;
   không chỉ đo DB rỗng hoặc một lần cache nóng.
4. Trước production cần backup mới cùng SHA/TOC/provenance, disk headroom,
   memory/CPU/health ổn định, không workload test đang chạy, không build index
   khác. Chính sách dừng/cleanup khi vượt guard hoặc còn index invalid phải được
   review; thiếu global proof hiện tại không tự cấp quyền triển khai.
5. PostgreSQL 17 không cho CONCURRENTLY trong transaction hoặc trực tiếp trên
   partitioned parent. Có thể build leaf rồi ghép parent; vẫn có chi phí đọc,
   chờ transaction và xử lý index invalid. [Tài liệu PostgreSQL 17](https://www.postgresql.org/docs/17/sql-createindex.html).
6. Crawler migration runner hiện bọc mỗi migration trong transaction. Không
   đặt concurrent build vào runner đó hoặc đổi mọi migration sang autocommit.
   Cách chạy/version hóa bước bảo trì ngoài transaction cần review riêng trong
   runbook thực thi; chưa có script thực thi ở revision này.
7. Chỉ sau index valid/ready, plan và lookup thực đạt, giữ schema/partition
   coverage đầy đủ, mới cập nhật verifier bỏ đúng hai unverifiedChecks. Hai
   proof toàn cục cách 15 giây cùng health/resources/routes/run reconciliation
   mới cho phép chuyển sang validation admission, không tự khởi chạy 150 scan.

## 13. Quyết định cần review

Đề nghị duyệt phạm vi hai index logic chọn lọc ở trên để tiếp tục thiết kế
runbook/migration và kiểm thử; chưa duyệt schema cuối hoặc lịch triển khai.
Không thay table shape, dữ liệu, quyền DB, quota, worker hoặc retention.

Sau review phạm vi, cung cấp bản thực thi cụ thể, ngân sách tài nguyên và rollback
để chốt việc triển khai. Nếu không duyệt, giữ máy bật và gate UNVERIFIED; tiếp tục
chuẩn bị diagnostic admission ở local, không lặp tải hoặc tự bỏ scope recovery.
