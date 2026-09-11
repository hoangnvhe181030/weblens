package analytics

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

func TestClickHouseBatchIntegration(t *testing.T) {
	address := os.Getenv("WEBLENS_TEST_CLICKHOUSE_ADDR")
	if address == "" {
		t.Skip("set WEBLENS_TEST_CLICKHOUSE_ADDR to run ClickHouse integration tests")
	}
	options := Options{
		Address: address, Database: "weblens_crawl_analytics",
		Username: envOrDefault("WEBLENS_TEST_CLICKHOUSE_USERNAME", "default"),
		Password: os.Getenv("WEBLENS_TEST_CLICKHOUSE_PASSWORD"),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := Migrate(ctx, options); err != nil {
		t.Fatalf("migrate ClickHouse test database: %v", err)
	}
	sink, err := Open(ctx, options)
	if err != nil {
		t.Fatalf("open ClickHouse test database: %v", err)
	}
	t.Cleanup(func() { _ = sink.Close() })

	ownerID, scanID := uuid.New(), uuid.New()
	batches := []model.AnalyticsBatch{
		newAnalyticsBatch(t, ownerID, scanID, "https://example.com/"),
		newAnalyticsBatch(t, ownerID, scanID, "https://example.com/about"),
	}
	for batchID, writeErr := range sink.WriteBatch(ctx, batches) {
		if writeErr != nil {
			t.Fatalf("write batch %s: %v", batchID, writeErr)
		}
	}
	for batchID, writeErr := range sink.WriteBatch(ctx, batches) {
		if writeErr != nil {
			t.Fatalf("replay batch %s: %v", batchID, writeErr)
		}
	}

	assertClickHouseCount(t, ctx, sink, "page_metrics_current", ownerID, scanID, 2)
	assertClickHouseCount(t, ctx, sink, "findings_current", ownerID, scanID, 2)
	assertClickHouseCount(t, ctx, sink, "page_links_current", ownerID, scanID, 2)
	var receipts uint64
	if err := sink.connection.QueryRow(ctx, `
		SELECT count()
		FROM weblens_crawl_analytics.ingestion_receipts_current
		WHERE owner_id = ? AND aggregate_id = ?`, ownerID, scanID).Scan(&receipts); err != nil {
		t.Fatalf("count ClickHouse receipts: %v", err)
	}
	if receipts != 2 {
		t.Fatalf("expected 2 receipts after replay, got %d", receipts)
	}
}

func newAnalyticsBatch(t *testing.T, ownerID, scanID uuid.UUID, pageURL string) model.AnalyticsBatch {
	t.Helper()
	pageID, batchID := uuid.New(), uuid.New()
	now := time.Now().UTC()
	payload := model.AnalyticsPayload{
		SchemaVersion: 1, OwnerID: ownerID, ScanID: scanID,
		RetentionMonth: time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC),
		PageID:         pageID, RecordVersion: 1, RequestedURL: pageURL,
		NormalizedURL: pageURL, FinalURL: pageURL, Hostname: "example.com",
		CollectorVersion: "integration-test-v1", ParserVersion: "integration-test-v1",
		Result: model.PageResult{
			FinalURL: pageURL, FetchOutcome: "SUCCESS", StatusCode: 200,
			ContentType: "text/html", Title: "Integration", H1: []string{"Integration"},
			IsIndexable: true, ObservedAt: now,
			Findings: []model.Finding{{
				FindingID: uuid.NewSHA1(pageID, []byte("title.integration:1")),
				RuleID:    "title.integration", RuleVersion: 1, Category: "CONTENT",
				Severity: "INFO", Code: "INTEGRATION", Message: "Integration finding.",
				Evidence: map[string]any{"source": "integration-test"},
			}},
			Links: []model.DiscoveredLink{{
				TargetURL: "https://example.com/target", AnchorText: "Target", Tag: "a",
				IsInternal: true, IsFollowable: true, Ordinal: 0,
			}},
		},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal analytics test payload: %v", err)
	}
	checksum := sha256.Sum256(encoded)
	return model.AnalyticsBatch{
		ID: batchID, RetentionMonth: payload.RetentionMonth, OwnerID: ownerID,
		PageID: pageID, ResultVersion: 1, Payload: encoded, PayloadSHA256: checksum[:],
	}
}

func assertClickHouseCount(
	t *testing.T,
	ctx context.Context,
	sink *Sink,
	table string,
	ownerID, scanID uuid.UUID,
	expected uint64,
) {
	t.Helper()
	var count uint64
	query := "SELECT count() FROM weblens_crawl_analytics." + table +
		" WHERE owner_id = ? AND scan_id = ?"
	if err := sink.connection.QueryRow(ctx, query, ownerID, scanID).Scan(&count); err != nil {
		t.Fatalf("count ClickHouse %s: %v", table, err)
	}
	if count != expected {
		t.Fatalf("expected %d rows in %s, got %d", expected, table, count)
	}
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
