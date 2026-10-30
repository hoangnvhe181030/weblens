# WebLens — Hồ sơ dự án để trao đổi hướng phát triển với ChatGPT

Ngày tổng hợp: **08/10/2026**, múi giờ UTC+7.

## 1. Phạm vi và cách sử dụng hồ sơ

Đây là hồ sơ của **WebLens trong thư mục Pet_project**, không phải danh sách mọi dự án trên máy hoặc mọi repository của chủ dự án. Backend, frontend, crawler và capture-worker là các thành phần của cùng một sản phẩm, không phải bốn sản phẩm độc lập.

Hồ sơ được tổng hợp từ tài liệu sản phẩm, kiến trúc, quyết định kỹ thuật, báo cáo kiểm thử/triển khai và đối chiếu cấu trúc cùng một số luồng mã nguồn hiện tại. Lần tổng hợp này không chạy lại bộ test, không truy cập production, không đo tải mới và không sửa runtime.

Hãy luôn phân biệt bốn mức bằng chứng:

- **Có trong mã nguồn:** có implementation nhưng không mặc nhiên đã chạy đúng trên production.
- **Có bằng chứng kiểm thử:** đã được kiểm tra trong môi trường, phạm vi và thời điểm cụ thể.
- **Đã triển khai theo biên bản:** có hồ sơ rollout; không phải xác nhận dịch vụ vẫn hoạt động tại thời điểm đọc hồ sơ này.
- **Lộ trình/đề xuất:** chưa được coi là tính năng đang có.

Workspace có nhiều thay đổi chưa commit và file mới. Không đồng nhất checkout hiện tại, commit công khai và toàn bộ binary đang chạy trên VPS.

## 2. Dự án là gì?

WebLens là nền tảng hỗ trợ kỹ sư kiểm tra website bằng dữ liệu và bằng chứng kỹ thuật. Người dùng đăng ký website, chạy crawl có giới hạn, theo dõi tiến độ, xem lỗi và phép đo từng trang, chụp nội dung sau khi JavaScript chạy, hoặc tạo bản clone tĩnh để tải xuống.

Tầm nhìn dài hạn là giúp developer trả lời:

1. Website đã thay đổi điều gì?
2. Thay đổi nào gây suy giảm chất lượng hoặc phát sinh lỗi?
3. Bằng chứng nào hỗ trợ kết luận đó?
4. Nên điều tra hoặc sửa điều gì trước?

**Hiện tại hệ thống chủ yếu thu thập và phân tích theo luật xác định. Chưa có AI phân tích nguyên nhân, so sánh lịch sử hoàn chỉnh hay monitoring theo lịch như tính năng đã triển khai.** Tên gọi “AI-assisted” mô tả định hướng, không chứng minh đã tích hợp LLM.

Người dùng mục tiêu là developer cá nhân, freelancer và nhóm nhỏ quản lý nhiều website. Đây vẫn là giả thuyết sản phẩm. Chưa có dữ liệu được cung cấp để kết luận về khách hàng trả phí, doanh thu, retention, mức sẵn sàng trả tiền hoặc product-market fit.

Một quyết định sản phẩm còn mở: WebLens sẽ ưu tiên **kiểm tra và theo dõi chất lượng website** hay **thu thập giao diện/Design Clone**? Hai nhánh dùng chung nền tảng thu thập nhưng phục vụ nhu cầu và tiêu chí thành công khác nhau. Đây là câu hỏi để thảo luận, chưa phải thay đổi định hướng đã được duyệt.

## 3. Những chức năng đã có implementation

### 3.1. Tài khoản và phân quyền

- Đăng ký, đăng nhập, lấy thông tin người dùng và đăng xuất.
- Mật khẩu được băm BCrypt; access JWT và refresh rotation.
- Refresh cookie HttpOnly, SameSite Strict; Secure theo cấu hình; bảo vệ CSRF cho refresh/logout.
- Frontend giữ access token trong RAM và phối hợp các request refresh đồng thời.
- Website, scan, report, capture, clone và artifact đều phải kiểm tra owner. Biết ID không có nghĩa được truy cập.
- Redis quản lý phiên JWT theo ADR-019, được ghi nhận đã triển khai ngày 05/10/2026. Mỗi access check hợp lệ cần phiên Redis còn hiệu lực và một truy vấn PostgreSQL kiểm tra phiên chưa bị thu hồi/hết hạn.
- Logout thu hồi access/refresh của cùng phiên; không tự đăng xuất những phiên độc lập khác. Snapshot Redis cũ không được làm sống lại phiên đã bị PostgreSQL thu hồi.
- Redis hoặc session ledger lỗi thì trả lỗi dịch vụ, không hạ xuống JWT-only. Phiên Redis bị mất thì cần đăng nhập lại; không tự phục dựng từ PostgreSQL.
- Mã nguồn hiện có giới hạn auth đơn node: 60 request/IP/phút và tối đa bốn auth request đồng thời. Không coi đây là distributed limiter hoặc khóa tài khoản chống mọi kiểu tấn công.

Không có bằng chứng đã triển khai đầy đủ xác minh email, quên/reset mật khẩu, OAuth đăng nhập WebLens, MFA, team/organization, RBAC doanh nghiệp hoặc billing. Phiên đăng nhập website bên ngoài để clone không phải OAuth login của WebLens.

### 3.2. Quản lý website

- Đăng ký URL HTTP(S), chuẩn hóa target và kiểm tra input.
- Danh sách website theo tài khoản, phân trang, xem chi tiết, đổi tên và archive.
- Xem scan gần nhất và lịch sử scan.
- Có API tổng hợp dashboard; giao diện chính hiện dẫn người dùng vào danh sách website.
- Archive website không đồng nghĩa xóa tức thì mọi dữ liệu lịch sử ở mọi datastore.

### 3.3. Scan và HTTP crawler

- Tạo scan bất đồng bộ với cấu hình giới hạn được chụp lại tại thời điểm tạo.
- Có idempotency để việc gửi lại request/command hợp lệ không tạo công việc trùng.
- Khám phá liên kết từ HTML, chuẩn hóa URL, deduplicate và giới hạn phạm vi.
- Giới hạn số trang, độ sâu, thời gian, response bytes, retry, concurrency và tốc độ theo host.
- Kiểm tra an toàn URL, DNS/IP, kết nối và redirect để chống SSRF.
- Frontier, execution, retry và lease được lưu bền vững trong PostgreSQL.
- Theo dõi tiến độ, yêu cầu hủy, phân biệt thành công đầy đủ, thành công một phần và thất bại.
- Trạng thái gồm QUEUED, RUNNING, CANCEL_REQUESTED, COMPLETED, PARTIAL_SUCCESS, FAILED và CANCELLED.
- Control Plane không được tự kết luận crawler đã dừng chỉ vì người dùng bấm hủy. Crawler xác nhận trạng thái cuối; completion đã xảy ra trước khi xử lý hủy phải được bảo toàn.

UI dùng polling, không phải một hệ thống realtime dựa trên SSE/WebSocket. Crawler hiện không cưỡng chế robots.txt theo ADR-011; không được quảng bá là tuân thủ robots.txt hoặc có quyền vượt access control. Sitemap/sitemap-index discovery và hỗ trợ Retry-After còn được ghi nhận là khoảng trống trong audit; lần đọc hiện tại không tìm thấy đường triển khai tương ứng dưới crawler/internal.

### 3.4. Kết quả và bằng chứng từng trang

Những nhóm dữ liệu có trong contract/source bao gồm:

- URL, HTTP status, outcome, response bytes và thời gian HTTP.
- Title, description, keywords, canonical, meta robots và X-Robots-Tag.
- Ngôn ngữ trang, indexability, headings, hreflang, Open Graph và structured-data summary.
- Thống kê link, image, script và stylesheet.
- Findings có code, severity, rule/version và bằng chứng.

Các luật như thiếu title, description, H1 hoặc alt text chỉ là kiểm tra xác định trên dữ liệu thu được. Chúng không tương đương một sản phẩm SEO, accessibility hoặc security audit đầy đủ.

Website/history dùng phân trang theo số trang; danh sách page evidence dùng cursor. Tổng số URL/lỗi/findings của scan phải tính trên toàn bộ tập dữ liệu được phép đọc, không suy ra từ một trang kết quả. Báo cáo phải phân biệt dữ liệu thiếu, scan partial và analytics chưa kịp công bố.

### 3.5. Browser capture

Người dùng có thể yêu cầu capture một trang đủ điều kiện trong scan của mình. Worker browser riêng thu:

- HTML/DOM sau render.
- Screenshot.
- Resource đủ điều kiện và network metadata có giới hạn, được loại bỏ dữ liệu nhạy cảm theo policy.
- Content hash và ngữ cảnh đo; có phép đo browser như LCP/CLS/TTFB cùng trạng thái khi không thu được dữ liệu.

Camoufox là engine mặc định; Chromium qua Playwright là lựa chọn thủ công. Có snapshot viewer và tải tài nguyên sau kiểm tra owner. Không chạy HTML/JavaScript thu thập được trên origin của ứng dụng WebLens.

Phép đo từ browser tự động không phải dữ liệu trải nghiệm thực của toàn bộ người dùng, cũng không mặc nhiên là điểm Lighthouse hoặc chứng nhận Core Web Vitals.

### 3.6. Clone tĩnh một trang

Browser capture tạo best-effort ZIP từ HTML sau render và CSS/JavaScript/image/font same-origin đủ điều kiện trong cùng phiên. Có rewrite đường dẫn, manifest, kiểm tra size/hash và thời hạn tải.

Giới hạn tài liệu hóa: 100 file, 50 MiB input, 64 MiB archive và retention tải bảy ngày. Clone PARTIAL/FAILED không làm mất một capture evidence vốn hợp lệ.

### 3.7. Design Clone nhiều trang

Hành trình hiện tại:

1. Người dùng nhập URL, không phải tự chọn scan có sẵn.
2. Control Plane resolve/tạo website và tạo một scan mới cho request mới.
3. Crawler khám phá URL.
4. Capture Worker chọn trang đại diện theo chức năng, route template và layout; loại biến thể không cần thiết theo policy.
5. Worker render ứng viên, khử trùng asset, rewrite navigation và đóng gói archive/manifest.
6. Người dùng theo dõi render, xử lý partial/failure/cancellation và tải artifact thuộc quyền mình.

Mục tiêu là giữ **thiết kế và trang chức năng đại diện**, không sao lưu mọi URL khác nội dung hoặc locale. Login/register/forgot-password không được gộp thành một trang chỉ vì giao diện giống nhau. Design Clone không tạo screenshot trong archive; screenshot evidence thuộc luồng capture riêng.

Render monitor phân biệt discovered/rendered/packaged và giai đoạn ingest/publish. Render đạt 100% không có nghĩa archive đã được công bố thành công.

Có phiên browser tương tác qua screenshot/action cho người dùng tự đăng nhập hoặc nhập OTP. Cookie nằm trong RAM của browser context, tối đa một phiên/process, TTL mười phút; worker restart làm mất phiên. Có bounded scroll/click/hover cho nội dung động. Không thiết kế kho lưu mật khẩu/cookie bên thứ ba.

Giới hạn quan trọng:

- Không khôi phục source React/Vue/Java gốc, backend, database hoặc API riêng của website.
- Không cam kết archive chạy đầy đủ offline hay giống tuyệt đối website gốc.
- Same-origin policy có thể loại tài nguyên CDN/bên thứ ba cần cho giao diện.
- Không bảo đảm vượt CAPTCHA, WAF hoặc Cloudflare; archive có thể chứa challenge dù job đã publish.
- Download-only; WebLens không host hoặc thực thi bản clone trên origin của mình.

## 4. Kiến trúc và công nghệ

| Thành phần | Công nghệ chính | Trách nhiệm |
| --- | --- | --- |
| Frontend | React 19, TypeScript, Vite, React Router | UI, auth state, polling, xem evidence/capture/clone |
| Control Plane | Java 21, Spring Boot 3.5.16, Spring Security, JPA/Hibernate, Flyway | Auth, ownership, public API/lifecycle, điều phối, report facade |
| Crawler | Go, pgx, goquery, ClickHouse client | HTTP crawl, frontier, host scheduling, parsing/findings, publication |
| Capture Worker | Node.js/TypeScript, Playwright, Camoufox | Browser render, snapshot, resource, phiên tương tác, archive |
| PostgreSQL | Ba database logic/role theo service | State, session ledger, command/event, lease, staging |
| ClickHouse | Analytics | Page metrics, findings, links, network/resource facts |
| Redis | Auth sessions theo ADR-019 | Kiểm tra phiên access/refresh; không làm queue crawl |
| S3-compatible storage | MinIO local; R2 theo hồ sơ production | Screenshot, HTML, resource bodies, archive |
| Public edge | Caddy | HTTPS, frontend tĩnh và reverse proxy |

Phiên bản trên là từ manifest/tài liệu đã đọc, không phải kết quả kiểm kê dependency của từng binary production hôm nay.

### Ranh giới chính

Ba deployable ứng dụng được duyệt là **Spring Boot Control Plane, Go Crawler và Capture Worker**. Frontend là ứng dụng client; PostgreSQL/ClickHouse/Redis/object storage là hạ tầng, không phải những microservice nghiệp vụ mới.

Frontend chỉ gọi Control Plane. Control Plane authorize rồi gọi contract nội bộ của Crawler/Capture. Mỗi service sở hữu database, role và migration của mình; không đọc/ghi trực tiếp bảng private của service khác. ID truyền qua API là opaque identifier, không tạo foreign key xuyên service.

Control Plane vẫn modular bên trong với các nhóm auth, website, scan, capture, siteclone, dashboard và messaging. Chưa tách auth, website hay report thành deployable độc lập.

### Luồng xử lý bền vững

1. Control Plane lưu scan và command outbox trong cùng transaction trước khi trả accepted.
2. Dispatcher gửi REST command; retry giữ cùng identity.
3. Crawler inbox chống xử lý trùng; lưu execution/frontier.
4. Worker claim bằng lease/fencing, fetch ngoài transaction và ghi kết quả vào PostgreSQL staging.
5. Sink ghi analytics sang ClickHouse rồi xác nhận; watermark cho biết dữ liệu đã công bố tới đâu.
6. Worker phát progress/terminal qua durable outbox; Control Plane inbox cập nhật projection theo version.
7. UI đọc lifecycle ở Control Plane; report đi qua authorization rồi mới đọc analytics từ service sở hữu.

Capture dùng nguyên tắc tương tự, thêm upload object và cleanup. Không có distributed transaction giữa PostgreSQL, ClickHouse và S3. Delivery là at-least-once; correctness dựa vào idempotency, version, fencing, acknowledgement, watermark và reconciliation, không phải exactly-once delivery.

## 5. Lưu trữ và kỷ luật thiết kế dữ liệu

PostgreSQL giữ workflow/authorization; ClickHouse giữ analytical facts; object storage giữ nội dung lớn. ClickHouse không quyết định quyền truy cập, queue, lease hoặc cancellation. Redis hiện chỉ mở cho vòng đời auth.

Ba database PostgreSQL có thể nằm trên cùng cluster/host; không suy ra high availability hoặc ba server độc lập từ việc có ba database logic.

Chính sách DESIGN_GATES áp dụng cho mọi thay đổi mới:

- **GREEN:** users và session/refresh persistence; tái sử dụng auth_sessions, không tạo bảng trùng chức năng.
- **YELLOW:** chỉ đề xuất cho những bảng như AI analysis, monitor/alert, knowledge/model metadata và reconstruction; cần phê duyệt theo bảng/revision trước implementation.
- **RED:** core scan/page/metric/finding/capture/regression và các dữ liệu nhạy cảm về workload. Phải làm rõ nghiệp vụ, workload, query/write pattern, volume, consistency/concurrency và retention trước thiết kế schema.

Sau bảy nhóm đầu vào mới đến phương án schema, constraints, indexes, transaction, benchmark và schema cuối. Đổi tên bảng hoặc datastore không né được cổng review. Những phần đã được phê duyệt và triển khai có phạm vi riêng; không cho phép tự mở rộng bảng khác. Giữ migration đã áp dụng và dữ liệu hiện hữu.

## 6. Bảo mật, nguồn gốc và giới hạn an toàn

Các biện pháp có trong thiết kế/source gồm owner authorization, JWT/CSRF/session revocation, service authentication, input validation, SSRF guard, redirect/DNS/IP checks, SafeProxy cho browser, bounded execution và artifact integrity checks.

Crawled HTML, JavaScript, headers, URL, metadata và nội dung có thể đưa cho AI đều không tin cậy. Không log token, cookie, mật khẩu hoặc raw input nhạy cảm. Phiên đăng nhập tương tác phải giữ owner scope và thời hạn.

SafeProxy ở tầng ứng dụng không đủ để tự khẳng định browser đã được cô lập hoàn toàn bởi OS/network. Hồ sơ vẫn cần bằng chứng egress restriction, process-tree CPU/RAM limits và cleanup khi browser crash/hang.

Crawler có nguồn gốc từ một phần core/ý tưởng CrawlObserver; NOTICE ghi provenance và deployable Crawler mang AGPL-3.0. Không trình bày toàn bộ crawler là mã được tự viết từ đầu. Giữ boundary và provenance; trước quyết định phân phối/thương mại cần đánh giá nghĩa vụ giấy phép phù hợp. Hồ sơ này không đưa ra kết luận pháp lý.

Không nhập mặc định SQLite auth, in-memory frontier, Rod renderer, managed ClickHouse process hoặc cơ chế bypass của upstream. Chỉ thu thập website trong phạm vi có quyền sử dụng; việc không enforce robots.txt không tạo ra quyền truy cập mới.

## 7. Cấu hình lớn không đồng nghĩa capacity thực tế

README mô tả mặc định/cấu hình scan có thể tới 100.000 trang, depth bốn, 24 giờ và concurrency ceiling lớn; crawler vẫn có giới hạn theo host. Đây là **trần policy/cấu hình**, không phải cam kết xử lý 100.000 trang nhanh hay phục vụ 10.000 người đồng thời.

Baseline Design Clone ghi tối đa 100.000 page, 200 GiB input, 50 GiB archive, shard 256 MiB, bốn page/job và hai page/process mặc định, retry ba lần, deadline bảy ngày, archive bảy ngày và metadata 30 ngày. Các ceiling không chứng minh browser, disk, storage hoặc integrity-download đã được benchmark tới mức đó.

Browser concurrency và HTTP crawler concurrency là hai ngân sách khác nhau. Không dùng throughput crawl để suy ra throughput render/capture/clone.

## 8. Triển khai và bằng chứng vận hành

Theo biên bản 04–05/10/2026, production dùng Windows-native VPS, Windows services, Caddy và domain https://jobnext.top. PostgreSQL 17 chạy local loopback với database/role riêng; analytics dùng ClickHouse Cloud; artifact dùng Cloudflare R2. Redis auth dùng dịch vụ Layerbase được chọn sẵn, kết nối TLS.

Local Compose dùng PostgreSQL, ClickHouse, MinIO và Redis local. Không nhầm topology/provider local với production. Không gọi PostgreSQL production là managed database.

Pipeline có build/test/package, checksum, release directory/current junction, health verification và giữ release trước để rollback binary. VPS có cơ chế pull release bằng Scheduled Task. Bản deploy 04/10 phải relay artifact vì đường tải trực tiếp chậm; workflow verification đã timeout trước activation dù triển khai sau đó có bằng chứng healthy. Vì vậy chưa được gọi toàn bộ đường deploy là tự động ổn định không cần can thiệp.

Ngày 05/10 backend được patch Redis auth trên base release 04/10; frontend/crawler/capture không bị thay trong patch đó. Public release.json chỉ phản ánh base release, không mô tả đầy đủ bản vá backend. Release CI tiếp theo phải giữ thay đổi auth nếu muốn tránh ghi đè patch.

Đã có ba PostgreSQL dump trước rollout, kiểm tra hash và đọc được mục lục backup. Chưa có bằng chứng restore drill đầy đủ, PITR, khôi phục ClickHouse/R2 và reconciliation xuyên datastore. Binary rollback không tự rollback schema.

## 9. Kiểm thử và hiệu năng: biết chắc đến đâu?

### Bằng chứng kiểm thử theo từng báo cáo

- Release 04/10: backend có 94 test qua; 24 integration test local bị skip vì thiếu Docker.
- Crawler: go test/go vet và PostgreSQL workflow integration được ghi nhận qua; không suy ra mọi ClickHouse integration đã chạy.
- Capture: 54/61 test qua, bảy skip; typecheck/build qua. Có PostgreSQL integration chạy thật; thiếu một số browser/storage kiểm chứng trong lần audit đó.
- Frontend: 39 test qua, lint/build qua.
- Redis patch 05/10: 21 unit test liên quan và 14 integration test qua, không skip; production auth smoke gồm 17 HTTP request qua.
- CI release có Camoufox headless smoke theo báo cáo triển khai; không coi một smoke thành bằng chứng đủ cho browser crash/cancel/resource isolation.

Đây là các lần chạy khác nhau, không cộng thành tổng coverage hay kết luận “tất cả test hiện tại đều pass”. Lần tổng hợp 08/10 không chạy lại chúng.

### Bài tải 150 scan ngày 03/10

Yêu cầu 150 scan, mỗi scan 1.000 trang, cùng 150 API VU trong mười phút đầu:

| Kết quả | Giá trị |
| --- | --- |
| Scan nhận / timeout khi tạo | 146 / 4 |
| Scan hoàn tất ở cả Control Plane và Crawler | 146, không lệch trạng thái trong scope |
| Trang thành công / lỗi | 146.000 / 0 |
| Throughput HTTP crawler | Khoảng 20,42 trang/giây |
| Thời gian crawl toàn scope | Khoảng một giờ 59 phút |
| Terminal event lag p95 | 0,486 giây |
| API request / lỗi | 27.867 / 3 |
| API latency p95 | 1.030,47 ms |

**Toàn bài vẫn FAILED_ACCEPTANCE_CRITERIA:** bốn admission timeout và API latency chưa đạt SLO. API chỉ chạy mười phút đầu, không chạy liên tục suốt gần hai giờ crawl. Benchmark này diễn ra trước Redis auth rollout; cần đo lại chi phí auth hiện tại, không lấy số cũ đại diện cho bản mới.

### Bài tải 500 scan trước đó

Crawler hoàn thành 500 scan/500.000 trang, khoảng 19,52 trang/giây. Nhưng Control Plane chỉ thể hiện 464 COMPLETED và 36 CANCELLED; terminal event lag p95 khoảng 98,23 phút; API lỗi khoảng 3,00%, p95 khoảng 5,70 giây.

Sau đó có bản sửa cancellation, progress publication, điều phối và report pool, cùng test tương ứng. Bài 150 sau sửa không chứng minh bài 500 đã đạt vì workload khác. Không tuyên bố hệ thống đã phục vụ ổn định 500 hoặc 1.000 người hoạt động liên tục.

## 10. Khoảng trống và rủi ro để ChatGPT cân nhắc

1. **Giá trị sản phẩm chưa được xác thực:** chưa biết người dùng ưu tiên lỗi/SEO, thay đổi sau deploy, bằng chứng browser hay Design Clone; chưa có conversion/retention/willingness-to-pay.
2. **Phạm vi sản phẩm khá rộng:** monitoring và cloning cần được đánh giá như hai hướng giá trị, không mặc nhiên phát triển tất cả cùng lúc.
3. **Reliability chưa được chứng minh toàn diện:** outage/restart nhiều service, ClickHouse/R2 failure, in-flight cancellation, stale publication và global recovery cần evidence riêng.
4. **Browser isolation còn giới hạn:** chưa chứng minh OS egress và hard process resource isolation đầy đủ; authenticated clone cũng chưa có thiết kế scale-out phiên.
5. **Capacity chưa chốt:** tải 150 chưa đạt toàn bộ SLO; 500 có lỗi đáng kể; chi phí Redis + SQL trên mỗi access chưa có benchmark tương đương.
6. **Observability có tiến triển nhưng chưa đủ:** đã có protected backend metrics và timing/telemetry ở một số đường; vẫn cần kiểm chứng độ phủ queue age, retry, browser lifecycle, backlog/watermark và recovery.
7. **Dữ liệu và artifact:** cần xác minh retention xuyên PostgreSQL/ClickHouse/object store, orphan/temp cleanup và restore; không chỉ GC happy path.
8. **Chất lượng crawl/clone:** sitemap, Retry-After, tài nguyên CDN, website động, challenge và tiêu chí archive hữu ích còn cần làm rõ.
9. **Auth/product onboarding:** email verification, recovery tài khoản, team hoặc billing chỉ nên thêm khi nhu cầu được xác nhận; hiện chưa phải tính năng có sẵn.
10. **Vận hành release:** checkout/production patch/base release khác nhau; download pipeline và bằng chứng rollback cần được quản lý rõ.

Những vấn đề trên gồm cả thiếu tính năng, giới hạn thiết kế và thiếu kiểm chứng; không đánh đồng tất cả thành bug đã xác nhận. Danh sách audit 27/09 có mục đã được xử lý sau đó, chẳng hạn auth throttling và một phần metrics; không chép nguyên trạng tài liệu cũ thành hiện trạng mới.

## 11. Lộ trình đã ghi nhận, chưa phải cam kết triển khai

| Giai đoạn | Định hướng |
| --- | --- |
| V1 | Tài khoản, website, bounded crawl, lifecycle và report |
| V1.5 | Browser capture, resource inspection, snapshot và các workflow clone |
| V2 | So sánh scan và phát hiện regression bằng luật có version |
| V3 | AI giải thích nguyên nhân dựa trên bằng chứng, có ranh giới LLM và chống prompt injection |
| V4 | Lịch scan, monitoring, notification/alert |
| V5 | Scale và coordination khi benchmark chứng minh nhu cầu |
| V6 | RAG / Ask WebLens khi có use case retrieval rõ |
| V7 | ML anomaly detection khi dữ liệu và baseline đủ |
| V8 | Vận hành cloud, SLO, capacity, orchestration phù hợp |

V1/V1.5 có implementation nhưng không có nghĩa mọi tiêu chí production đã đạt. Những giai đoạn sau là giả thuyết thứ tự, không phải deadline. Việc đã có VPS production không đồng nghĩa đã hoàn thành V8.

RabbitMQ mới là đề xuất/thử nghiệm ADR-017, không có adapter trong runtime production đã được mô tả. Thử nghiệm transport tổng hợp không đủ để quyết định thêm broker. Kafka, Kubernetes, service mesh, multi-region, OpenSearch và Redis workflow chưa được duyệt chỉ vì dự án tăng tính năng. Redis auth là ngoại lệ rõ trong ADR-019, không phải quyền mở rộng Redis sang mọi luồng.

## 12. Nguyên tắc khi đề xuất phát triển

- Ưu tiên thay đổi nhỏ nhất giải quyết đúng nhu cầu; tái sử dụng code/dependency hiện hữu.
- Không đề xuất thêm công nghệ chỉ để portfolio trông phức tạp hơn.
- Không giảm validation, ownership, SSRF guard, idempotency, fencing hoặc tính đúng dữ liệu để tăng tốc.
- Mọi thay đổi boundary/service cần ADR riêng; database đi qua DESIGN_GATES.
- Không tự đặt workload, retention, doanh thu, ngân sách hoặc mục tiêu số người dùng khi chưa có dữ liệu.
- Đề xuất phải có bài toán người dùng, phạm vi, tiêu chí thành công, chi phí và cách xác minh.
- Ưu tiên phương án deterministic trước AI/ML nếu đủ giải quyết nhu cầu.
- AI chỉ giải thích trên evidence được phép truy cập; phải nêu dữ liệu thiếu và mức chắc chắn, không biến suy đoán thành kết luận.
- Nếu tài liệu mâu thuẫn mà không có ADR/biên bản mới giải quyết rõ, chỉ ra mâu thuẫn và hỏi lại; không tự chọn phiên bản thuận tiện.

## 13. Những thông tin chủ dự án cần bổ sung khi bàn hướng đi

1. Mục tiêu chính là portfolio/học backend, công cụ cá nhân hay SaaS thương mại?
2. Nhóm người dùng đầu tiên là ai, có ai đang dùng và vấn đề nào họ gặp thường xuyên?
3. Ưu tiên website diagnostics/regression hay Design Clone? Có thể trì hoãn nhánh còn lại không?
4. Thời gian phát triển mỗi tuần, ngân sách vận hành, chi phí hiện tại và nhân lực?
5. Quy mô website thật: số trang, tỷ lệ JavaScript/auth/CDN, thời gian chờ chấp nhận được?
6. SLO, retention, dữ liệu nhạy cảm và yêu cầu backup/khôi phục thực tế?
7. Muốn có phiên bản hữu ích trong bao lâu, và đo thành công bằng hành vi nào của người dùng?

Chưa có câu trả lời thì ChatGPT phải ghi giả định, không tự biến chúng thành requirement đã chốt.

## 14. Yêu cầu dành cho ChatGPT sau khi đọc hồ sơ

Hãy đóng vai người phản biện sản phẩm và kiến trúc backend, không chỉ đề xuất thêm tính năng.

Trước tiên, tóm tắt WebLens hiện giải quyết được gì, chưa giải quyết được gì và đâu là dữ liệu chưa đủ. Giữ riêng “có code”, “có test”, “đã deploy” và “capacity đã chứng minh”. Đừng lặp lại các công nghệ/tính năng hiện có như đề xuất mới.

Sau đó hãy:

1. Hỏi tối đa năm câu có ảnh hưởng lớn nhất đến lựa chọn hướng phát triển; tận dụng phần thông tin còn thiếu ở trên.
2. Đưa ra ba hướng khả thi dựa trên năng lực hiện hữu. Với mỗi hướng, nêu người dùng, vấn đề, giá trị, phạm vi tối thiểu, phần tái sử dụng, phần phải làm thêm, rủi ro và cách kiểm chứng nhu cầu.
3. So sánh theo giá trị người dùng, công sức, chi phí vận hành, độ tin cậy/bảo mật, khả năng tạo khác biệt và sự phù hợp với mục tiêu chủ dự án. Nếu cần dữ liệu thị trường/đối thủ hiện tại, hãy tìm nguồn cập nhật và ghi nguồn; không bịa market size hoặc doanh thu.
4. Chọn một hướng ưu tiên theo giả định được nêu rõ. Nói cả những tính năng nên hoãn hoặc không làm, không mặc nhiên gộp mọi nhánh vào một roadmap lớn.
5. Đề xuất lộ trình ngắn theo các mốc kiểm chứng. Mỗi mốc phải có deliverable, tiêu chí chấp nhận, phép đo và điều kiện dừng/chuyển hướng. Ước lượng thời gian chỉ là giả định cho tới khi biết nguồn lực.
6. Tách ba nhóm: cần ổn định trước khi mở rộng người dùng; giúp xác thực giá trị sản phẩm; tối ưu chỉ làm khi có bottleneck đo được.
7. Nếu đề xuất compare/regression/AI, làm rõ metric compatibility, baseline, evidence, false positive, missing data, owner scope và cách đánh giá kết quả.
8. Không thêm broker, database, service hay schema chi tiết trước khi chứng minh nhu cầu và tuân thủ quyết định hiện có. Không cần viết code ở bước tư vấn này.

Trả lời bằng tiếng Việt, cụ thể cho WebLens, nêu trade-off và bằng chứng. Nếu chưa đủ thông tin để chọn hướng, đưa ra quyết định có điều kiện thay vì khẳng định chắc chắn.

## 15. Nguồn để đối chiếu trong repository

Đây là đường dẫn tương đối để chủ dự án có thể cung cấp thêm; ChatGPT ở cuộc trò chuyện khác không tự có quyền đọc những file này.

- README.md; docs/PRODUCT.md; docs/REQUIREMENTS.md; docs/ARCHITECTURE.md; docs/ROADMAP.md.
- docs/database/DESIGN_GATES.md và các workload/proposal được tham chiếu tại đó.
- docs/adr/ADR-005-tach-crawler-thanh-microservice.md; ADR-006; ADR-007; ADR-011; ADR-015; ADR-016; ADR-017; ADR-018; ADR-019 trong cùng thư mục.
- tasks/TASK-009 đến TASK-019: phạm vi crawler, capture, pagination, report, clone và deployment.
- docs/testing/PERFORMANCE_LOAD_TEST_RESULTS.md: mục kết quả cuối 150 scan ngày 03/10.
- docs/testing/WEBLENS_500_SCAN_REVIEW_2026-10-03.md.
- docs/testing/SCAN_CANCELLATION_FIX_2026-10-03.md; PERFORMANCE_RUNTIME_FIX_2026-10-03.md.
- docs/testing/AUDIT_FIXES_2026-10-04.md; DEPLOYMENT_2026-10-04.md.
- docs/testing/REDIS_AUTH_PRODUCTION_DEPLOYMENT_2026-10-05.md.
- docs/testing/KNOWN_ISSUES.md: baseline cũ, cần đối chiếu remediation và deployment mới.
- backend/pom.xml; frontend/package.json; capture-worker/package.json; crawler/go.mod; crawler/NOTICE.md.
- frontend/src/AppRouter.tsx và các pages; backend/src/main/java/com/weblens; crawler/internal; capture-worker/src.

Không đính kèm file .env, token, credential, private seed, raw login session hoặc dữ liệu nhạy cảm từ thư mục tmp khi chia sẻ hồ sơ.
