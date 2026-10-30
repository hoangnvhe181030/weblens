# Security test results

Date: 2026-09-27. Targets were local fixtures and an isolated Control Plane database; no external system was scanned.

## SSRF

- Capture URL and proxy tests now reject loopback, private, link-local, reserved, IPv4-mapped IPv6, and metadata-style addresses. The mapped-loopback regression failed before the fix and passes afterward; SafeProxy returned 502 without reaching a local private listener.
- Go SafeDialer rejects private and mixed public/private DNS results before connecting. The crawler HTTP fixture blocks a redirect from the fixture host to `127.0.0.1`; the private route received zero hits.
- The crawler re-resolves and checks the connected address in `SafeDialer.DialContext`, so a DNS answer that changes after an earlier registration check is checked at the outbound connection. A separate live DNS-rebinding test was not run.
- Capture SafeProxy resolves and connects to the selected IP at request time. Browser requests also pass the route check. Network-level browser egress containment remains H-02 in [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

## Authentication and ownership

Twenty live API assertions passed: missing/invalid JWT 401; malformed JSON 400; registration 201; valid login 200; invalid password 401; cross-owner website/scan/cancellation 404; owner field in a website body ignored; pagination validation 400; localhost registration 400; scan creation 202 and idempotent replay 200; cancellation 202/200; refresh rotation 200; logout 204; revoked refresh 401.

Existing Java tests cover internal service-token authentication, capture/report owner scope and security filters. Capture Worker unit tests cover artifact owner scope and integrity. A complete two-user browser/capture authorization journey was not run because the data plane was absent.

## Exposure review

- `git ls-files` confirms `.env` and the local ClickHouse key file are untracked. A tracked-file search for private-key blocks and common token prefixes found no match. This is a pattern scan, not a full historical secret scan.
- Node production dependency audits reported zero known advisories for the frontend and Capture Worker at the audit time. Java/Go advisory feeds were not run.
- Control Plane uses RFC-style problem responses without stack traces, bounded internal event bodies, constant-time service token comparison, owner-scoped repositories, CORS allowlist and CSRF double-submit on refresh/logout.
- Authentication throttling is missing (H-03). Browser network-level egress isolation is missing (H-02). Both remain HIGH release gates.
