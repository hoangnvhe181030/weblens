# Testing Strategy

Tests should prove important behavior at the cheapest reliable level while preserving real behavior at critical boundaries.

## Test layers

- **Unit tests:** domain invariants, URL normalization policy, scan state transitions, comparison math, regression thresholds, and evidence packaging.
- **Repository tests:** mappings, constraints, indexes relevant to queries, locking/version behavior, and PostgreSQL-specific SQL.
- **Integration tests:** module workflows with Spring context only where wiring, transactions, security, or infrastructure behavior matters.
- **API tests:** authentication/authorization, validation, status codes, problem details, pagination, and contract serialization.
- **Crawler tests:** controlled local HTTP/DNS fixtures for redirects, loops, timeouts, slow/large/compressed responses, malformed content, duplicate links, protocol rejection, and public/private address policy. Do not depend on public internet sites.
- **Regression tests:** stable fixtures covering thresholds, missing values, incompatible versions, page additions/removals, deterministic repeatability, and boundary noise.
- **AI adapter contract tests:** provider-independent success, timeout, malformed response, safety filtering, and evidence citation behavior; live-provider tests remain opt-in.

Use Testcontainers for PostgreSQL behavior rather than relying on H2 compatibility. Pin container versions and keep fixtures small and deterministic.

## Mocking guidance

Do not mock domain value objects, collections, SQL semantics, JSON serialization, Spring Security authorization, or the crawler's URL-safety policy when those behaviors are under test. Mock or fake true external boundaries—clock, DNS resolver/connector abstraction, controlled HTTP server, and LLM provider—where deterministic failure simulation is needed. Prefer a fake with realistic contract behavior over chains of interaction-heavy mocks.

## Later validation

Add performance/load tests only after representative workloads and SLO hypotheses exist. Likely targets are scan concurrency, crawl throughput under safety limits, comparison query latency, database growth, and recovery after process interruption. Security tests should include SSRF bypass cases and authorization isolation from the first crawler/API implementation.

Every task defines relevant commands and evidence. A passing test suite is necessary but not sufficient: review migration safety, logs, metrics, and the diff.
