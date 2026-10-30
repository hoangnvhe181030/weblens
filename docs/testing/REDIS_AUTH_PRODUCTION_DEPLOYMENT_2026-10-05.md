# Redis JWT authentication production deployment — 2026-10-05

## Result

The Redis authentication backend was activated on `https://jobnext.top` at
06:09:45 UTC (13:09:45 Asia/Bangkok). Production authentication verification
passed at 06:10:23 UTC. This is a backend patch on the existing Windows release;
the public `/release.json` continues to report the base release commit.

- Base release: `6ade9332e2e4c4df12b304edecad5d756462143f`.
- Original backend SHA-256: `d82b33b63cfc0de7406085f04d7b49b1bc46b5e825c191679f047271580b70d7`.
- Installed backend SHA-256: `b4fb8ce65d03581540c76b4ac11282f71451202b8469205dfe6f64472b15f6a7`.
- Server deployment records and protected backups:
  `C:\ProgramData\WebLens\incoming\redis-auth-20261005-r2`.
- Local reproducible source and verification artifacts:
  `tmp/releases/redis-production-20261005` (ignored; includes private test credentials).

No new SQL migration was introduced. The candidate was compiled from the active
production commit with the Redis authentication changes, retaining the existing
service-token-protected metrics configuration. Crawler, Capture Worker and
frontend artifacts were not replaced. No GitHub release was published; future
CI releases must include the auth changes before replacing this backend patch.

## Shared Redis decision

The user selected the existing Layerbase endpoint and explicitly required its
persistence settings to remain unchanged. The server reports Redis 7.2.15,
single primary, no replicas, a 200 MiB memory budget, `noeviction`, RDB enabled
and AOF disabled. Existing shared keys and these settings were preserved.

The backend uses TLS with certificate and hostname validation. Credentials are
stored in the protected production environment file and excluded from this
report. Each valid Redis access check additionally performs one PostgreSQL
primary-key existence query for owner, expiry and durable revocation. Logout
commits PostgreSQL revocation before deleting Redis data. A stale Redis snapshot
therefore cannot revive a revoked session. See ADR-019 for failure semantics.

The first deployment failed Redis health because the one-second connection
initialization budget was insufficient. Automatic rollback restored the original
backend and rotated the JWT signing secret. A same-host Lettuce TLS/auth/PING
probe then passed with a longer timeout. The final environment uses native
`SPRING_DATA_REDIS_CONNECT_TIMEOUT=10s` and `SPRING_DATA_REDIS_TIMEOUT=10s`.
Existing users must log in again.

## Verification

- Isolated candidate build: 21 relevant unit tests and 14 integration tests
  passed, with no failures or skips. Local test services were PostgreSQL 18.4
  and Redis 8.0.5; production PostgreSQL reports 17.11.
- Integration checks include restoring a revoked Redis session, failed Redis
  deletion after committed SQL revocation, concurrent refresh/logout, and a
  measured single SQL statement for access validation.
- Production smoke: 17 HTTP requests passed, covering login, independent
  sessions, refresh rotation, replay rejection, access after refresh, logout,
  revocation of both old/new access tokens, refresh after logout, and repeated
  logout with a revoked bearer. Both verification sessions were logged out.
- Production homepage returned HTTP 200. Backend, crawler and capture readiness
  returned UP on the final checks; the four application Windows services were
  running. One earlier readiness collection returned DOWN and was repeated;
  no cause was established from that single observation.
- Local test PostgreSQL/Redis services were stopped after verification.
- Edited localized documentation passed UTF-8 validation.

These checks establish the deployment and authentication behavior; they are not
a load benchmark or an availability guarantee for the shared Redis service.

## Rollback

Run as an administrator on the VPS:

```powershell
& 'C:\ProgramData\WebLens\incoming\redis-auth-20261005-r2\install.ps1' `
  -Action rollback `
  -ArtifactSha256 b4fb8ce65d03581540c76b4ac11282f71451202b8469205dfe6f64472b15f6a7
```

Rollback checks the installed artifact and preserved original checksum, restores
the previous backend/environment, rotates the JWT signing secret and requires
a healthy backend. It intentionally invalidates all existing login credentials.
Do not overwrite the protected backup files or restore old auth data manually.
