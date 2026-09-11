# Task

## Goal

Build an original Vietnamese React and TypeScript frontend demonstration for WebLens, informed by the layout rhythm of Better Stack's website-monitoring landing page but implemented with WebLens-owned code, branding, copy, illustrations, and mock data.

## Why

WebLens needs an editable frontend that communicates the approved V1 and V1.5 product flow and validates the landing-page and dashboard experience before backend implementation begins.

## Requirements

- Initialize a Vite React application with TypeScript strict mode and a committed lockfile.
- Implement the public landing page, mock authentication, website list/detail, scan progress/report, page evidence, capture flow, and snapshot viewer.
- Use Vietnamese copy and responsive, accessible interaction patterns.
- Represent loading, error, empty, partial, cancelled, and success states.
- Treat V2-V8 as a future roadmap, never as active functionality.
- Keep the Better Stack `pagesource` capture in `.reference/` and out of the application build.

## API contract

No network API is introduced. Typed frontend service interfaces return Promises and stable mock error objects so a later Spring Boot adapter can replace the mock implementation.

## Data changes

No database changes. Non-sensitive demo state may use versioned local storage; passwords, tokens, secrets, and arbitrary crawled bodies must not be persisted.

## Edge cases

- Invalid or non-HTTP(S) URLs.
- Direct navigation to unknown or missing entities.
- Empty website and scan lists.
- Partial, failed, and cancelled scans.
- Failed capture jobs.
- Long URLs and bounded failure text.
- Mobile table and navigation behavior.
- Reduced-motion preference.

## Security considerations

- Never inject captured HTML or scripts into the DOM.
- Do not use `dangerouslySetInnerHTML`.
- Client URL validation is convenience only and must not imply backend SSRF protection.
- Do not include Better Stack tracking, APIs, trademarks, testimonials, or proprietary assets.
- Do not place secrets or production credentials in the client bundle.

## Concurrency / consistency considerations

Mock scan and capture transitions must follow allowed state machines, prevent contradictory terminal states, and clean up timers when views unmount. Production concurrency, idempotency, and durable state remain backend concerns.

## Implementation plan

1. Capture and inventory the reference page.
2. Align product documentation to the approved version boundaries.
3. Initialize Vite, routing, tests, and styling foundations.
4. Add domain types, deterministic mock services, and demo state.
5. Build the landing page and application routes.
6. Add responsive, accessibility, security, and encoding safeguards.
7. Run tests, production build, browser smoke checks, and final scope review.

## Tests

- Unit tests for URL validation and state transitions.
- Component tests for form validation and key view states.
- Flow tests for landing to registration to scan to snapshot.
- TypeScript, lint, production build, responsive browser smoke, and keyboard/focus review.
- UTF-8 and mojibake scan for Vietnamese source files.

## Definition of Done

- Every route in the approved design is navigable and functional with mock data.
- V1/V1.5 product claims match the SRS and V2-V8 are labeled as planned.
- The application is usable on mobile and desktop with keyboard-visible focus.
- No Better Stack runtime dependency or copied branded asset ships.
- Typecheck, lint, tests, production build, encoding check, and browser smoke checks pass.

## What I should understand before accepting this implementation

- Why domain types and service interfaces are separated from presentation components.
- Which security guarantees cannot be implemented or proven in a frontend mock.
- How scan and capture state machines prevent ambiguous UI states.
- Why the `pagesource` output is research material rather than recoverable application source.
