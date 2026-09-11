# WebLens Backend Foundation Design

**Status:** Đã được người dùng duyệt  
**Ngày:** 2026-09-09  
**Phạm vi:** Backend foundation và vertical slice đầu tiên cho WebLens V1

## 1. Bối cảnh và quyết định phạm vi

WebLens đã có frontend React/TypeScript chạy bằng mock data. Bước này tạo một backend Spring Boot có thể chạy, lưu dữ liệu thật và làm nền cho việc phát triển từng tính năng V1 sau đó.

Quyết định đã được xác nhận:

- V1 gồm authentication, website management, bounded scan lifecycle và hợp đồng report.
- Compare/Regression thuộc V2; AI Root Cause Analysis thuộc V3.
- Browser capture, snapshot, screenshot và resource inspection thuộc V1.5, không triển khai trong task này.
- Foundation phải phát hành và xác minh JWT thật.
- Website CRUD và Scan lifecycle dùng PostgreSQL thật.
- Chưa thực hiện outbound crawling. Scan được tạo bền vững ở trạng thái `QUEUED` và chỉ thay đổi khi có cancellation hoặc application/worker interface trong task sau.
- Dùng Java 21, Spring Boot 3.5.16 và Maven Wrapper.

## 2. Mục tiêu

1. Tạo Spring Boot application có cấu trúc modular monolith rõ ràng.
2. Cung cấp authentication hoạt động được: register, login, refresh, logout, current user.
3. Cung cấp Website CRUD có authorization theo owner và archive mềm.
4. Cung cấp Scan create/list/get/cancel cùng domain state machine và optimistic locking.
5. Thiết lập PostgreSQL, Flyway, ProblemDetail, pagination, OpenAPI, Actuator và correlation logging.
6. Thiết lập unit, API, security, PostgreSQL integration và architecture tests.
7. Thêm GitHub Actions cho backend và frontend.
8. Thêm frontend API adapter để các màn hình hiện tại có thể chuyển giữa mock và backend.

## 3. Ngoài phạm vi

- Fetch URL, DNS resolution, SSRF enforcement runtime hoặc HTML parsing.
- Crawl scheduler/worker, page discovery, metrics và findings generation.
- Scan comparison, regression, AI, browser capture, object storage.
- Email verification, password reset, social login, roles/administration.
- Redis, Kafka, microservices, Kubernetes hoặc deployment pipeline.
- Hard delete website/scan và retention automation.

Các scan safety limits vẫn được bind và validate ở configuration để task crawler sau không nhận cấu hình tùy ý từ client.

## 4. Công nghệ và dependency

### Runtime

- Java 21.
- Spring Boot 3.5.16.
- Maven Wrapper.
- Spring MVC cho REST API blocking.
- Bean Validation cho request/config validation.
- Spring Security và OAuth2 Resource Server/Jose cho JWT.
- Spring Data JPA cho persistence.
- PostgreSQL là authoritative database.
- Flyway cho mọi schema change.
- Actuator cho health/info.
- springdoc-openapi 2.x cho OpenAPI 3 và Swagger UI.

### Test

- JUnit 5, AssertJ và Mockito từ Spring Boot Test.
- Spring Security Test.
- Testcontainers JUnit/PostgreSQL và Spring Boot Testcontainers service connection.
- ArchUnit để kiểm tra dependency giữa module.

Không dùng Lombok, MapStruct, H2 hoặc JWT library riêng. Spring Security cung cấp `JwtEncoder`, `JwtDecoder` và bearer-token security filter, tránh duplicate parsing/security logic.

## 5. Kiến trúc và package structure

```text
backend/
├── pom.xml
├── mvnw
├── mvnw.cmd
├── .mvn/wrapper/
├── src/main/java/com/weblens/
│   ├── WebLensApplication.java
│   ├── auth/
│   │   ├── controller/
│   │   ├── dto/
│   │   ├── service/
│   │   ├── model/
│   │   ├── entity/
│   │   ├── repository/
│   │   └── security/
│   ├── website/
│   │   ├── controller/
│   │   ├── dto/
│   │   ├── service/
│   │   ├── model/
│   │   ├── entity/
│   │   └── repository/
│   ├── scan/
│   │   ├── controller/
│   │   ├── dto/
│   │   ├── service/
│   │   ├── model/
│   │   ├── entity/
│   │   └── repository/
│   └── common/
│       ├── dto/
│       ├── exception/
│       ├── config/
│       └── logging/
└── src/main/resources/
    ├── application.yml
    ├── application-dev.yml
    └── db/migration/
```

Đây là cấu trúc **module-first**: các package kỹ thuật quen thuộc được đặt bên trong từng business module, không gom toàn bộ controller hoặc repository của hệ thống vào một package toàn cục.

### Trách nhiệm package

| Package | Trách nhiệm |
|---|---|
| `controller` | REST endpoint, HTTP status/header và chuyển request sang use case |
| `dto` | Request/response công khai; không chứa JPA annotation |
| `service` | Use case, authorization, transaction boundary và orchestration |
| `model` | Domain value object, enum, invariant và state transition |
| `entity` | JPA mapping, database identity/version; không được trả trực tiếp qua API |
| `repository` | Repository interface, Spring Data repository và adapter/map giữa model với entity |
| `security` | Chỉ trong `auth`: JWT encoder/decoder, authentication filter configuration và security handlers |

`common.dto` chứa pagination DTO; `common.exception` chứa ProblemDetail mapping và exception kỹ thuật dùng chung; `common.config` chứa type-safe configuration; `common.logging` chứa correlation ID/MDC. `common` không chứa domain model, entity, repository hoặc generic base service.

### Dependency rules

- Controller gọi service; không gọi repository trực tiếp.
- Service sở hữu transaction boundary của use case và chỉ trả DTO/model đã được map có chủ đích.
- Model chứa invariant và transition, không phụ thuộc controller, DTO, entity hoặc Spring Data.
- Entity chỉ phục vụ persistence; repository chịu trách nhiệm map giữa entity và model khi hai biểu diễn khác nhau.
- Module khác không import controller, DTO, JPA entity hoặc Spring Data repository nội bộ. Giao tiếp liên module đi qua service/interface được công khai có chủ đích.
- Không tạo interface/adapter chỉ để đủ mẫu; repository adapter chỉ xuất hiện khi thực sự cần tách domain model khỏi JPA entity.
- Ownership được thực thi trong service/query use case, không chỉ ở route hoặc frontend.

## 6. Authentication và JWT

### Flow

1. Register chuẩn hóa email, kiểm tra unique, hash password và tạo user/session trong transaction.
2. Login luôn dùng thông báo lỗi chung nếu credential sai hoặc user không hoạt động.
3. Backend phát hành access JWT và refresh JWT.
4. Access JWT được trả trong JSON và frontend chỉ giữ trong memory.
5. Refresh JWT được đặt trong cookie `HttpOnly`, `SameSite=Strict`, path giới hạn ở auth API và `Secure=true` ở production.
6. Refresh kiểm tra chữ ký/claims và session trong database, revoke session cũ rồi rotate token trong một transaction.
7. Logout revoke session và xóa refresh cookie.

### Token policy

- Access TTL: 15 phút.
- Refresh TTL: 7 ngày.
- Thuật toán: HMAC SHA-256 với secret Base64 tối thiểu 256 bit từ environment.
- Claims bắt buộc: `iss`, `aud`, `sub`, `iat`, `nbf`, `exp`, `jti`, `sid`, `token_type`.
- `iss`: `weblens-api`; `aud`: `weblens-web` theo mặc định và đều có thể cấu hình.
- Access decoder kiểm tra signature, issuer, audience, expiry và `token_type=access`.
- Refresh flow kiểm tra `token_type=refresh` và active session.
- Database chỉ giữ SHA-256 hash của refresh JTI/token identifier, không giữ raw JWT.

Spring Security Resource Server cấu hình `JwtDecoder` và sử dụng bearer-token filter chuẩn. Security context lấy user UUID từ `sub`; service vẫn kiểm tra user status và ownership.

Password dùng `DelegatingPasswordEncoder` với BCrypt làm encoder hiện tại. Strength mặc định 12 và có thể cấu hình/tune theo môi trường.

### CSRF và CORS

- API dùng bearer access token không dựa vào cookie nên không yêu cầu CSRF token.
- Refresh/logout dựa vào HttpOnly cookie nên yêu cầu double-submit token: cookie `XSRF-TOKEN` và header `X-XSRF-TOKEN`.
- Register/login không yêu cầu credential cookie đầu vào.
- CORS chỉ chấp nhận danh sách origin từ config; không dùng wildcard khi bật credentials.

## 7. Persistence model

Flyway migration đầu tiên tạo schema thực tế, không dùng `ddl-auto=create/update`.

### `users`

- `id UUID` primary key.
- `email`, `normalized_email` unique.
- `display_name`.
- `password_hash`.
- `status`: `ACTIVE | DISABLED`.
- `created_at`, `updated_at`, `version`.

### `auth_sessions`

- `id UUID` primary key và là JWT `sid`.
- `user_id` foreign key.
- `refresh_jti_hash` unique.
- `expires_at`, `revoked_at`, `created_at`, `rotated_at`.
- Index cho active sessions theo user và expiry cleanup trong tương lai.

### `websites`

- `id UUID` primary key.
- `owner_id` foreign key.
- `display_name`, `canonical_url`, `hostname`.
- `status`: `ACTIVE | ARCHIVED`.
- `archived_at`, `created_at`, `updated_at`, `version`.
- Partial unique index trên `(owner_id, canonical_url)` khi chưa archive.

URL registration chỉ chấp nhận HTTP(S), không cho credentials/fragments, chuẩn hóa scheme/host/default port/path. Validation không tạo outbound request. SSRF/DNS policy sẽ được áp dụng lại khi crawler thực sự kết nối.

### `scans`

- `id UUID` primary key.
- `website_id` foreign key.
- `requested_by_user_id` foreign key.
- `status`: `QUEUED | RUNNING | CANCEL_REQUESTED | COMPLETED | PARTIAL_SUCCESS | FAILED | CANCELLED`.
- Progress: `discovered_count`, `queued_count`, `processed_count`, `succeeded_count`, `failed_count`.
- Effective config: `max_pages`, `max_depth`, `max_response_bytes`, `max_duration_seconds`, `max_redirects`, `concurrency`.
- `collector_version`, `terminal_code`, `terminal_message`.
- `created_at`, `started_at`, `finished_at`, `updated_at`, `version`.
- `idempotency_key_hash` nullable; unique với requesting user khi có giá trị.
- Index theo website và `(created_at, id)` để pagination có thứ tự ổn định.

Không tạo `scan_pages`, `metrics`, `findings` trong foundation. Những bảng này thuộc task crawler/report và phải có migration mới.

## 8. Scan lifecycle và consistency

```text
QUEUED ──→ RUNNING ──→ COMPLETED
   │          ├──────→ PARTIAL_SUCCESS
   │          ├──────→ FAILED
   │          └──────→ CANCEL_REQUESTED ──→ CANCELLED
   ├─────────────────→ CANCELLED
   └─────────────────→ FAILED
```

- Terminal state không quay lại non-terminal state.
- Foundation cho phép tạo scan ở `QUEUED` và hủy `QUEUED → CANCELLED`.
- Các transition worker dùng sau này được cài đặt/test ở domain nhưng chưa có public endpoint để caller tùy ý chuyển trạng thái.
- Yêu cầu hủy `RUNNING` chuyển sang `CANCEL_REQUESTED`; worker sau này chịu trách nhiệm dừng an toàn và xác nhận `CANCELLED`.
- Repeated cancellation của `CANCEL_REQUESTED/CANCELLED` trả trạng thái hiện tại.
- Cancellation của trạng thái terminal khác trả `409 SCAN_NOT_CANCELLABLE`.
- JPA optimistic version ngăn lost update. Conflict concurrency được trả `409` thay vì silently overwrite.
- Progress phải không âm, không vượt `maxPages`, và `processed = succeeded + failed` khi được worker cập nhật.
- `Idempotency-Key` được trim, bound length, hash trước khi lưu và scope theo requesting user. Cùng key/cùng operation trả scan đã tạo; cùng key nhưng payload khác trả conflict.

## 9. API conventions

- Base path: `/api/v1`.
- JSON dùng camelCase.
- ID là UUID string opaque.
- Timestamp là ISO 8601 UTC.
- Duration là integer milliseconds, không trả chuỗi đã format.
- Missing measurement là `null` kèm reason khi cần; không thay bằng `0`.
- Page index bắt đầu từ `0`; default `size=20`, maximum `size=100`.
- Collection order luôn có tie-breaker bằng ID.
- User khác sở hữu resource được trả `404` để không lộ sự tồn tại.

### Common page response

```json
{
  "items": [],
  "page": 0,
  "size": 20,
  "totalItems": 0,
  "totalPages": 0
}
```

### ProblemDetail

Content type: `application/problem+json`.

```json
{
  "type": "https://docs.weblens.dev/problems/validation-failed",
  "title": "Request validation failed",
  "status": 400,
  "detail": "One or more fields are invalid.",
  "instance": "/api/v1/websites",
  "code": "VALIDATION_FAILED",
  "correlationId": "01J...",
  "fieldErrors": [
    { "field": "url", "message": "must be a valid HTTP(S) URL" }
  ]
}
```

Security entry point/denied handler và controller advice phải cùng format. Không trả stack trace, SQL, secret hoặc raw exception message.

## 10. API contract V1 foundation

### Authentication

#### `POST /api/v1/auth/registrations`

Request:

```json
{ "email": "dev@example.com", "password": "a-strong-password", "displayName": "WebLens Dev" }
```

Response `201 Created`: `AuthSessionResponse`. Duplicate email trả `409 EMAIL_ALREADY_REGISTERED` nhưng login failure vẫn generic.

#### `POST /api/v1/auth/sessions`

Request:

```json
{ "email": "dev@example.com", "password": "a-strong-password" }
```

Response `200 OK`:

```json
{
  "user": {
    "id": "uuid",
    "email": "dev@example.com",
    "displayName": "WebLens Dev",
    "status": "ACTIVE"
  },
  "accessToken": "jwt",
  "tokenType": "Bearer",
  "expiresAt": "2026-09-09T10:15:00Z"
}
```

Refresh JWT và CSRF token được chuyển bằng cookie. Invalid credential trả `401 INVALID_CREDENTIALS` với message chung.

#### `POST /api/v1/auth/token-refreshes`

Yêu cầu refresh cookie và `X-XSRF-TOKEN`; rotate session. Response là access-token metadata mới và refresh cookie mới.

#### `DELETE /api/v1/auth/session`

Revoke session hiện tại, clear cookie, trả `204 No Content`. Repeated logout không tiết lộ session state.

#### `GET /api/v1/me`

Trả `UserResponse` của access-token subject hiện tại.

### Websites

#### `POST /api/v1/websites`

Request:

```json
{ "name": "WebLens Docs", "url": "https://docs.weblens.dev/" }
```

Trả `201 Created`, `Location: /api/v1/websites/{id}` và `WebsiteResponse`.

#### `GET /api/v1/websites?page=0&size=20&status=ACTIVE&sort=updatedAt,desc`

Trả `PageResponse<WebsiteSummaryResponse>`. Server chỉ cho phép sort field đã whitelist.

#### `GET /api/v1/websites/{websiteId}`

Trả `WebsiteResponse` thuộc current user.

#### `PATCH /api/v1/websites/{websiteId}`

Request chỉ cho đổi tên:

```json
{ "name": "Production Docs" }
```

Canonical target không sửa tại chỗ.

#### `DELETE /api/v1/websites/{websiteId}`

Archive mềm và trả `204 No Content`. Website có active scan trả `409 WEBSITE_HAS_ACTIVE_SCAN`.

### Scans

#### `POST /api/v1/websites/{websiteId}/scans`

Header `Idempotency-Key` là optional nhưng được frontend tạo cho mỗi user action. Không nhận safety configuration từ caller trong foundation.

Trả `202 Accepted`, `Location: /api/v1/scans/{id}` và `ScanResponse`.

#### `GET /api/v1/websites/{websiteId}/scans?page=0&size=20`

Trả lịch sử `PageResponse<ScanSummaryResponse>`, mới nhất trước.

#### `GET /api/v1/scans/{scanId}`

Trả `ScanResponse` để polling.

#### `POST /api/v1/scans/{scanId}/cancellations`

Trả `202 Accepted` khi vừa nhận cancellation, `200 OK` khi cancellation trước đó đã được ghi nhận, hoặc `409` nếu scan đã kết thúc theo kết quả khác.

### Report contract dành cho task crawler sau

Các endpoint dưới đây được ghi vào API design nhưng chưa được controller hóa trong foundation:

- `GET /api/v1/scans/{scanId}/pages`
- `GET /api/v1/scan-pages/{scanPageId}`

Không trả response giả hoặc `200 []` khi storage chưa tồn tại. Frontend backend-mode chỉ mở các deep report route khi API này được triển khai.

## 11. Dữ liệu frontend cần theo màn hình

| Màn hình | API | Trường dữ liệu cần |
|---|---|---|
| Register | `POST /auth/registrations` | user, accessToken, expiresAt |
| Login | `POST /auth/sessions` | user, accessToken, expiresAt |
| App shell | `GET /me` | id, email, displayName, status |
| Website list | `GET /websites` | id, name, canonicalUrl, hostname, status, latestScan, pageCount, findingCount, createdAt, updatedAt |
| Create website | `POST /websites` | name, raw URL request; canonical website response |
| Website detail | `GET /websites/{id}` | website metadata và aggregate counts |
| Scan history | `GET /websites/{id}/scans` | scan ID, status, timestamps, durationMs, progress, findingCount |
| Start scan | `POST /websites/{id}/scans` | ScanResponse và polling URL từ Location |
| Scan progress | `GET /scans/{id}` | status, effectiveConfig, progress, timestamps, terminalReason |
| Cancel scan | `POST /scans/{id}/cancellations` | current ScanResponse |
| Page outcomes | future `GET /scans/{id}/pages` | page ID/path/URL/outcome/status/time/size/error classification |
| Page evidence | future `GET /scan-pages/{id}` | metadata, measurements, resource counts, findings |
| Snapshot | V1.5 | capture status, screenshot/object references, resources |

### Website summary response

```json
{
  "id": "uuid",
  "name": "WebLens Docs",
  "canonicalUrl": "https://docs.weblens.dev/",
  "hostname": "docs.weblens.dev",
  "status": "ACTIVE",
  "latestScan": {
    "id": "uuid",
    "status": "QUEUED",
    "createdAt": "2026-09-09T10:00:00Z",
    "finishedAt": null
  },
  "pageCount": 0,
  "findingCount": 0,
  "createdAt": "2026-09-09T09:00:00Z",
  "updatedAt": "2026-09-09T10:00:00Z"
}
```

Trong foundation, `pageCount` và `findingCount` bằng `0` vì report persistence chưa tồn tại. Đây là dữ liệu đúng theo trạng thái hệ thống, không phải mock result.

### Scan response

```json
{
  "id": "uuid",
  "websiteId": "uuid",
  "status": "QUEUED",
  "createdAt": "2026-09-09T10:00:00Z",
  "startedAt": null,
  "finishedAt": null,
  "durationMs": null,
  "progress": {
    "discovered": 0,
    "queued": 0,
    "processed": 0,
    "succeeded": 0,
    "failed": 0,
    "limit": 25
  },
  "effectiveConfig": {
    "maxPages": 25,
    "maxDepth": 3,
    "maxResponseBytes": 10485760,
    "maxDurationSeconds": 120,
    "maxRedirects": 5,
    "concurrency": 3
  },
  "collectorVersion": "crawler-v1",
  "findingCount": 0,
  "terminalReason": null
}
```

Frontend không nhận chuỗi như “2 phút trước” hoặc “00:18” từ backend. Adapter/UI chịu trách nhiệm localization và formatting.

## 12. Frontend adapter

```text
frontend/src/api/
├── apiClient.ts
├── contracts.ts
├── authApi.ts
└── webLensApiService.ts
```

- `VITE_API_MODE=mock|backend`; default local demo vẫn là `mock` cho đến khi developer chọn backend.
- `VITE_API_BASE_URL=http://localhost:8080`.
- Access token chỉ giữ trong memory.
- Request gửi `credentials: include` để refresh cookie hoạt động.
- Một request `401` được phép kích hoạt đúng một refresh attempt; refresh failure xóa auth state và điều hướng login, không retry loop.
- Adapter map ISO timestamp/duration sang view model hiện tại.
- `application/problem+json` được normalize thành `ServiceError` có code, message, correlation ID và field errors.
- Backend mode hỗ trợ auth, website và scan foundation. Page evidence/snapshot route không được giả lập bằng backend response khi API chưa tồn tại; mock mode vẫn giữ demo đầy đủ.

## 13. Configuration

Type-safe `@ConfigurationProperties` có startup validation:

- `weblens.security.jwt.*`: secret, issuer, audience, access/refresh TTL.
- `weblens.security.cors.allowed-origins`.
- `weblens.security.cookies.secure`.
- `weblens.scan.limits.*`: 25 pages, depth 3, 10 MiB/response, 120 seconds, 5 redirects, concurrency 3.
- `weblens.openapi.enabled`.

Database credential và JWT secret chỉ lấy từ environment. Test tạo credential/key riêng. `.env` không được commit.

Profile `dev` bật Swagger và cho phép configured localhost origin. Production không có default secret và fail-fast nếu thiếu config bắt buộc.

## 14. OpenAPI, health và logging

- `/v3/api-docs` và `/swagger-ui.html` khi OpenAPI enabled.
- Bearer JWT security scheme được khai báo cho protected endpoint.
- Swagger mô tả request, response, pagination, ProblemDetail và validation examples.
- `/actuator/health` public; `/actuator/info` có thể public nhưng không chứa build secret/environment data.
- Chỉ expose Actuator `health` và `info`; health details không public.
- Correlation filter nhận `X-Correlation-ID` hợp lệ có giới hạn hoặc sinh ID mới, trả lại header và đặt vào MDC.
- Log format có timestamp, level, logger, correlation ID. Không log Authorization, cookie, password, JWT, response body, HTML hoặc raw untrusted URL content.

## 15. Testing strategy

### Unit

- Email/URL normalization và password policy.
- Scan allowed/forbidden transitions và progress invariants.
- JWT claim construction/validation helpers.

### MockMvc/API/Security

- Register/login/refresh/logout success và failure.
- Expired, wrong-signature, wrong-issuer/audience/token-type JWT.
- `401`, `403`, validation, malformed JSON, conflict và not-found ProblemDetail.
- Website owner isolation, archive behavior và pagination bounds.
- Scan creation/idempotency/cancellation/concurrency response.

### PostgreSQL/Testcontainers

- Flyway applies cleanly.
- Case-insensitive normalized email uniqueness.
- Active website uniqueness và ability to register again after archive according to partial index.
- Repository owner scoping/order/pagination.
- Optimistic-lock conflict và transaction rollback.

Không dùng public internet hoặc H2 trong test. Integration tests dùng pinned PostgreSQL container image.

### Architecture

ArchUnit chứng minh module không import controller/DTO/JPA entity/Spring Data repository nội bộ của module khác; `model` không phụ thuộc `controller`, `dto`, `entity`, `repository` hoặc Spring framework; controller không được gọi repository trực tiếp.

## 16. GitHub Actions

Hai job độc lập:

1. `backend`: Temurin 21, Maven cache, `./mvnw verify`, upload test reports khi fail.
2. `frontend`: Node 24/npm cache, `npm ci`, lint, test và production build.

Testcontainers dùng Docker runner có sẵn của GitHub Actions. Workflow không deploy, publish artifact/image hoặc cần repository secret.

## 17. Local development

- `infra/compose.yml` cung cấp PostgreSQL development với healthcheck và volume có tên.
- Backend chạy qua Maven Wrapper với Java 21.
- Vì máy hiện chỉ có Java 17, bước implementation sẽ dùng JDK 21 cục bộ/portable được ignore khỏi repository để chạy verification, không thay đổi target hoặc commit binary JDK.
- Frontend và backend chạy bằng native build tool; Compose không bao bọc application process.

## 18. Failure modes và rủi ro

- **Credential enumeration:** login generic; register duplicate vẫn phải báo conflict để UX rõ, kèm rate limiting là task production hardening sau.
- **JWT theft:** TTL ngắn, refresh HttpOnly, rotation/revocation; HTTPS vẫn bắt buộc ngoài local.
- **Concurrent refresh:** transaction/locking cho phép một rotation thắng, request cũ bị từ chối.
- **Concurrent scan actions:** optimistic locking và state machine.
- **Cross-tenant access:** owner predicate trong mọi query và API tests cho user isolation.
- **SSRF:** foundation không kết nối target. URL syntax validation không được tuyên bố là SSRF defense; crawler task phải kiểm tra DNS/IP/redirect ở mỗi outbound connection.
- **Queued scan không chạy:** đây là giới hạn được hiển thị rõ cho đến khi crawler worker được triển khai.
- **JTI/session accumulation:** chưa có cleanup job; retention/cleanup sẽ được thêm trước production.
- **HMAC secret rotation:** foundation dùng một active secret; multi-key rotation cần thiết kế trước production.
- **Rate limiting:** chưa triển khai vì không thêm Redis/infrastructure khi chưa có task/ADR; auth/crawl abuse controls vẫn là release requirement.

## 19. Definition of Done

- Backend build được bằng Java 21 và Maven Wrapper.
- PostgreSQL khởi động bằng Compose và Flyway migration chạy sạch.
- Register/login/refresh/logout/JWT verification hoạt động.
- Website CRUD và Scan create/list/get/cancel hoạt động, có owner authorization.
- ProblemDetail, pagination, correlation ID, OpenAPI và health hoạt động.
- Frontend có thể chọn backend mode cho auth/website/scan mà mock demo vẫn hoạt động.
- Unit, MockMvc, security, integration, architecture, frontend lint/test/build đều pass.
- GitHub Actions chạy cùng các verification chính.
- Không có secret, compiled output, downloaded JDK hoặc untrusted crawled content trong source.

## 20. Các khái niệm developer cần hiểu trước khi chấp nhận code

- Modular monolith bảo vệ boundary bằng module-first package và tests, không cần network boundary. Các tên `controller/service/model/entity/repository` vẫn quen thuộc nhưng không làm mất ranh giới Auth, Website và Scan.
- REST DTO, domain object và JPA entity có trách nhiệm khác nhau; persistence entity không phải API contract.
- JWT signature không tự cung cấp revocation; `auth_sessions`, short TTL và rotation bổ sung lifecycle cho credential.
- Transaction boundary phải bao trọn register, refresh rotation, archive và scan state change.
- Optimistic locking phát hiện concurrent write nhưng application vẫn phải chuyển conflict thành domain/API response rõ ràng.
- Flyway migration là lịch sử bất biến; schema mới luôn dùng migration version mới.
- Frontend localization không thuộc backend contract; backend trả timestamp/duration có đơn vị và nullability rõ ràng.
- Scan record bền vững không đồng nghĩa crawler đã tồn tại. `QUEUED` là trạng thái thật, không phải kết quả giả.
