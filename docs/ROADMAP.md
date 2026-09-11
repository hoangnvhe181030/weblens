# Roadmap

The phases are sequencing hypotheses, not deadlines or commitments. Each phase requires validation before expanding scope.

## Phase 0 — Foundation

Establish sources of truth, agent/development workflow, architecture decisions, repository skeleton, and then initialize minimal backend, frontend, PostgreSQL local environment, and CI.

## V1 — Website management and basic scanning

Triển khai authentication, website ownership, bounded scan creation trong Spring
Boot Control Plane và Go Crawler Service dựa trên bản fork CrawlObserver. Hoàn tất
durable dispatch, idempotent event, limited crawling, basic measurements, progress,
recovery, PostgreSQL-to-ClickHouse analytical ingestion và report mà chưa cần
Kafka/Redis.

## V1.5 — Browser capture and resource inspection

Bổ sung deployable Playwright/Chromium Capture Worker cô lập, rendered snapshot,
screenshot, captured resource/network metadata, S3-compatible object storage,
content hashing, ClickHouse capture analytics, inspection UI và bounded execution.

## V2 — Historical comparison and regression detection

Preserve compatible metric history, compare two scans, and introduce deterministic, versioned regression rules with evidence.

## V3 — AI root-cause analysis

Add a provider-neutral LLM boundary and bounded, prompt-injection-aware explanations grounded in stored regression evidence.

## V4 — Monitoring and scheduled scans

Validate demand, then add schedules, notification policy, failure handling, and operational controls.

## V5 — Scale

Đo queue delay, throughput, recovery, database load và coordination. Chỉ thêm
Kafka, Redis, tách service mới, multi-region worker hoặc hạ tầng khác khi ADR chứng
minh REST + PostgreSQL outbox/inbox, ClickHouse ingestion và ba boundary hiện tại
không đủ.

## V6 — RAG and Ask WebLens

Explore retrieval only for a validated knowledge use case with source provenance, authorization, freshness, and evaluation criteria.

## V7 — ML anomaly detection

Introduce an independent Python/ML component only when sufficient labeled or historical data and an evaluation baseline justify training beyond deterministic rules.

## V8 — Production cloud operations

Evolve hosting, telemetry, SLOs, capacity planning, and orchestration. Kubernetes and multi-cloud remain optional responses to operational requirements.
