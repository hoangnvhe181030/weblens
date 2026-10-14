package config

import (
	"strings"
	"testing"
	"time"
)

func TestLoadUsesProductionCapacityDefaults(t *testing.T) {
	t.Setenv("CRAWLER_POSTGRES_URL", "postgres://crawler:password@localhost/crawler")
	t.Setenv("CRAWLER_SERVICE_TOKEN", strings.Repeat("x", 32))
	t.Setenv("CRAWLER_WORKER_CONCURRENCY", "")
	t.Setenv("CRAWLER_HOST_CONCURRENCY", "")
	t.Setenv("CRAWLER_HOST_DELAY", "")
	t.Setenv("CRAWLER_LOCAL_TARGETS_ONLY", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned an error: %v", err)
	}
	if cfg.WorkerConcurrency != 10_000 || cfg.HostConcurrency != 2 || cfg.HostDelay != time.Second {
		t.Fatalf("unexpected defaults: workers=%d hostConcurrency=%d hostDelay=%s", cfg.WorkerConcurrency, cfg.HostConcurrency, cfg.HostDelay)
	}
	if cfg.LocalTargetsOnly {
		t.Fatal("local-only network policy was enabled by default")
	}
}

func TestConfigAcceptsHighCapacityRuntime(t *testing.T) {
	cfg := validConfig()
	cfg.WorkerConcurrency = 10_000

	if err := cfg.Validate(); err != nil {
		t.Fatalf("high-capacity runtime was rejected: %v", err)
	}
}

func TestConfigAcceptsExplicitLocalTargetPolicy(t *testing.T) {
	cfg := validConfig()
	cfg.WorkerConcurrency = 10_000
	cfg.HostConcurrency = 10_000
	cfg.HostDelay = 0
	cfg.LocalTargetsOnly = true

	if err := cfg.Validate(); err != nil {
		t.Fatalf("local target policy was rejected: %v", err)
	}
}

func TestConfigRejectsUnsafeOrOutOfRangeCapacity(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{"too many workers", func(cfg *Config) { cfg.WorkerConcurrency = 10_001 }},
		{"too many host slots", func(cfg *Config) { cfg.HostConcurrency = 10_001 }},
		{"three host slots without local only", func(cfg *Config) { cfg.HostConcurrency = 3 }},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			cfg := validConfig()
			testCase.mutate(&cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatal("invalid profile was accepted")
			}
		})
	}
}

func TestLoadRejectsInvalidSecurityBoolean(t *testing.T) {
	t.Setenv("CRAWLER_POSTGRES_URL", "postgres://crawler:password@localhost/crawler")
	t.Setenv("CRAWLER_SERVICE_TOKEN", strings.Repeat("x", 32))
	t.Setenv("CRAWLER_LOCAL_TARGETS_ONLY", "not-a-boolean")

	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "CRAWLER_LOCAL_TARGETS_ONLY") {
		t.Fatalf("invalid boolean was not reported: %v", err)
	}
}

func TestLoadEnablesSecureClickHouse(t *testing.T) {
	t.Setenv("CRAWLER_POSTGRES_URL", "postgres://crawler:password@localhost/crawler")
	t.Setenv("CRAWLER_SERVICE_TOKEN", strings.Repeat("x", 32))
	t.Setenv("CRAWLER_CLICKHOUSE_SECURE", "true")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned an error: %v", err)
	}
	if !cfg.ClickHouseSecure {
		t.Fatal("secure ClickHouse was not enabled")
	}
}

func validConfig() Config {
	return Config{
		ClickHouseReadMaxConns: 7,
		PostgresURL:            "postgres://crawler:password@localhost/crawler",
		ClickHouseDatabase:     "weblens_crawl_analytics",
		ServiceToken:           strings.Repeat("x", 32),
		ControlEventsURL:       "http://localhost:8080/internal/v1/events/scans",
		WorkerConcurrency:      3,
		HostConcurrency:        2,
		LeaseDuration:          30 * time.Second,
		HostDelay:              time.Second,
		AnalyticsBacklogAge:    15 * time.Minute,
	}
}

func TestClickHouseReadBudgetBounds(t *testing.T) {
	for _, limit := range []int{1, 7, 24, 32, 64} {
		cfg := validConfig()
		cfg.ClickHouseReadMaxConns = limit
		if err := cfg.Validate(); err != nil {
			t.Fatal("valid ClickHouse read budget rejected")
		}
	}
	for _, limit := range []int{0, -1, 65} {
		cfg := validConfig()
		cfg.ClickHouseReadMaxConns = limit
		if err := cfg.Validate(); err == nil {
			t.Fatal("invalid ClickHouse read budget accepted")
		}
	}
}

func TestClickHouseHTTPURLPolicy(t *testing.T) {
	for _, raw := range []string{"https://clickhouse.example", "https://clickhouse.example:8443/", "http://127.0.0.1:8123", "http://[::1]:8123"} {
		if _, err := ParseClickHouseHTTPURL(raw); err != nil {
			t.Fatalf("valid endpoint rejected: %v", err)
		}
	}
	for _, raw := range []string{"http://clickhouse.example", "https://user:secret@clickhouse.example", "https://clickhouse.example/path", "https://clickhouse.example?query=SELECT", "https://clickhouse.example#fragment", "file:///tmp", "https://clickhouse.example:bad"} {
		if _, err := ParseClickHouseHTTPURL(raw); err == nil {
			t.Fatal("unsafe endpoint accepted")
		}
	}
	t.Setenv("CRAWLER_POSTGRES_URL", "postgres://crawler:password@localhost/crawler")
	t.Setenv("CRAWLER_SERVICE_TOKEN", strings.Repeat("x", 32))
	t.Setenv("CRAWLER_CLICKHOUSE_HTTP_URL", "https://clickhouse.example")
	cfg, err := Load()
	if err != nil || cfg.ClickHouseHTTPURL != "https://clickhouse.example" {
		t.Fatal("HTTP override was not loaded")
	}
}
