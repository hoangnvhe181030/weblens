# V1 and V1.5 Requirements

Requirements describe observable behavior, not implementation details. Authorization applies to every user-owned resource.

## SYS-001 — Bàn giao công việc bền vững giữa các service

**Mô tả:** Control Plane, Crawler Service và Capture Worker giao tiếp qua contract
có version mà không làm mất công việc đã chấp nhận khi timeout, duplicate delivery,
service restart hoặc network partition ngắn hạn.

**Tiêu chí chấp nhận:** Scan/capture request được persist trước khi trả accepted;
dispatch và event consumer idempotent; trạng thái người dùng thấy không quay ngược;
terminal event có thể reconcile; mỗi request có correlation ID; service outage
được thể hiện bằng queue/stale/failure có phân loại thay vì báo thành công giả.

**Trường hợp biên:** Commit thành công nhưng dispatch thất bại, command trùng,
event đến sai thứ tự, callback thất bại, worker hết lease và service phục hồi sau
restart.

## SYS-002 — Cô lập quyền sở hữu dữ liệu

**Mô tả:** Mỗi service chỉ sửa dữ liệu thuộc ownership của mình và xác thực mọi
giao tiếp nội bộ.

**Tiêu chí chấp nhận:** Không service nào đọc/ghi trực tiếp bảng private của
service khác; không có cross-service foreign key/transaction; opaque identifiers
được validate; caller service được authenticate/authorize; credential người dùng
không được chuyển cho crawler hoặc browser worker.

**Trường hợp biên:** ID hợp lệ nhưng sai owner, replay command, credential rotation,
service account bị revoke và dữ liệu projection lệch source.

## SYS-003 — Analytical ingestion bền vững

**Mô tả:** Crawler và Capture Worker đưa analytical facts vào ClickHouse theo
batch mà không làm mất accepted result khi ClickHouse chậm, unavailable hoặc trả
acknowledgement không rõ ràng.

**Tiêu chí chấp nhận:** PostgreSQL staging bền vững trước external insert; delivery
at-least-once nhưng report không double count; có bounded backpressure; scan/capture
report công bố watermark/freshness; lifecycle/authorization không phụ thuộc vào
ClickHouse merge; backlog có thể reconcile sau restart.

**Trường hợp biên:** ClickHouse success nhưng PostgreSQL ack thất bại, duplicate
batch, version đến sai thứ tự, `too many parts`, disk pressure, retention/delete
đồng thời với ingest và ClickHouse outage kéo dài.

## AUTH-001 — User authentication

**Description:** A user can establish and end an authenticated session and access only their own data.

**Acceptance criteria:** Valid credentials authenticate; invalid credentials return a generic failure; protected operations reject unauthenticated callers; sessions/tokens can be invalidated according to the selected authentication design.

**Important edge cases:** Repeated failures, disabled users, expired sessions, credential enumeration, concurrent sessions.

## SITE-001 — Register a website

**Description:** An authenticated user can register a normalized HTTP(S) website target that they are authorized to scan.

**Acceptance criteria:** The system validates syntax and allowed protocols, preserves a clear canonical target, prevents unintended duplicates per user, and never fetches the URL as a side effect of validation unless explicitly designed.

**Important edge cases:** Internationalized domains, default ports, fragments, credentials in URLs, DNS/private-address targets, redirects, and ownership/authorization policy.

## SITE-002 — Manage registered websites

**Description:** A user can list and view their websites and stop using a website without affecting another user.

**Acceptance criteria:** Results are scoped by user, pagination is bounded, and deletion/archival behavior for historical scans is explicit before implementation.

**Important edge cases:** Websites with active scans, historical retention, concurrent updates.

## SCAN-001 — Create a bounded scan

**Description:** A user can request a scan of one registered website with enforced limits.

**Acceptance criteria:** The request creates one identifiable scan, captures its effective configuration, begins from the registered target, and refuses unauthorized or unsafe targets. Repeated client submission has a defined idempotency policy.

**Important edge cases:** Duplicate requests, scan already running, DNS changes, unreachable origin, invalid certificates, and configured page/time limits.

## SCAN-002 — Crawl and collect measurements

**Description:** The system visits a limited number of eligible pages and stores basic response/page/performance measurements with collection metadata.

**Acceptance criteria:** Same-site and page limits are enforced; redirects and every outbound connection are safety-checked; timeouts and response-size limits apply; each page records success or a classified failure; partial results remain distinguishable from complete results.

**Important edge cases:** Cycles, duplicate/canonical URLs, redirect loops, robots policy decision, content-type mismatch, compressed bodies, malformed HTML, very large pages, and target rate limiting.

## SCAN-003 — Observe scan progress

**Description:** A user can retrieve current scan state and bounded progress details.

**Acceptance criteria:** States are monotonic according to the documented lifecycle; terminal success, partial success, cancellation, and failure are distinguishable; progress never exceeds configured bounds.

**Important edge cases:** Worker/application restart, stale scan, late page result, concurrent polling.

## REPORT-001 — View scan results

**Description:** A user can view scan summary, page outcomes, collected metrics, and findings.

**Acceptance criteria:** Results are authorized, paginated where needed, label missing/failed measurements, and include enough collection context to interpret values.

**Important edge cases:** Partial scans, deleted website, measurement-version changes, no successful pages.

## CAP-001 — Create a browser capture

**Description:** A user can request a browser capture for an eligible page from one of their scans.

**Acceptance criteria:** Ownership is enforced, one identifiable capture job is persisted before execution, and its state is distinguishable as queued, running, completed, or failed.

**Important edge cases:** Duplicate requests, ineligible or failed pages, concurrent captures, deleted websites, and worker unavailability.

## CAP-002 — Capture rendered evidence

**Description:** An isolated Playwright/Chromium worker captures final rendered HTML/DOM, a screenshot, eligible resources, and bounded network metadata.

**Acceptance criteria:** Browser timeout and resource limits apply; the final URL and collection context are recorded; API-process stability does not depend on browser-process stability; sensitive headers and payloads are excluded by default.

**Important edge cases:** Failed scripts, never-idle pages, popups/downloads, large resources, unsupported content, cross-origin resources, redirects, and malicious page code.

## CAP-003 — Store and inspect snapshots

**Description:** A user can inspect snapshot metadata, screenshot evidence, and captured-resource metadata, while large objects remain in S3-compatible object storage.

**Acceptance criteria:** PostgreSQL stores authorized snapshot/object metadata and stable object references; ClickHouse stores bounded redacted network/resource analytical facts; content hashes support safe deduplication; captured HTML and JavaScript are never executed by the viewer.

**Important edge cases:** Missing objects, duplicate hashes, retention/deletion, partial captures, long URLs, and unavailable screenshots.

## CAP-004 — Tạo và tải bản clone tĩnh một trang

**Mô tả:** Mỗi browser capture mới tạo best-effort một ZIP clone tĩnh của đúng
một trang từ HTML sau render và resource body đủ điều kiện trong cùng Playwright
session.

**Tiêu chí chấp nhận:** Chỉ CSS, JavaScript, image và font same-origin được đóng
gói; URL→path và rewrite ổn định; manifest versioned công bố file bị thiếu hoặc
truncate; giới hạn 100 file, 50 MiB input và 64 MiB archive; archive private hết
hạn sau 7 ngày; owner tải qua Control Plane dưới dạng attachment sau kiểm tra
size/SHA-256. Clone `PARTIAL` hoặc `FAILED` không làm mất capture hợp lệ, và UI
không preview hay thực thi HTML/JavaScript trong archive.

**Trường hợp biên:** URL chỉ khác query, path Unicode/traversal, tên dành riêng
Windows, collision, CSS URL tương đối, `srcset`, external origin, body hết budget,
worker mất lease, upload thành công nhưng commit thất bại, object hết hạn hoặc bị
thay đổi và capture cũ chưa có reconstruction.

## Deferred requirements

Scan comparison và regression detection bắt đầu ở V2; AI root-cause analysis ở
V3; scheduling/alerts ở V4. Kafka/Redis coordination, multi-region crawler,
service decomposition bổ sung, RAG, ML anomaly detection và cloud orchestration
thuộc V5-V8. Ba deployable trong ADR-005 và durable handoff giữa chúng là yêu cầu
V1/V1.5, không còn là phần deferred.
