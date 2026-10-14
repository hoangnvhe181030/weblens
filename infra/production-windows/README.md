# WebLens Windows-native production

## Redis authentication prerequisite (ADR-019)

The JWT session implementation requires a separately provisioned private Redis
7.2+ endpoint before deploying this backend. The pinned personal-project VPS now
uses local Redis 8.2.10 through `install-local-redis.ps1`. This is a community
Cygwin port, not a vendor-supported Windows production distribution. Set `WEBLENS_REDIS_HOST`, `WEBLENS_REDIS_PORT`,
`WEBLENS_REDIS_USERNAME`, `WEBLENS_REDIS_PASSWORD` and `WEBLENS_REDIS_SSL` in the
protected service environment file. Use TLS and authentication across networks;
never expose Redis publicly. Default connect/command timeouts are one second.
The local instance binds only `127.0.0.1:6379`, uses ACL authentication, 128 MiB
`noeviction`, AOF everysec and RDB. Backend depends on Postgres and Redis. Its
connect/command overrides are two seconds. `verify` is a maintenance operation:
it stops/restarts the dependent Backend as well as Redis, then checks persistence,
TTL, permissions and readiness. Run the six-case installer lifecycle smoke test
before changing this sequence. Backups and secrets remain Admin/SYSTEM-only.
The previous Layerbase deployment overrode both to ten
seconds using native Spring environment settings `SPRING_DATA_REDIS_CONNECT_TIMEOUT=10s`
and `SPRING_DATA_REDIS_TIMEOUT=10s`; its initial TLS/Redis handshake exceeded the
one-second budget in the first rollout attempt. Lettuce with a five-second command
timeout passed a same-host TLS/hostname/authentication probe before retrying.

```powershell
powershell.exe -NoProfile -File infra/production-windows/install-local-redis.ps1 -Action selftest
powershell.exe -NoProfile -File tools/load/redis-installer-smoke-test.ps1
```

`install` and `activate` are pinned to the inspected host and refuse conflicting
service/data state. `rollback` verifies the full environment and backup hashes;
restore later transport/pool environment changes first before attempting the
Redis rollback. Neither action deletes the local Redis data or changes shared
Layerbase persistence. Returning to the sleeping provider may not restore auth.

Crawler runtime can use `CRAWLER_CLICKHOUSE_HTTP_URL` for the existing Cloud HTTPS
origin. TLS validation and per-service credentials remain mandatory. No schema
or database ownership changes. Keep `CRAWLER_MIGRATE_ON_START=false`; ClickHouse
migration commands require the native endpoint with the HTTP override unset.
The optional `CRAWLER_CLICKHOUSE_READ_MAX_CONNS` is bounded to 1..64 (default 7),
with a separate fixed writer pool of 3. This does not change PostgreSQL pools.

Prefer a bounded single primary with `maxmemory-policy noeviction`. Shared managed
Redis is supported without changing its existing RDB/AOF settings: each access
check also queries PostgreSQL by session primary key for owner, expiry and durable
revocation. Logout commits PostgreSQL first, so restored Redis snapshots cannot
revive revoked sessions. Redis data loss still requires login. Never restore the
PostgreSQL auth ledger without separately invalidating previously issued tokens.
For local development, `docker compose --env-file .env -f infra/compose.yml up -d redis`
starts a loopback-only instance on port 56379. This local instance has no password
and is not the production configuration.

Drain previous backend instances on rollout; existing JWT sessions must log in
again. Validate health and login → refresh → logout → old access rejected before
accepting the deployment. Redis failure returns 503 without bypassing session
validation. Rolling back to a JWT-only backend requires signing-secret rotation
to prevent revoked JWTs from becoming usable again.

## Existing Windows services

This deployment preserves local Docker Compose but runs production as five
Windows services. PostgreSQL runs on the VPS; ClickHouse Cloud and Cloudflare
R2 remain external.

The release layout is `C:\WebLens\releases\<commit>`, with `C:\WebLens\current`
pointing to the active release. Secrets live only in
`C:\ProgramData\WebLens\weblens.env`; grant read access only to the service
virtual accounts, Administrators, and SYSTEM. `WebLensPostgres` is a dedicated
PostgreSQL 17 service listening on `127.0.0.1:5433`. The backend, crawler, and
capture worker use separate databases and login roles, and each Windows service
depends on `WebLensPostgres` for reboot ordering. Keep the database port bound to
loopback; do not open it in the VPS firewall.

Production database URLs must use `127.0.0.1:5433` with TLS disabled because the
traffic never leaves the host. Keep a bounded connect timeout on every client;
the backend also uses a socket timeout and TCP keepalive. Logical backups belong
under `C:\ProgramData\WebLens\backups` with access limited to Administrators and
SYSTEM. Before a PostgreSQL major upgrade, take and validate a custom-format dump
of all three databases.
The Capture Worker uses pinned Camoufox by default; its Windows binary is
checksum-verified and included in each release. Chromium is retained and can
be selected explicitly with `CAPTURE_BROWSER_ENGINE=playwright`.

Headless Camoufox disables the Gamepad API on Windows. On the production Server
2019 host, calling `navigator.getGamepads()` from a service reproducibly terminated
both Chromium and Camoufox with exit code `0xe0464645`; the same Camoufox fixture
survived with `dom.gamepad.enabled=false`. Mouse, keyboard, screenshots and proxy
guards remain enabled. Keep production on `CAPTURE_BROWSER_ENGINE=camoufox` with
this fix: the Chromium override does not receive the Firefox preference and is
not a remedy for this service-host crash. The Windows release smoke test probes
gamepad access and verifies that the browser still accepts login input.

Install and start `WebLensPostgres` before running `bootstrap.ps1`. Run
`bootstrap.ps1` once after the first release junction exists. It registers
`WebLensDeployPoll`, which checks the public GitHub deployment release every five
minutes, verifies its SHA-256, and calls `deploy.ps1`. The script runs only the
crawler PostgreSQL migration, health-checks all services, and returns to the
previous junction on failure. `/release.json` reports the active commit for CI.
The deploy script also stops any orphaned WebLens Backend Java process before
starting the replacement, so an old process cannot keep port 8080 occupied.

Caddy serves `jobnext.top` and `www.jobnext.top` on port 443 with a publicly
trusted certificate. Direct IP and loopback access keep an internal certificate
for deployment health checks. Port 80 remains owned by the existing application,
so WebLens does not install HTTP-to-HTTPS redirects.
