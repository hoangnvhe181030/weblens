# Backend Conventions

Follow the root `AGENTS.md` and current ADRs.

- Use idiomatic Java and Spring Boot. Prefer constructor injection and immutable state.
- Organize code by business module, not global technical-layer folders. Module internals should not be imported across boundaries; expose deliberate application interfaces.
- Separate REST DTOs, domain concepts, and persistence entities when their responsibilities differ. Never expose persistence entities directly as API contracts.
- Put transaction boundaries in application services around complete use cases. Keep transactions short and avoid remote calls inside them.
- Validate request syntax at the API boundary and enforce business invariants in domain/application code.
- Return consistent problem details. Translate expected failures explicitly; do not swallow exceptions or expose internals.
- Keep REST resources and status codes consistent with `docs/API_GUIDELINES.md`.
- Change schema only through versioned Flyway migrations. Never edit an applied migration.
- Test important domain behavior, authorization, persistence mappings/queries, API contracts, and failure paths. Use Testcontainers where real PostgreSQL behavior matters.
- Design state transitions and updates with concurrent requests in mind. Make consistency guarantees explicit.
- Avoid N+1 queries and unbounded reads. Add indexes for demonstrated query patterns and verify plans when queries become important.
- Set explicit connection, request, and read timeouts for external calls. Retries must be bounded, observable, safe, and justified; never add magic retry loops.
- Preserve exception causes and add useful context without logging secrets or untrusted bodies.
