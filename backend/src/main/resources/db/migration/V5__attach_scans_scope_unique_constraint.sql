SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE scans
    ADD CONSTRAINT uq_scans_id_requester
    UNIQUE USING INDEX uq_scans_id_requester_idx;
