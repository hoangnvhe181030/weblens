SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE credit_accounts (
    owner_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
    balance bigint NOT NULL DEFAULT 0,
    held bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_credit_account_balance CHECK (balance >= held AND held >= 0)
);

CREATE TABLE payment_orders (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES credit_accounts (owner_id) ON DELETE RESTRICT,
    provider text NOT NULL CHECK (provider ~ '^[A-Z0-9_]{1,32}$'),
    environment text NOT NULL CHECK (environment IN ('SANDBOX', 'LIVE')),
    merchant_account text NOT NULL CHECK (merchant_account ~ '^[A-Za-z0-9_-]{1,100}$'),
    profile_id text NOT NULL CHECK (profile_id ~ '^[a-z0-9-]{1,40}$'),
    reference text NOT NULL CHECK (reference ~ '^[A-Za-z0-9]{1,100}$'),
    package_id text NOT NULL CHECK (package_id ~ '^[a-z0-9-]{1,40}$'),
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    credits bigint NOT NULL CHECK (credits > 0),
    idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
    request_fingerprint_hash text NOT NULL CHECK (request_fingerprint_hash ~ '^[0-9a-f]{64}$'),
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'NOT_SUCCEEDED', 'PAID')),
    provider_transaction_id text,
    paid_at timestamptz,
    settled_at timestamptz,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT uq_payment_order_owner UNIQUE (id, owner_id),
    CONSTRAINT uq_payment_owner_key UNIQUE (owner_id, idempotency_key_hash),
    CONSTRAINT uq_payment_reference UNIQUE (provider, environment, merchant_account, reference),
    CONSTRAINT ck_payment_time CHECK (expires_at > created_at AND updated_at >= created_at),
    CONSTRAINT ck_payment_settlement CHECK (
        (status = 'PAID' AND provider_transaction_id IS NOT NULL
            AND length(provider_transaction_id) BETWEEN 1 AND 100 AND settled_at IS NOT NULL)
        OR (status <> 'PAID' AND provider_transaction_id IS NULL AND settled_at IS NULL AND paid_at IS NULL)
    )
);
CREATE UNIQUE INDEX uq_payment_provider_transaction
    ON payment_orders (provider, environment, merchant_account, provider_transaction_id)
    WHERE status = 'PAID';
CREATE INDEX ix_payment_owner_history ON payment_orders (owner_id, created_at DESC, id DESC);
CREATE INDEX ix_payment_unresolved ON payment_orders (created_at, id) WHERE status <> 'PAID';

CREATE TABLE usage_reservations (
    scan_id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES credit_accounts (owner_id) ON DELETE RESTRICT,
    max_pages integer NOT NULL CHECK (max_pages BETWEEN 1 AND 1000000),
    credits_per_page bigint NOT NULL CHECK (credits_per_page > 0),
    reserved_credits bigint NOT NULL CHECK (reserved_credits > 0),
    policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 64),
    status text NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED', 'FINALIZED')),
    evidence_version bigint,
    terminal_outcome text,
    billable_pages integer,
    charged_credits bigint,
    released_credits bigint,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finalized_at timestamptz,
    CONSTRAINT fk_usage_owned_scan FOREIGN KEY (scan_id, owner_id)
        REFERENCES scans (id, requested_by_user_id) ON DELETE RESTRICT,
    CONSTRAINT uq_usage_owner UNIQUE (scan_id, owner_id),
    CONSTRAINT ck_usage_reserve CHECK (reserved_credits::numeric = max_pages::numeric * credits_per_page),
    CONSTRAINT ck_usage_finalize CHECK (
        (status = 'RESERVED' AND evidence_version IS NULL AND terminal_outcome IS NULL
            AND billable_pages IS NULL AND charged_credits IS NULL AND released_credits IS NULL AND finalized_at IS NULL)
        OR (status = 'FINALIZED' AND evidence_version IS NOT NULL AND evidence_version >= 1
            AND terminal_outcome IS NOT NULL
            AND terminal_outcome IN ('COMPLETED', 'PARTIAL_SUCCESS', 'USER_CANCELLED', 'INTERNAL_FAILURE')
            AND billable_pages IS NOT NULL AND billable_pages BETWEEN 0 AND max_pages
            AND charged_credits IS NOT NULL AND charged_credits BETWEEN 0 AND reserved_credits
            AND released_credits IS NOT NULL AND released_credits = reserved_credits - charged_credits
            AND charged_credits::numeric = billable_pages::numeric * credits_per_page
            AND (terminal_outcome <> 'INTERNAL_FAILURE' OR billable_pages = 0)
            AND finalized_at IS NOT NULL)
    )
);
CREATE INDEX ix_usage_owner_history ON usage_reservations (owner_id, created_at DESC, scan_id DESC);
CREATE INDEX ix_usage_unresolved ON usage_reservations (created_at, scan_id) WHERE status = 'RESERVED';

CREATE TABLE credit_ledger (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES credit_accounts (owner_id) ON DELETE RESTRICT,
    operation text NOT NULL CHECK (operation IN ('TOPUP', 'RESERVE', 'FINALIZE')),
    payment_order_id uuid,
    reservation_scan_id uuid,
    balance_delta bigint NOT NULL,
    held_delta bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_ledger_payment_owner FOREIGN KEY (payment_order_id, owner_id)
        REFERENCES payment_orders (id, owner_id) ON DELETE RESTRICT,
    CONSTRAINT fk_ledger_usage_owner FOREIGN KEY (reservation_scan_id, owner_id)
        REFERENCES usage_reservations (scan_id, owner_id) ON DELETE RESTRICT,
    CONSTRAINT ck_ledger_source_delta CHECK (
        (operation = 'TOPUP' AND payment_order_id IS NOT NULL AND reservation_scan_id IS NULL
            AND balance_delta > 0 AND held_delta = 0)
        OR (operation = 'RESERVE' AND payment_order_id IS NULL AND reservation_scan_id IS NOT NULL
            AND balance_delta = 0 AND held_delta > 0)
        OR (operation = 'FINALIZE' AND payment_order_id IS NULL AND reservation_scan_id IS NOT NULL
            AND balance_delta <= 0 AND held_delta < 0 AND balance_delta >= held_delta)
    )
);
CREATE UNIQUE INDEX uq_ledger_payment ON credit_ledger (payment_order_id) WHERE payment_order_id IS NOT NULL;
CREATE UNIQUE INDEX uq_ledger_usage ON credit_ledger (reservation_scan_id, operation) WHERE reservation_scan_id IS NOT NULL;
CREATE INDEX ix_ledger_owner_history ON credit_ledger (owner_id, created_at DESC, id DESC);

CREATE FUNCTION reject_credit_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Credit ledger is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER credit_ledger_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON credit_ledger
    FOR EACH STATEMENT EXECUTE FUNCTION reject_credit_ledger_mutation();
