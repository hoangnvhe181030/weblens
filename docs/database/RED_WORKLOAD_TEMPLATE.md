# Mẫu thu thập workload cho bảng RED

Trạng thái: đang chờ yêu cầu từ người dùng. Đây là biểu mẫu thu thập thông tin,
không phải đề xuất schema. Hãy hoàn thành biểu mẫu cho một bảng RED cụ thể hoặc
một nhóm bảng liên quan đã được thống nhất rõ ràng.

## 1. Yêu cầu nghiệp vụ

- Bảng/khái niệm đang được thảo luận:
- Thao tác của người dùng và kết quả họ quan sát được:
- Điều tuyệt đối không được xảy ra (business invariant):
- Mã yêu cầu V1/V1.5 hoặc phạm vi phiên bản sau đã được phê duyệt:
- Kỳ vọng về thành công một phần, lỗi, hủy và lịch sử:

## 2. Khối lượng công việc dự kiến

- Ước lượng hiện tại, thời điểm ra mắt và giai đoạn tăng trưởng; độ tin cậy của từng ước lượng:
- Số user/website/scan hoạt động và số tác vụ đồng thời ở mức đỉnh:
- Số thao tác trung bình và đỉnh mỗi giây; thời lượng của đợt tăng đột biến:
- Hạn mức tài nguyên theo website, user và toàn hệ thống:
- Tỷ lệ workload crawl so với browser capture, nếu có:

## 3. Mẫu truy vấn

Với mỗi truy vấn quan trọng, cung cấp mục đích nghiệp vụ, bộ lọc, thứ tự sắp xếp,
phân trang, trường trả về, kích thước kết quả dự kiến, tần suất và mục tiêu độ trễ.
Bao gồm phạm vi phân quyền, truy vấn lịch sử/so sánh, polling tiến độ và truy vấn
quản trị/dọn dẹp khi cần. Mô tả bằng lời; SQL vật lý sẽ được thiết kế sau.

## 4. Mẫu ghi dữ liệu

- Nguồn tạo dữ liệu và đơn vị công việc; tần suất insert/update/delete:
- Một writer hay nhiều worker đồng thời ghi cùng một bản ghi logic:
- Kích thước batch/tần suất flush, nguồn retry, kết quả trùng hoặc sai thứ tự:
- Cập nhật tiến độ, cách xác định hoàn tất và race condition khi hủy:
- Điểm có thể lỗi giữa database, mạng, trình duyệt và object storage:

## 5. Khối lượng dữ liệu dự kiến

- Số bản ghi trên mỗi scan/page/capture và số scan mỗi ngày:
- Kích thước trung bình/p95/tối đa của bản ghi và payload:
- Số lượng và số byte asset mỗi capture; giả định về khả năng dùng lại nội dung:
- Mức tăng trưởng trong thời gian lưu giữ; độ lệch giữa tenant và website lớn nhất:
- Metadata, binary object, index, WAL, replica và backup phải được tính thành các
  nhóm dung lượng riêng; chỉ tính sau khi có đủ dữ liệu đầu vào:

## 6. Tính nhất quán và đồng thời

- Thao tác đọc nào phải thấy ngay thao tác ghi nào:
- Độ trễ tiến độ được chấp nhận và mức xử lý trùng được dung thứ:
- Dữ liệu nào phải commit nguyên tử; dữ liệu nào có thể hội tụ bất đồng bộ:
- Ngữ nghĩa retry/idempotency và mục tiêu thời gian phục hồi:
- Hành vi khi worker chết, quyền sở hữu hết hạn, kết quả đến muộn hoặc bị hủy:
- Cách ly giữa các owner, tính công bằng và khả năng xuất hiện hot record:

## 7. Lưu giữ dữ liệu

- Thời gian lưu metadata so với bằng chứng/asset thô; SLA xóa dữ liệu:
- Yêu cầu archive, xóa user, legal hold và export:
- So sánh lịch sử nào phải có khả năng tái tạo:
- Hành vi khi xóa asset dùng chung hoặc object bị thiếu:
- RPO/RTO chấp nhận được và thời gian lưu backup:

## Cổng phê duyệt trước khi thiết kế

Ghi lại câu trả lời đã cung cấp, câu hỏi còn mở và giả định đã được chấp nhận rõ
ràng. Không điền các phần dưới đây cho đến khi có đủ bước 1–7.

8. So sánh các phương án schema dựa trên những yêu cầu trên.
9. Chọn PK/FK/ràng buộc, bao gồm toàn vẹn dữ liệu qua ranh giới quyền sở hữu.
10. Giải trình từng index dựa trên truy vấn và chi phí ghi/lưu trữ.
11. Xác định ranh giới transaction, lock/xung đột, retry và phục hồi.
12. Viết truy vấn/workload benchmark đại diện với phân bố dữ liệu, mức đồng thời,
    mục tiêu latency/throughput và các assertion về tính đúng đắn.
13. Trình bày schema cuối cùng cùng trade-off và bằng chứng/giới hạn benchmark.

Biểu mẫu này không đề xuất cột, khóa, index, partition, entity hay SQL benchmark
cuối cùng. Hiện chưa có workload định lượng nào được phê duyệt.
