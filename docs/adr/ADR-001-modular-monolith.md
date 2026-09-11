# Start with a modular monolith

Status: Superseded một phần bởi ADR-005  
Date: 2026-09-01

> Từ ngày 2026-09-11, quyết định dùng một Spring Boot deployable cho toàn bộ
> WebLens không còn hiệu lực. Theo ADR-005, Control Plane vẫn tổ chức nội bộ theo
> modular-monolith boundaries, nhưng Crawler Service và Capture Worker là các
> deployable độc lập.

## Context

WebLens V1 spans identity, websites, scanning, crawling, analysis, regressions, and AI explanations. Product behavior, domain boundaries, workload, and team topology are not yet validated. Distributed services would add network failure, eventual consistency, deployment, tracing, and operational costs before those costs solve a measured problem.

## Options considered

- A Spring Boot modular monolith with explicit internal boundaries
- Multiple independently deployed services from the start
- An unstructured monolith organized only by technical layers

## Decision

Build V1 as one Spring Boot deployable organized into explicit business modules. Modules communicate through deliberate application interfaces and do not share controllers, repositories, or persistence entities. Add architecture tests when packages exist.

## Consequences

Local development, transactions, testing, deployment, and debugging stay simpler. Boundaries can evolve cheaply while requirements are learned. The application may require later extraction work, and module discipline must be actively enforced despite a shared process/database.

## When to revisit

Revisit when measured scaling isolation, fault containment, security isolation, independent release cadence, or stable team ownership cannot be met adequately inside the modular monolith.
