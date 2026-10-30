# Redis for JWT session lifecycle

Status: Accepted; local VPS registry revision authorized on 2026-10-12  
Date: 2026-10-05

## Context

The user requested Redis management of access and refresh JWTs. Existing access
JWTs are stateless and remain usable after logout until expiry. PostgreSQL
`auth_sessions` already provides durable refresh rotation and revocation.
This decision supersedes the Redis exclusion in ADR-005/ARCHITECTURE only for
Control Plane authentication. It adds no deployable application or SQL schema.

## Options considered

1. Redis denylist: missing keys cannot distinguish a valid token from lost
   revocation data after eviction/restart.
2. Move all sessions to Redis: discards the existing durable rotation ledger.
3. Redis positive session registry plus existing PostgreSQL refresh ledger:
   selected; both must permit refresh, and access requires a live Redis session.

## Decision

- Keep signed HS256 JWTs, short access lifetime, HttpOnly refresh cookie,
  double-submit CSRF and owner/user checks. JWT signature/type/issuer/audience/
  time validation precedes Redis lookup.
- Redis holds `weblens:auth:v1:session:<sid>` with the user UUID and SHA-256 hash
  of the current refresh JTI. Never store raw JWTs, credentials or CSRF tokens.
  Expiry equals the refresh expiry (configured longer than access expiry).
- Every access request requires a matching live Redis session owner and one
  PostgreSQL existence query by session primary key, owner, unrevoked status and
  refresh expiry. PostgreSQL is authoritative for durable revocation, so a stale
  Redis snapshot cannot revive a logged-out session. This adds one SQL statement
  per successful Redis access check; no entity hydration or new index is needed.
  Previously issued
  access tokens for the same session remain usable through refresh until their
  own expiry; logout invalidates all of them. Other login sessions are independent.
- Register/login commit PostgreSQL before activating Redis and returning tokens.
  Failed Redis activation returns 503; a registered account may already exist,
  so the client can retry login. An unactivated session cannot authenticate.
- Refresh checks Redis and then rotates under the existing PostgreSQL row lock.
  After commit, a Lua compare-and-set advances the Redis refresh hash and TTL.
  The script never recreates a missing key. Concurrent replay has one winner.
  Commit/publication failure may require a fresh login; it cannot make an old
  refresh credential valid again. No Redis call holds a SQL transaction open.
- Logout validates the signed refresh token and persisted owner/JTI/CSRF, commits
  PostgreSQL revocation, then deletes the Redis session outside the SQL transaction.
  Failed Redis deletion returns 503 but the committed revocation still rejects
  access and refresh, including after stale Redis data is restored. A failed SQL
  commit does not report logout success. A refresh already in flight cannot revive
  the durably revoked session. Invalid credentials remain a no-op.
- Redis outages return 503 and do not fall back to JWT-only authentication or
  reconstruct sessions from PostgreSQL. Missing/expired sessions return 401.
  A request that already passed authentication may finish after logout.
- Prefer a bounded, single-primary registry with `noeviction`. On 2026-10-05 the
  user explicitly selected shared Layerbase Redis and required its existing RDB
  persistence to remain unchanged. Do not alter other keys or server persistence.
  Durable PostgreSQL checks now protect against stale Redis restoration; missing
  Redis data still requires login and is never backfilled. Restore of PostgreSQL
  itself requires independent token invalidation. Production connections require
  authentication, TLS and hostname/certificate verification. The selected server
  is Redis 7.2.15; required Lua/SET PXAT operations are supported and deployment
  probes passed. Local/CI Redis 7.4 remains the preferred test baseline.
- Add only `spring-boot-starter-data-redis` (Boot-managed Lettuce client, string
  operations and scripts). No Spring Session, Redisson or new broker is needed.

## Local VPS revision — 2026-10-12

The user explicitly requested installing and using local Redis on the existing
Windows VPS. This supersedes the selected Layerbase endpoint, not the JWT/session
security design above. The shared provider currently rejects AUTH because its
free-plan database is asleep. Its keys, credentials and persistence are not changed.

Use a fresh registry bound exclusively to `127.0.0.1:6379`, authenticated with a
random dedicated application credential and namespace-scoped Redis ACL. The
administrator credential, config, data and rollback environment are protected by
Windows ACLs. The service runs under its own virtual account. No public Redis
firewall allowance is created. TLS is disabled only for this same-host loopback
connection; any future non-loopback connection still requires verified TLS.
Do not reconstruct sessions from SQL or copy shared Redis keys. Existing sessions
must log in again. Keep the PostgreSQL durable revocation check unchanged.

The personal-project Windows experiment uses the checksum-pinned community
`redis-windows` Redis 8.2.10 Cygwin build, not an official vendor-supported Windows
Redis distribution. Its maintainers recommend Linux for production. Memurai's
free Developer edition is restricted to non-production use and shuts down after
ten days; do not work around that license/uptime restriction. Production support
requires an appropriately licensed Windows product or a Linux deployment.

Bound the registry to 128 MiB with `noeviction`, AOF `everysec` plus RDB snapshots.
Restart tests must preserve the key value and absolute expiry. AOF everysec is
not zero-loss crash durability: missing keys require login; stale Redis still
cannot override PostgreSQL revocation. This is a single-host failure domain, not
HA. Keep the existing PostgreSQL connection budget; Redis installation does not
justify extra SQL pools. Installation uses the deployment mutex, protected backup,
checksums, dependency ordering and an environment rollback. Returning to the
sleeping shared provider may restore configuration without restoring availability.

Reproduce with `infra/production-windows/install-local-redis.ps1`; `-Action
selftest` is non-mutating, `install` refuses an existing service/data directory,
`verify` tests auth/Lua/expiry and restarts only this Redis service, and `rollback`
restores the recorded environment only when its checksum still matches. Do not
run the restart verification during user traffic without a maintenance window.

Sources: [community release and checksum](https://github.com/redis-windows/redis-windows/releases/tag/8.2.10),
[community support limits](https://github.com/redis-windows/redis-windows#disclaimer),
[Memurai edition limits](https://www.memurai.com/faq),
[Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/).

## Consequences

Redis becomes a required dependency for authentication; each access check adds
one Redis read and one primary-key PostgreSQL existence query. Both stores must
be available; lookup outages return 503 without bypassing either check.
Existing sessions must log in again on rollout because there is
no backfill into the positive registry. All Control Plane instances must use the
same Redis and JWT settings; drain old instances before enabling the new version.
Rolling back to the previous JWT-only implementation loses immediate access
revocation, so rotate the JWT signing secret if rollback is necessary.

## Verification

Cover signature/type checks, missing/expired/wrong-owner sessions, old refresh
replay, concurrent refresh, independent sessions, access after logout, Redis
outage, SQL commit failure, and logout racing with Redis refresh publication.
Run integration checks with real Redis and PostgreSQL; unit mocks alone do not
establish atomicity. Production deployment and load capacity are not implied.

Local verification on 2026-10-05 used Java 21, PostgreSQL 18.4 and Redis 8.0.5
on isolated loopback endpoints because Docker Engine was unavailable. The backend
unit suite passed (94 tests); 12 selected integration tests passed with no skips:
FoundationApiIT, AuthenticationPersistenceIT and RedisSessionStoreIT. Both Compose
configurations passed validation and edited localized files passed UTF-8 checks.
The Docker route specifies PostgreSQL 17.6 and Redis 7.4 and still requires CI
verification; this local result is not a production-version or load benchmark.

The shared-persistence revision passed 21 relevant unit tests and 14 integration
tests, including stale Redis restoration and one SQL statement per access check.
It was deployed to the Windows production backend on 2026-10-05; 17 production
auth smoke requests passed against Redis 7.2.15/PostgreSQL 17.11. See
[deployment record](../testing/REDIS_AUTH_PRODUCTION_DEPLOYMENT_2026-10-05.md)
for artifact hashes, timeout adjustment, rollback and verification limits.

Reproduce with Docker using `cd backend; ./mvnw verify`. Without Docker, provision
a disposable local PostgreSQL database named `weblens_test_*` and an isolated
Redis endpoint, then run (substitute your test-only ports):

```powershell
mvn verify '-Dit.test=RedisSessionStoreIT,AuthenticationPersistenceIT,FoundationApiIT' `
  '-Dweblens.test.postgres.url=jdbc:postgresql://127.0.0.1:55459/weblens_test_redis_auth' `
  '-Dweblens.test.redis.host=127.0.0.1' '-Dweblens.test.redis.port=56389'
```

The explicit SQL test path rejects non-loopback databases and names outside
`weblens_test_*`. It runs existing migrations and retains test rows; never point
it at application data. Authentication tests use real Spring transaction commits,
not a test transaction that would mask publication/locking behavior.

## References

- [Spring Data Redis scripting](https://docs.spring.io/spring-data/redis/reference/redis/scripting.html)
- [Redis persistence choices](https://redis.io/docs/latest/management/persistence/)

## When to revisit

When restart-induced logout is unacceptable, token-level rather than session-level
access revocation is required, or measured Redis latency/availability requires HA.
