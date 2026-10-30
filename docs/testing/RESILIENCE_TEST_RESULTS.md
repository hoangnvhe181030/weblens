# Resilience test results

Date: 2026-09-27.

## Verified

- Crawler local HTTP fixture: redirect, redirect chain, redirect limit/loop, 404, 503, unsupported content type, malformed and empty HTML, response byte cap and timeout. No public target was fetched.
- PostgreSQL integration: duplicate command and message collision, concurrent claim/cancel and heartbeat/cancel, cancellation fencing, expired-lease reclaim, analytics acknowledgement and backlog load shedding. Concurrent discovery preserved the unique normalized-URL, maxPages and maxDepth invariants across three repeat runs.
- Capture PostgreSQL integration: duplicate command, lease fencing, analytical completion, site-clone phase retry, cancellation partial state and garbage collection.
- Retry policy: network timeout/failure and selected transient HTTP statuses receive a bounded three-attempt retry with jitter. HTTP 501/505 now remain permanent failures.
- Playwright headless browser smoke passed four runs after installing the pinned Chromium build. It verified static render, screenshot, resource fetch, service-worker blocking, context isolation, private-egress denial and cleanup.

## Unverified

- Camoufox is the default production engine. Its local binary was absent; the opt-in smoke failed before launch. The pinned binary download was stopped because its transfer estimate exceeded this audit's practical window. See H-01.
- ClickHouse outage/acknowledgement ambiguity and object-storage failure/recovery were not exercised. See H-04.
- In-flight cancellation during browser capture, fetch, parse, persist and upload remains M-04.
- `Retry-After` handling remains M-03.

No load or stress test was run.
