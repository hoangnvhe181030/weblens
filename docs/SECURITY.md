# Security

WebLens processes user-supplied destinations and hostile internet content. Crawler safety is a release requirement, not a later hardening task.

## SSRF and outbound access

- Permit only `http` and `https`; reject embedded credentials and ambiguous/malformed URLs.
- Resolve and validate every destination against deny rules for loopback, link-local, private, multicast, reserved, metadata-service, and other non-public ranges for both IPv4 and IPv6.
- Pin or revalidate resolved addresses at connection time to reduce DNS rebinding and time-of-check/time-of-use gaps. Define behavior for multiple answers and DNS changes.
- Reapply the full protocol, host, DNS, and address policy to every redirect. Limit redirect count and reject protocol downgrade if policy requires it.
- Use explicit connect, TLS, read, total-request, page, and scan timeouts. Limit response bytes, decompressed bytes, header size/count, and supported content types.
- Do not trust proxy environment variables or allow callers to supply arbitrary proxies. Control outbound network egress in deployment as defense in depth.

## Crawler abuse controls

Bound pages, depth, redirects, concurrency, per-host request rate, total duration, and response sizes. Identify the crawler appropriately, decide and document robots policy, provide cancellation, and prevent WebLens from becoming an amplification or availability-attack tool. Record classified failures without logging response bodies.

## Authentication and authorization

Use established Spring Security mechanisms, strong password hashing if passwords are stored, generic login errors, secure session/token handling, and CSRF protection appropriate to the chosen browser-auth design. Enforce ownership in application queries/use cases, not only UI routes. Rate-limit sensitive operations.

## Untrusted content

Treat HTML, scripts, headers, URLs, certificates, metadata, filenames, and encodings as hostile. Parse with maintained libraries under size/time limits. Never execute page scripts in the backend by default or render captured HTML unsanitized in the frontend. Protect logs, metrics labels, and database fields against injection and unbounded cardinality.

## AI and prompt injection

Page content and retrieved text are data, never instructions. Build a structured, minimal evidence package; separate system policy from untrusted content; limit tokens and tool permissions; do not give the model network/database authority; require deterministic authorization before retrieval; and label generated claims. Store only necessary prompts/outputs and redact secrets or personal data. AI failure cannot alter deterministic findings.

## Secrets and data

Keep secrets out of source, images, logs, test fixtures, and client bundles. Use environment injection locally and a secret manager in hosted environments. Rotate credentials, apply least privilege, encrypt transport, minimize retained crawl content, and define deletion/retention before production.

## Defensive scope

V1 collects defensive health signals only. It must not perform exploit attempts, credential attacks, stealth scanning, or penetration testing.
