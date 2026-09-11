-- Review-only. This file must execute outside a transaction.
SET lock_timeout = '5s';
SET statement_timeout = '30min';

CREATE UNIQUE INDEX CONCURRENTLY uq_scans_id_requester_idx
    ON scans (id, requested_by_user_id);

RESET statement_timeout;
RESET lock_timeout;
