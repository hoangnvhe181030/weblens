# Frontend Conventions

Follow the root `AGENTS.md` and current API guidance.

- Enable TypeScript strict mode; avoid `any` unless a boundary is documented and narrowed immediately.
- Give components one clear responsibility. Keep business rules out of presentational components.
- Isolate HTTP details, contract types, authentication handling, and error normalization in an API-client layer.
- Model loading, error, empty, stale, and success states explicitly.
- Use semantic HTML, keyboard-operable controls, visible focus, labels, and sufficient contrast.
- Test important user behavior and state transitions. Prefer tests that observe the UI as a user does.
- Validate and escape untrusted content. Do not render crawled HTML directly.
- Introduce UI libraries or abstractions only when they remove a demonstrated maintenance burden.
