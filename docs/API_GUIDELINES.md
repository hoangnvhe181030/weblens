# API Guidelines

## General

- Expose HTTPS JSON APIs under an explicit base such as `/api/v1`; confirm the version strategy during backend initialization.
- Use nouns for resources, standard HTTP methods, and accurate status codes.
- Treat DTOs as public contracts. Do not serialize persistence entities.
- Authenticate by default and authorize every user-owned resource without revealing another user's resource existence.
- Validate syntax at the boundary and return machine-readable field errors.

## Contracts

Use ISO 8601 UTC timestamps, stable opaque identifiers, explicit units, and documented nullability. Paginate collections with enforced maximum sizes. Keep ordering deterministic. Long-running scan creation returns an accepted/created resource representation with a status URL rather than holding the request open.

Errors should use a consistent problem-details shape compatible with RFC 9457, including a stable application error code and correlation identifier where useful. Do not return stack traces, secrets, raw provider errors, or untrusted response bodies.

## Compatibility and idempotency

Prefer additive compatible changes. Removing or changing meaning requires an explicit migration/version decision. Define idempotency for scan creation before implementation; if idempotency keys are supported, scope them to the authenticated user and operation and store outcomes for a bounded period.

## Contract nội bộ giữa các service

- Control Plane, Crawler Service và Capture Worker dùng contract có version;
  persistence entity hoặc bảng private không phải integration contract.
- Command/event mang message ID, aggregate ID, sequence/version và correlation ID.
- Delivery là at-least-once; consumer dedup và commit inbox cùng local state.
- Timeout không chứng minh operation từ xa thất bại. Retry phải giữ nguyên
  idempotency key và có bounded backoff/jitter.
- Không truyền access/refresh token của người dùng cho Crawler hoặc Capture Worker.
  Service-to-service caller phải được authenticate và authorize riêng.
- Không thiết kế request chain đồng bộ bắt buộc để trả accepted cho long-running
  work; persist local state/outbox trước rồi dispatch bất đồng bộ.

## Scan and comparison semantics

Status resources distinguish queued, running, complete, partial, failed, and cancelled outcomes. Results declare missing measurements rather than substituting zero. Comparison requests identify baseline and candidate explicitly and report incompatibility as a domain error.

## Observability and safety

Propagate correlation IDs, record request outcomes and latency, and use bounded logs. Apply request-size limits and rate limits at appropriate boundaries. Never accept arbitrary crawler configuration that bypasses server safety policy.
