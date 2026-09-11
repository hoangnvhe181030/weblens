-- Review-only. Preflight must prove there is at most one active scan per scope.
SET lock_timeout = '5s';
SET statement_timeout = '30min';

CREATE UNIQUE INDEX CONCURRENTLY uq_scans_one_active_per_website
    ON scans (requested_by_user_id, website_id)
    WHERE status IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED');

RESET statement_timeout;
RESET lock_timeout;
