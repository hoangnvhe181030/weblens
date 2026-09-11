# WebLens Frontend

Frontend demo bằng React 19, TypeScript strict, React Router và Vite. Giao diện tiếng Việt mô phỏng hành trình V1/V1.5 từ landing page tới đăng ký website, chạy scan và xem bằng chứng. Đây là bản mock phía client, chưa có xác thực, crawler hay API backend thật.

## Khởi chạy

```powershell
npm install
npm run dev
```

Vite sẽ in URL cục bộ, thường là `http://localhost:5173`.

## Kiểm tra

```powershell
npm run lint
npm test
npm run build
npm run preview
```

## Cấu trúc chính

- `src/pages/`: landing, auth và các màn hình dashboard.
- `src/components/`: shell, trạng thái giao diện và thành phần dùng chung.
- `src/domain/`: kiểu dữ liệu nghiệp vụ độc lập với UI.
- `src/services/`: mock service mô phỏng bất đồng bộ và lỗi.
- `src/data/`: dữ liệu minh họa, không phải dữ liệu production.

HTML được capture từ website tham chiếu chỉ nằm trong `.reference/` và không được đóng gói vào ứng dụng.
