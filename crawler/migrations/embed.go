package migrations

import "embed"

// Files contains the reviewed PostgreSQL and ClickHouse runtime migrations.
//
//go:embed postgresql/*.sql clickhouse/*.sql
var Files embed.FS
