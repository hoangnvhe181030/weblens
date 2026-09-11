# WebLens

WebLens là nền tảng hỗ trợ kỹ sư đăng ký website, chạy lượt quét có giới hạn và xem bằng chứng kỹ thuật theo từng trang. Kiến trúc V1/V1.5 gồm frontend React/TypeScript, Java 21/Spring Boot Control Plane, Go Crawler Service dựa trên bản fork CrawlObserver, PostgreSQL tự triển khai cho workflow, ClickHouse tự triển khai cho analytics và Playwright Capture Worker cô lập.

## Status

Control Plane V1 đã có JWT access/refresh rotation, Website CRUD, Scan lifecycle,
durable command outbox và event inbox. Go Crawler Service nhận command idempotent,
duy trì frontier/lease trong PostgreSQL, crawl HTTP(S) có SSRF guard, stage kết quả
bền vững và đưa metrics/findings/links vào ClickHouse trước khi công bố progress.
Page-report query đi qua Control Plane với owner scope và ingestion watermark.
Browser capture V1.5 vẫn chưa hoàn thành. Frontend tiếp tục
mặc định chạy mock để demo có thể xem độc lập.

## V1 goal

V1/V1.5 tập trung vào đăng ký website, chạy bounded scan, theo dõi tiến trình, xem kết quả và bằng chứng capture. Compare/Regression thuộc V2; AI Root Cause Analysis thuộc V3. V4–V8 lần lượt mở rộng sang lịch quét và cảnh báo, xử lý phân tán, RAG, ML anomaly detection và vận hành cloud production-grade.

## Architecture direction

Kiến trúc được duyệt trong [ADR-005](docs/adr/ADR-005-tach-crawler-thanh-microservice.md) có ba deployable chính: Spring Boot Control Plane, Go Crawler Service và Playwright Capture Worker. [ADR-006](docs/adr/ADR-006-tich-hop-clickhouse-cho-analytics.md) bổ sung ClickHouse làm analytical store; PostgreSQL vẫn sở hữu workflow và S3/MinIO sở hữu artifact lớn. Control Plane giữ modular boundaries nội bộ; mỗi service có database/role riêng. Kafka, Redis, Kubernetes và service bổ sung chưa thuộc V1/V1.5.

## Repository structure

- `backend/`: Spring Boot foundation đang được chuyển thành Control Plane và migration Flyway thuộc ownership của service này
- `frontend/`: React/TypeScript frontend demo
- `crawler/`: deployable Go mang giấy phép AGPL-3.0, provenance CrawlObserver và migration thuộc Crawler
- `infra/`: Control PostgreSQL, Crawler PostgreSQL và ClickHouse local bằng Compose
- Capture Worker vẫn là deployable boundary riêng của V1.5 và chưa được triển khai
- `docs/`: product and engineering sources of truth
- `docs/adr/`: architecture decision records
- `tasks/`: scoped implementation specifications

Start with [PRODUCT.md](docs/PRODUCT.md), [REQUIREMENTS.md](docs/REQUIREMENTS.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), and [DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Chạy frontend cục bộ

Yêu cầu Node.js tương thích với Vite 8. Từ thư mục `frontend`:

```powershell
npm install
npm run dev
```

Các lệnh kiểm tra: `npm run lint`, `npm test`, `npm run build`.

Mặc định frontend dùng mock service. Để dùng auth, website, scan và page report thật,
sao chép `frontend/.env.example` thành `frontend/.env.local`, đặt
`VITE_API_MODE=backend` và giữ `VITE_API_BASE_URL=http://localhost:8080`. Browser
capture V1.5 vẫn chỉ là dữ liệu minh họa cho đến khi Capture Worker được triển khai.

## Chạy Control Plane và Crawler cục bộ

Yêu cầu Java 21 và Docker. Sao chép `.env.example` thành `.env`, thay JWT secret/credential, rồi chạy:

```powershell
docker compose --env-file .env -f infra/compose.yml up -d
cd backend
.\mvnw.cmd spring-boot:run -Dspring-boot.run.profiles=dev
```

Health ở `http://localhost:8080/actuator/health`; Swagger ở `http://localhost:8080/swagger-ui.html` trong profile `dev`.

Trong terminal thứ hai, nạp các biến `CRAWLER_*`/`CLICKHOUSE_*` từ `.env`, rồi chạy:

```powershell
cd crawler
go run ./cmd/weblens-crawler
```

Crawler liveness/readiness ở `http://localhost:8081/health/live` và
`http://localhost:8081/health/ready`. `CRAWLER_MIGRATE_ON_START=true` chỉ dành
cho local/CI; production phải chạy migration bằng role DDL riêng.

## Development workflow

Create a task from `tasks/TEMPLATE.md`, review the relevant docs and ADRs, plan the change, implement it within existing boundaries, run the relevant build/tests, and review the final diff. Architectural changes require an ADR before implementation.
