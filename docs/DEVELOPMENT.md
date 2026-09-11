# Development

## Current implementation state

Repository có Control Plane Java 21/Spring Boot, Crawler Go, frontend React/TypeScript,
hai database PostgreSQL local và ClickHouse. Control Plane đã dispatch scan qua
outbox/inbox bền vững; Crawler đã thực thi bounded HTTP crawl, analytical
ingestion và page-report query có owner scope. Capture Worker chưa hoàn thành.

Theo ADR-005, backend hiện hữu là WebLens Control Plane. Go Crawler Service dựa
trên bản fork CrawlObserver nằm trong `crawler/`, có boundary và license AGPL
riêng. Playwright Capture Worker chưa được bootstrap. Không chuyển source AGPL
vào `backend/`.

## Local development

1. Copy `.env.example` to `.env` and replace all example credentials.
2. Khởi động Control PostgreSQL, Crawler PostgreSQL và ClickHouse:
   `docker compose --env-file .env -f infra/compose.yml up -d`.
3. From `backend/`, run `.\mvnw.cmd spring-boot:run -Dspring-boot.run.profiles=dev` with Java 21.
4. Từ `crawler/`, nạp các biến `CRAWLER_*` rồi chạy `go run ./cmd/weblens-crawler`.
5. Có thể cấu hình frontend backend mode, sau đó chạy `npm ci` và `npm run dev`.

Frontend mode is selected at build/start time:

- `VITE_API_MODE=mock` (default): complete deterministic UI demo.
- `VITE_API_MODE=backend`: auth, website, scan và page-report API thật tại
  `VITE_API_BASE_URL`; browser capture vẫn chưa có runtime V1.5.

The backend profile `dev` enables Swagger and uses explicit localhost defaults. Production startup has no default database password or JWT secret and therefore fails fast when required environment values are absent.

## Verification commands

- Backend: `.\mvnw.cmd verify` using Java 21. Docker must be running for PostgreSQL Testcontainers integration tests.
- Crawler unit/static: `go test ./...` và `go vet ./...` bằng phiên bản Go trong
  `crawler/go.mod`.
- Crawler PostgreSQL integration: cấp một database thử nghiệm rỗng qua
  `WEBLENS_TEST_POSTGRES_URL`, sau đó chạy `go test ./internal/postgres -run
  TestStoreWorkflowIntegration -v`. Test tự tạo và xóa schema cô lập; không dùng
  database production.
- Crawler ClickHouse integration: cấp instance thử nghiệm riêng qua
  `WEBLENS_TEST_CLICKHOUSE_ADDR`, `WEBLENS_TEST_CLICKHOUSE_USERNAME` và
  `WEBLENS_TEST_CLICKHOUSE_PASSWORD`, rồi chạy `go test ./internal/analytics -run
  TestClickHouseBatchIntegration -v`. CI đã cấu hình PostgreSQL 17.6 và ClickHouse
  26.3 cho hai integration suite này.
- Frontend: `npm run lint`, `npm test`, and `npm run build`.
- Health: `GET http://localhost:8080/actuator/health`.
- OpenAPI in dev: `GET http://localhost:8080/v3/api-docs`.

## Task workflow

1. Copy `tasks/TEMPLATE.md` to a clearly named task file and fill it with observable scope.
2. Read the sources of truth and applicable ADRs/agent instructions.
3. Inspect affected modules and write an implementation plan including failure, security, and consistency cases.
4. Implement the smallest complete change. Explain new dependencies in the task or ADR.
5. Run formatting, build, relevant tests, and migration/integration checks.
6. Review the diff for unrelated changes, secrets, generated output, and documentation drift.
7. Report results and the concepts the developer should understand before acceptance.

## Configuration and secrets

Copy `.env.example` to `.env` for local-only values when Compose exists. Never commit `.env`. Production configuration will be injected through the hosting platform and a secret manager. Tests should use isolated generated credentials and containers.

## Architecture changes

Update documentation with the code. Any material boundary, datastore, messaging, deployment, or trust-model change needs an ADR before implementation. Supersede old ADRs; do not rewrite their history.

Kiến trúc hiện hành nằm trong ADR-005 và ClickHouse đã được phê duyệt trong
ADR-006. Service mới, Kafka, Redis, Kubernetes hoặc thay đổi ownership tiếp theo
phải có ADR mới. Mỗi service sở hữu migration và database role riêng; không dùng
direct table access làm integration.
