-- GREEN only. V1's existing normalization check permits an empty string.
-- Reject missing credential material without coupling SQL to one hash algorithm.
-- Preflight existing users before deployment; do not repair credentials here.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE users
    ADD CONSTRAINT ck_users_normalized_email_not_blank
        CHECK (btrim(normalized_email) <> ''),
    ADD CONSTRAINT ck_users_password_hash_not_blank
        CHECK (btrim(password_hash) <> '');
