# Thông báo nguồn và giấy phép

WebLens Crawler là một bản chuyển đổi có chủ đích từ các ý tưởng và một phần core
của [SEObserver/CrawlObserver](https://github.com/SEObserver/crawlobserver), commit
tham chiếu `1cc8d7e822e1ffc4b92b437ceb452bad8a01cfc8` ngày 2026-08-01.

Các file trong `internal/crawl/` có header provenance riêng khi logic được chuyển
đổi từ CrawlObserver. Toàn bộ deployable Crawler này được phân phối theo
GNU Affero General Public License v3.0 trong file `LICENSE`.

WebLens không nhập các thành phần SQLite authentication, in-memory session
manager/frontier, Rod renderer, TLS impersonation, Cloudflare bypass, desktop UI
hoặc managed ClickHouse process của upstream.
