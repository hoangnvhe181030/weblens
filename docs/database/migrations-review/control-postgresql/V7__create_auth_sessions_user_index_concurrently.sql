-- Review-only. The existing partial active-session index cannot support every
-- foreign-key parent delete check because revoked sessions are excluded.
SET lock_timeout = '5s';
SET statement_timeout = '30min';

CREATE INDEX CONCURRENTLY ix_auth_sessions_user_id
    ON auth_sessions (user_id);

RESET statement_timeout;
RESET lock_timeout;
