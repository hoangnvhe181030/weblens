SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX ix_reconstruction_artifacts_staged_gc
    ON reconstruction_artifacts (delete_after, id)
    WHERE state = 'STAGED';
