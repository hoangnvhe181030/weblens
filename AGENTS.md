# WebLens Agent Guide

## Project goal

WebLens is an AI-assisted website engineering and monitoring platform. V1 lets developers authenticate, register websites, run bounded scans, inspect progress, and review deterministic results. Comparison and regression detection begin in V2; evidence-grounded AI explanations begin in V3.

## Sources of truth

- `docs/PRODUCT.md`: product goals and scope
- `docs/REQUIREMENTS.md`: functional requirements and acceptance criteria
- `docs/ARCHITECTURE.md`: current system architecture and boundaries
- `docs/adr/`: accepted architectural decisions
- `tasks/`: implementation task specifications

When documents disagree, stop and resolve the contradiction rather than guessing.

## Workflow for non-trivial tasks

Before coding:

1. Read the relevant project docs and task specification.
2. Inspect existing code and affected modules.
3. Produce an implementation plan.
4. Identify edge cases, failure modes, and security, concurrency, and data-consistency risks.
5. Implement only after the scope and boundaries are clear.

After coding:

1. Compile/build and run relevant tests.
2. Review the diff and verify no unrelated files changed.
3. Report changed files, design decisions, tests and results, known limitations, and remaining risks.

## Architecture and code quality

### Database design gates

Follow `docs/database/DESIGN_GATES.md` before any database work. This user-approved
policy supersedes earlier task permission to design or extend core tables.

- GREEN: implement `users` and session/refresh-token persistence using conventional patterns. Existing `auth_sessions` fulfills the session role; do not create duplicate tables just to change names.
- YELLOW: proposals only for the nine tables listed in the policy; require explicit review approval before migrations, JPA entities, or runtime implementation.
- RED: no final schema, Flyway changes, or JPA entities until per-table workload, queries, writes, volume, consistency/concurrency, and retention requirements have been supplied and the ordered design process completed.
- Existing `websites` and `scans` in V1 are historical foundation code, frozen for further schema design. Preserve applied migrations and existing data; their presence is not approval of a final workload-driven design.

- Tuân theo ba deployable đã được duyệt trong `docs/adr/ADR-005-tach-crawler-thanh-microservice.md`: Spring Boot Control Plane, bản fork Go Crawler và Playwright Capture Worker cô lập. Giữ Control Plane có modular boundaries nội bộ. Service mới hoặc thay đổi boundary tiếp theo phải có ADR riêng.
- Do not add Kafka, Redis, Kubernetes, or other infrastructure for demonstration.
- Không mặc định nhập ClickHouse, SQLite auth store, in-memory queue hoặc Rod renderer của CrawlObserver vào kiến trúc WebLens. Giữ provenance AGPL và đặt crawler fork trong repository boundary riêng.
- Explain every new dependency. Prefer explicit code and responsibilities over clever or premature abstractions.
- Avoid generic base services and repositories unless a concrete repeated need exists.
- Prefer constructor injection. Validate external input. Use migrations for schema changes.
- Keep API contracts separate from persistence entities. Test important domain behavior.

## Security and Git

- Never commit secrets or log sensitive information.
- Treat crawled HTML, headers, metadata, and AI-retrieved content as untrusted.
- Address SSRF and prompt-injection risks in crawler and AI work.
- Keep changes scoped; do not make unrelated refactors or overwrite user changes.

For significant implementation tasks, finish with **What the developer should understand before accepting this code**, explaining the important Java, backend, and system-design concepts used.
