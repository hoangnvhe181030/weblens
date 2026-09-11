# WebLens Frontend Design

## 1. Purpose

This specification defines an editable React and TypeScript frontend for WebLens. The public landing page may use the layout rhythm and product-story structure of Better Stack's website-monitoring page as visual research, while all implementation, branding, copy, product illustrations, and sample data remain original to WebLens.

The deliverable is a frontend demonstration only. It presents the WebLens V1 and V1.5 experience with mock services and does not implement authentication, crawling, browser capture, persistence, Server-Sent Events, or any Better Stack integration.

## 2. Sources of Truth

For product scope, `WebLens_SRS_V1_V1.5.docx` and the user-approved V2-V8 roadmap supersede older repository statements that place scan comparison, regression detection, or AI explanation in V1.

- V1: authentication, website management, bounded asynchronous scanning, deterministic page evidence and findings, progress, cancellation, reports, and history.
- V1.5: isolated browser capture, rendered snapshot evidence, captured resources, network metadata, object-storage concepts, hashing, and snapshot inspection.
- V2: scan history comparison and deterministic regression detection.
- V3: evidence-grounded AI root-cause analysis.
- V4: scheduled scanning, alerts, and monitoring.
- V5: distributed queues and workers when measured scale requires them.
- V6: retrieval and question answering over authorized WebLens data.
- V7: ML-based anomaly detection.
- V8: production cloud operations, observability, scaling, and optional orchestration.

The frontend must not present V2-V8 capabilities as currently available. They appear only in an explicitly labeled roadmap section.

## 3. Reference Capture Policy

The existing `pagesource` virtual environment will capture `https://betterstack.com/website-monitoring` into a dedicated reference directory. The capture is research input, not production source code.

The implementation must not copy or ship Better Stack trademarks, logos, customer testimonials, analytics, tracking scripts, sign-up integrations, proprietary copy, or downloaded third-party assets. It must not call Better Stack APIs or depend on Better Stack at runtime. The reference capture should be excluded from application builds and version control.

## 4. Technical Architecture

Create a Vite React application under `frontend/` with TypeScript strict mode. Use React Router for navigation. Do not introduce a component framework; components and styles should be owned by WebLens unless an added dependency removes a concrete maintenance burden.

The frontend contains two areas:

1. A public marketing site describing WebLens V1 and V1.5.
2. An authenticated-looking demonstration application backed by typed mock services.

Suggested boundaries:

- `app/`: routing, providers, shell, and application bootstrap.
- `features/marketing/`: landing-page sections and marketing copy.
- `features/auth/`: mock login and registration forms.
- `features/websites/`: website list and detail views.
- `features/scans/`: scan creation, progress, reports, and page results.
- `features/captures/`: capture state and snapshot viewer.
- `domain/`: framework-independent TypeScript domain types.
- `services/`: mock service interfaces and implementations.
- `components/`: genuinely shared visual primitives only.
- `styles/`: design tokens, global rules, motion, and responsive utilities.

Presentation components must not own domain state transitions. HTTP and authentication details will later be isolated behind the same service interfaces when the Spring Boot API exists.

## 5. Routes

The initial route set is:

- `/`: public WebLens landing page.
- `/login`: mock login.
- `/register`: mock registration.
- `/app/websites`: website overview and list.
- `/app/websites/:websiteId`: website detail and scan history.
- `/app/scans/:scanId`: scan progress or completed report.
- `/app/pages/:scanPageId`: page evidence, metrics, findings, and capture action.
- `/app/snapshots/:snapshotId`: rendered snapshot and captured-resource viewer.

Unknown routes show a branded not-found page. Application routes use an application shell with responsive navigation. Direct navigation and refresh must work in the local development and preview environments.

## 6. Visual Direction

The interface should feel technical, calm, and evidence-oriented rather than resembling a generic SaaS template. Use a warm off-white canvas, deep blue-black typography, an electric green primary accent, and orange for warnings. Typography should combine a distinctive display face with a highly legible body face, using locally bundled or responsibly loaded fonts.

The memorable visual motif is an evidence trail: URLs, scan nodes, measurements, findings, and captured resources connect through thin lines and status pulses. Product illustrations are built from WebLens components and sample data rather than screenshots or assets from Better Stack.

Motion is restrained and informative: staged entrance on the landing page, live-looking progress transitions, and clear hover and focus feedback. All motion respects `prefers-reduced-motion`.

## 7. Public Landing Page

The landing page contains:

1. Header with product navigation, login, and registration actions.
2. Hero explaining bounded website scanning and evidence-based reports, with an HTTP/HTTPS URL input that can begin a demo flow.
3. A product illustration showing a scan progressing through discovered, processed, successful, and failed pages.
4. Sections for safe bounded crawling, deterministic findings, realtime progress, and scan reports.
5. A V1.5 browser-capture section covering rendered HTML, screenshots, resource inventory, and network metadata.
6. A concise Register to Scan to Report to Capture workflow.
7. A roadmap section that clearly labels V2-V8 as planned capabilities.
8. Final call to action and a WebLens footer.

Marketing claims must be supported by the approved product scope. Do not invent customer counts, reliability percentages, monitoring locations, pricing, testimonials, or production availability.

## 8. Demonstration Application

### 8.1 Authentication

Login and registration validate required fields and show mock loading, success, and generic authentication failure states. They do not persist passwords or imply production security. Successful submission navigates to the website overview.

### 8.2 Website Overview and Detail

The overview displays registered sites, latest scan status, finding counts, and last activity. It supports a mock add-website flow and explicit loading, empty, error, and success states.

Website detail displays normalized target information and newest-first scan history. Future comparison controls must not appear as an active V1 feature.

### 8.3 Scan Progress and Report

Starting a scan creates a demo scan and advances through `QUEUED`, `RUNNING`, and a terminal state. The screen displays bounded progress counters, current activity, an event timeline, and cooperative cancellation.

Completed reports show summary metrics, page outcomes, deterministic findings, filters, and pagination-style controls. Partial, failed, and cancelled scans must not look complete.

### 8.4 Page Evidence and Capture

Page detail displays HTTP evidence, response timing, title and H1 availability, resource counts, and deterministic findings. A capture action creates a mock V1.5 job that advances from `QUEUED` to `RUNNING` to `COMPLETED` or `FAILED`.

### 8.5 Snapshot Viewer

The viewer displays a WebLens-owned mock screenshot, capture metadata, a resource-type summary, and a filterable network-resource list with URL, status, type, content type, size, and duration. It must never execute or inject captured HTML or JavaScript.

## 9. Domain and Mock Data

Define explicit domain types for `Website`, `Scan`, `ScanPage`, `Finding`, `CaptureJob`, `PageSnapshot`, and `CapturedResource`. State values follow the SRS:

- Scan: `QUEUED`, `RUNNING`, `CANCEL_REQUESTED`, `COMPLETED`, `PARTIAL_SUCCESS`, `FAILED`, `CANCELLED`.
- Capture: `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`.

Mock services return Promises with short deterministic delays so views can demonstrate loading and transitions without flaky tests. Seed data represents multiple conditions, including healthy, warning, partial, failed, cancelled, empty, and stale-looking states.

Local storage may retain non-sensitive demo preferences and seeded application state. It must not store passwords, tokens, captured secrets, or arbitrary target content.

## 10. Validation and Security Boundaries

Client-side URL validation accepts only syntactically valid HTTP and HTTPS URLs. The interface must explain that browser validation is convenience only; DNS resolution, private-address rejection, redirect validation, DNS-rebinding defenses, response limits, and authorization belong to the backend.

Crawled or captured evidence is rendered as escaped text. Avoid `dangerouslySetInnerHTML`. Long URLs and failure messages are bounded and visually wrapped. No production secret or external API key is required by the frontend.

## 11. Accessibility and Responsive Behavior

Use semantic landmarks, associated labels, meaningful headings, keyboard-operable controls, visible focus states, sufficient color contrast, and status text that does not rely on color alone. Async changes use appropriate live-region behavior without excessive announcements.

Desktop application navigation becomes a mobile drawer or compact navigation pattern. Tables gain deliberate responsive alternatives such as horizontal containment or stacked records. The landing page and every route must remain usable at common mobile, tablet, and desktop widths.

## 12. Error and Empty States

Each data-driven route defines loading, error, empty, stale, partial, and success states where applicable. Mock service failures use a stable user-facing error shape and offer a safe retry action. Missing route entities show a scoped not-found state rather than crashing the application.

## 13. Verification

Verification includes:

- Unit tests for URL validation, formatters, and permitted state transitions.
- Component tests for forms and loading, error, empty, partial, and cancelled states.
- User-flow tests covering landing to registration, website overview, scan progress/report, page detail, capture, and snapshot viewer.
- Production build with TypeScript checks.
- Responsive smoke checks at representative mobile and desktop widths.
- Keyboard and focus-order review for navigation, forms, filters, and dialogs.
- Dependency and output review to confirm no Better Stack tracking, APIs, trademarks, testimonials, or copied assets ship in the build.

## 14. Known Limitations

This deliverable is not a recovered React or Next.js source tree from Better Stack. `pagesource` can capture browser-delivered resources but cannot reconstruct original component boundaries, backend behavior, source maps that were not published, or private APIs.

The demo does not prove crawler correctness, SSRF protection, authentication security, SSE delivery, worker isolation, storage behavior, or production reliability. Those require later backend and integration tasks.

## 15. Acceptance Criteria

- A developer can install dependencies, run the frontend, and navigate every documented route.
- Landing and application views use original WebLens branding and Vietnamese copy.
- The interface is editable React and TypeScript source, not patched downloaded HTML.
- Primary V1 and V1.5 journeys are demonstrable with typed mock data.
- V2-V8 appear only as future roadmap items.
- No Better Stack runtime dependency, tracking, logo, testimonial, or proprietary asset is included.
- Loading, error, empty, partial, cancelled, and success states are represented.
- Production build and relevant tests pass.
- Layout remains usable on mobile and desktop and supports keyboard navigation.
