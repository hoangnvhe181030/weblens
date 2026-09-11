SET lock_timeout = '5s';
SET statement_timeout = '30min';

CREATE INDEX CONCURRENTLY ix_auth_sessions_user_id
    ON auth_sessions (user_id);

RESET statement_timeout;
RESET lock_timeout;
