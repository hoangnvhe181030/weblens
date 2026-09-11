package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	HTTPAddress           string
	PostgresURL           string
	ClickHouseAddress     string
	ClickHouseDatabase    string
	ClickHouseUsername    string
	ClickHousePassword    string
	ServiceToken          string
	ControlEventsURL      string
	WorkerConcurrency     int
	WorkerPollInterval    time.Duration
	LeaseDuration         time.Duration
	HostDelay             time.Duration
	PublisherPollInterval time.Duration
	AnalyticsPollInterval time.Duration
	AnalyticsBacklogAge   time.Duration
	MigrateOnStart        bool
	AllowPrivateIPs       bool
	Environment           string
}

func Load() (Config, error) {
	cfg := Config{
		HTTPAddress:           value("CRAWLER_HTTP_ADDRESS", ":8081"),
		PostgresURL:           strings.TrimSpace(os.Getenv("CRAWLER_POSTGRES_URL")),
		ClickHouseAddress:     value("CRAWLER_CLICKHOUSE_ADDR", "localhost:19000"),
		ClickHouseDatabase:    value("CRAWLER_CLICKHOUSE_DATABASE", "weblens_crawl_analytics"),
		ClickHouseUsername:    value("CRAWLER_CLICKHOUSE_USERNAME", "default"),
		ClickHousePassword:    os.Getenv("CRAWLER_CLICKHOUSE_PASSWORD"),
		ServiceToken:          strings.TrimSpace(os.Getenv("CRAWLER_SERVICE_TOKEN")),
		ControlEventsURL:      value("CRAWLER_CONTROL_EVENTS_URL", "http://localhost:8080/internal/v1/events/scans"),
		WorkerConcurrency:     intValue("CRAWLER_WORKER_CONCURRENCY", 3),
		WorkerPollInterval:    durationValue("CRAWLER_WORKER_POLL_INTERVAL", 250*time.Millisecond),
		LeaseDuration:         durationValue("CRAWLER_LEASE_DURATION", 30*time.Second),
		HostDelay:             durationValue("CRAWLER_HOST_DELAY", time.Second),
		PublisherPollInterval: durationValue("CRAWLER_PUBLISHER_POLL_INTERVAL", 500*time.Millisecond),
		AnalyticsPollInterval: durationValue("CRAWLER_ANALYTICS_POLL_INTERVAL", 500*time.Millisecond),
		AnalyticsBacklogAge:   durationValue("CRAWLER_ANALYTICS_BACKPRESSURE_AGE", 15*time.Minute),
		MigrateOnStart:        boolValue("CRAWLER_MIGRATE_ON_START", false),
		AllowPrivateIPs:       boolValue("CRAWLER_ALLOW_PRIVATE_IPS", false),
		Environment:           strings.ToLower(value("CRAWLER_ENV", "development")),
	}
	return cfg, cfg.Validate()
}

func (c Config) Validate() error {
	var problems []error
	if c.PostgresURL == "" {
		problems = append(problems, errors.New("CRAWLER_POSTGRES_URL is required"))
	}
	if c.ClickHouseDatabase != "weblens_crawl_analytics" {
		problems = append(problems, errors.New("CRAWLER_CLICKHOUSE_DATABASE must be weblens_crawl_analytics in V1"))
	}
	if len(c.ServiceToken) < 32 {
		problems = append(problems, errors.New("CRAWLER_SERVICE_TOKEN must contain at least 32 bytes"))
	}
	if c.WorkerConcurrency < 1 || c.WorkerConcurrency > 10 {
		problems = append(problems, errors.New("CRAWLER_WORKER_CONCURRENCY must be between 1 and 10"))
	}
	if c.LeaseDuration < 5*time.Second || c.LeaseDuration > 5*time.Minute {
		problems = append(problems, errors.New("CRAWLER_LEASE_DURATION must be between 5s and 5m"))
	}
	if c.HostDelay < 0 || c.HostDelay > time.Minute {
		problems = append(problems, errors.New("CRAWLER_HOST_DELAY must be between 0 and 1m"))
	}
	if c.AnalyticsBacklogAge < time.Minute || c.AnalyticsBacklogAge > 24*time.Hour {
		problems = append(problems, errors.New("CRAWLER_ANALYTICS_BACKPRESSURE_AGE must be between 1m and 24h"))
	}
	if err := validateHTTPURL(c.ControlEventsURL); err != nil {
		problems = append(problems, fmt.Errorf("CRAWLER_CONTROL_EVENTS_URL: %w", err))
	}
	if c.AllowPrivateIPs && c.Environment != "development" && c.Environment != "test" {
		problems = append(problems, errors.New("private IP access is only allowed in development or test"))
	}
	return errors.Join(problems...)
}

func validateHTTPURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return errors.New("must be an absolute HTTP(S) URL without userinfo")
	}
	return nil
}

func value(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}

func intValue(name string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(v)
	if err != nil {
		return -1
	}
	return parsed
}

func durationValue(name string, fallback time.Duration) time.Duration {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(v)
	if err != nil {
		return -1
	}
	return parsed
}

func boolValue(name string, fallback bool) bool {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(v)
	if err != nil {
		return fallback
	}
	return parsed
}
