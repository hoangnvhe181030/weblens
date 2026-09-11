# Task

## Goal

Implement the approved Java 21/Spring Boot backend foundation for WebLens V1, including real JWT authentication, PostgreSQL-backed Website CRUD, PostgreSQL-backed Scan lifecycle endpoints, common API infrastructure, OpenAPI, tests, CI, and a frontend backend-mode adapter.

## Why

The frontend currently depends on deterministic mock data. WebLens needs an executable, secure modular-monolith foundation so crawler, report, and later V1.5 work can be added incrementally without changing API or persistence boundaries.

## Requirements

- Follow `docs/superpowers/specs/2026-09-09-weblens-backend-foundation-design.md`.
- Use Java 21, Spring Boot 3.5.16, Maven Wrapper, PostgreSQL, and Flyway.
- Organize each business module by `controller`, `dto`, `service`, `model`, `entity`, and `repository`; add `auth.security` where appropriate.
- Implement register/login/refresh/logout/current-user with signed and verified JWTs, password hashing, refresh rotation, and revocation.
- Implement owner-scoped Website create/list/get/update/archive.
- Implement owner-scoped Scan create/list/get/cancel with idempotency, safety configuration snapshots, state invariants, and optimistic locking.
- Add RFC 9457 ProblemDetail, bounded pagination, correlation IDs, CORS, Actuator health, OpenAPI/Swagger, and basic safe logging.
- Add frontend API mapping while preserving mock mode.
- Add GitHub Actions for backend and frontend verification.

## API contract

- Authentication: `/api/v1/auth/registrations`, `/api/v1/auth/sessions`, `/api/v1/auth/token-refreshes`, `/api/v1/auth/session`, `/api/v1/me`.
- Websites: `/api/v1/websites` and `/api/v1/websites/{websiteId}`.
- Scans: `/api/v1/websites/{websiteId}/scans`, `/api/v1/scans/{scanId}`, `/api/v1/scans/{scanId}/cancellations`.
- Collections use `PageResponse<T>`; failures use `application/problem+json` with stable `code` and `correlationId`.
- Report and snapshot endpoints are not implemented in this task.

## Data changes

- Flyway creates `users`, `auth_sessions`, `websites`, and `scans` with ownership, uniqueness, lifecycle, timestamp, and optimistic-version constraints.
- No `scan_pages`, `metrics`, `findings`, regressions, AI, or capture tables.

## Edge cases

- Duplicate normalized email and website URL.
- Disabled user, invalid/expired/wrong-type JWT, reused refresh token, repeated logout.
- Invalid URL syntax, credentials/fragments, default ports, long names and input.
- Cross-owner resource access, archived website, website with active scan.
- Duplicate idempotency key, repeated cancellation, terminal scan cancellation, concurrent updates.
- Out-of-range pagination and malformed JSON.

## Security considerations

- Never persist raw passwords, refresh JWTs, authorization headers, or cookies.
- Access JWT is held in frontend memory; refresh JWT is an HttpOnly cookie.
- Validate issuer, audience, signature, expiry, token type, session, user status, and ownership.
- Refresh/logout require double-submit CSRF protection.
- Registration URL validation makes no network request and is not presented as SSRF protection.
- Do not log secrets or untrusted crawled content.

## Concurrency / consistency considerations

- Register and refresh rotation are transactionally complete use cases.
- Refresh sessions use pessimistic locking so one concurrent rotation wins.
- Scan and website entities use optimistic locking.
- Idempotency is scoped by user and request fingerprint.
- State transitions are monotonic; terminal states do not resume.

## Implementation plan

1. Scaffold Java 21/Spring Boot 3.5.16 with Maven Wrapper and module packages.
2. Add dependencies, type-safe configuration, PostgreSQL Compose, and Flyway migration.
3. Add pagination, ProblemDetail, correlation logging, CORS, OpenAPI, and health.
4. Implement and test auth/JWT/session rotation.
5. Implement and test Website CRUD/ownership/archive.
6. Implement and test Scan lifecycle/idempotency/cancellation.
7. Add frontend backend-mode API adapter and contract mapping.
8. Add architecture/integration tests and GitHub Actions.
9. Run all builds/tests, review migrations and source for secrets/unrelated changes, and update documentation.

## Tests

- Unit tests for normalization, token claims, scan transitions, and progress invariants.
- MockMvc and integration tests for authentication, validation, security, ownership, status/header/body contracts, and ProblemDetail.
- PostgreSQL Testcontainers tests for Flyway, constraints, queries, locking, and transactions.
- ArchUnit module-boundary tests.
- Frontend lint, Vitest, TypeScript, build, and UTF-8 validation.

## Definition of Done

- Backend starts on Java 21 against PostgreSQL and reports health `UP`.
- Auth, Website, and Scan foundation endpoints work and appear in Swagger.
- JWT signature/claim verification, refresh rotation, revocation, owner isolation, and concurrency rules have automated coverage.
- Backend `mvnw verify` and frontend lint/test/build pass.
- CI runs equivalent checks without repository secrets.
- No crawler, report, or future-version behavior is falsely represented as implemented.

## What I should understand before accepting this implementation

- Why module-first packaging still uses familiar Spring technical package names.
- Why DTO, domain model, and JPA entity remain separate responsibilities.
- How short-lived JWTs and persistent refresh sessions provide revocation and rotation.
- How transaction boundaries, database constraints, idempotency, and optimistic/pessimistic locking protect consistency.
- Why a durable `QUEUED` scan is not evidence that crawling has occurred.
