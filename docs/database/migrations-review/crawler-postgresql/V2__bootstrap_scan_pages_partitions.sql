-- Review-only. Add future partition migrations before the horizon is reached.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE scan_pages_2026_09 PARTITION OF scan_pages
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

CREATE TABLE scan_pages_2026_10 PARTITION OF scan_pages
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

CREATE TABLE scan_pages_2026_11 PARTITION OF scan_pages
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

CREATE TABLE scan_pages_2026_12 PARTITION OF scan_pages
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

CREATE TABLE scan_pages_2027_01 PARTITION OF scan_pages
    FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');

CREATE TABLE scan_pages_2027_02 PARTITION OF scan_pages
    FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');

CREATE TABLE scan_pages_2027_03 PARTITION OF scan_pages
    FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');

CREATE TABLE scan_pages_default PARTITION OF scan_pages DEFAULT;
