package analytics

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	clickhouseDriver "github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/crawl"
	"github.com/weblens-project/weblens-crawler/internal/model"
	"github.com/weblens-project/weblens-crawler/migrations"
)

type Sink struct {
	connection driver.Conn
	database   string
}

type Options struct {
	Address  string
	Database string
	Username string
	Password string
}

func Open(ctx context.Context, options Options) (*Sink, error) {
	connection, err := openConnection(options, options.Database)
	if err != nil {
		return nil, err
	}
	if err := connection.Ping(ctx); err != nil {
		return nil, fmt.Errorf("ping ClickHouse: %w", err)
	}
	return &Sink{connection: connection, database: options.Database}, nil
}

func Migrate(ctx context.Context, options Options) error {
	connection, err := openConnection(options, "default")
	if err != nil {
		return err
	}
	if err := connection.Ping(ctx); err != nil {
		return fmt.Errorf("ping ClickHouse for migration: %w", err)
	}
	body, err := migrations.Files.ReadFile("clickhouse/001_create_crawl_analytics.sql")
	if err != nil {
		return fmt.Errorf("read ClickHouse migration: %w", err)
	}
	for _, statement := range splitStatements(string(body)) {
		if err := connection.Exec(ctx, statement); err != nil {
			return fmt.Errorf("apply ClickHouse migration: %w", err)
		}
	}
	return nil
}

func openConnection(options Options, database string) (driver.Conn, error) {
	if strings.TrimSpace(options.Address) == "" || strings.TrimSpace(database) == "" {
		return nil, errors.New("ClickHouse address and database are required")
	}
	return clickhouseDriver.Open(&clickhouseDriver.Options{
		Addr:        []string{options.Address},
		Auth:        clickhouseDriver.Auth{Database: database, Username: options.Username, Password: options.Password},
		DialTimeout: 5 * time.Second, MaxOpenConns: 10, MaxIdleConns: 5,
		ConnMaxLifetime: 30 * time.Minute,
		Compression:     &clickhouseDriver.Compression{Method: clickhouseDriver.CompressionLZ4},
	})
}

func splitStatements(script string) []string {
	var statements []string
	for _, candidate := range strings.Split(script, ";") {
		lines := strings.Split(candidate, "\n")
		kept := make([]string, 0, len(lines))
		for _, line := range lines {
			if !strings.HasPrefix(strings.TrimSpace(line), "--") {
				kept = append(kept, line)
			}
		}
		statement := strings.TrimSpace(strings.Join(kept, "\n"))
		if statement != "" {
			statements = append(statements, statement)
		}
	}
	return statements
}

func (s *Sink) Ping(ctx context.Context) error {
	return s.connection.Ping(ctx)
}

func (s *Sink) Close() error {
	return s.connection.Close()
}

func (s *Sink) Write(ctx context.Context, batch model.AnalyticsBatch) error {
	return s.WriteBatch(ctx, []model.AnalyticsBatch{batch})[batch.ID]
}

type preparedAnalytics struct {
	outbox  model.AnalyticsBatch
	payload model.AnalyticsPayload
}

func (s *Sink) WriteBatch(ctx context.Context, batches []model.AnalyticsBatch) map[uuid.UUID]error {
	results := make(map[uuid.UUID]error, len(batches))
	pending := make([]preparedAnalytics, 0, len(batches))
	for _, batch := range batches {
		payload, err := decodeAnalyticsBatch(batch)
		if err != nil {
			results[batch.ID] = err
			continue
		}
		exists, err := s.receiptExists(ctx, batch, payload)
		if err != nil {
			results[batch.ID] = err
			continue
		}
		if exists {
			results[batch.ID] = nil
			continue
		}
		pending = append(pending, preparedAnalytics{outbox: batch, payload: payload})
	}
	if len(pending) == 0 {
		return results
	}

	if err := s.insertPageMetrics(ctx, pending); err != nil {
		return sharedFailure(results, pending, err)
	}
	if err := s.insertFindings(ctx, pending); err != nil {
		return sharedFailure(results, pending, err)
	}
	if err := s.insertLinks(ctx, pending); err != nil {
		return sharedFailure(results, pending, err)
	}
	if err := s.insertReceipts(ctx, pending); err != nil {
		return sharedFailure(results, pending, err)
	}
	for _, item := range pending {
		results[item.outbox.ID] = nil
	}
	return results
}

func decodeAnalyticsBatch(batch model.AnalyticsBatch) (model.AnalyticsPayload, error) {
	var payload model.AnalyticsPayload
	if err := json.Unmarshal(batch.Payload, &payload); err != nil {
		return model.AnalyticsPayload{}, fmt.Errorf("decode analytics payload: %w", err)
	}
	if payload.OwnerID != batch.OwnerID || payload.PageID != batch.PageID || int64(payload.RecordVersion) != batch.ResultVersion {
		return model.AnalyticsPayload{}, errors.New("analytics payload identifiers do not match outbox metadata")
	}
	if !equalHash(batch.PayloadSHA256, batch.Payload) {
		return model.AnalyticsPayload{}, errors.New("analytics payload checksum mismatch")
	}
	return payload, nil
}

func (s *Sink) receiptExists(ctx context.Context, batch model.AnalyticsBatch, payload model.AnalyticsPayload) (bool, error) {
	var existing uint64
	err := s.connection.QueryRow(ctx, fmt.Sprintf(`
        SELECT count()
        FROM %s.ingestion_receipts FINAL
        WHERE owner_id = ? AND aggregate_id = ? AND batch_id = ?`, quoteIdentifier(s.database)),
		payload.OwnerID, payload.ScanID, batch.ID,
	).Scan(&existing)
	if err != nil {
		return false, fmt.Errorf("read ClickHouse ingestion receipt: %w", err)
	}
	return existing > 0, nil
}

func sharedFailure(results map[uuid.UUID]error, pending []preparedAnalytics, err error) map[uuid.UUID]error {
	for _, item := range pending {
		results[item.outbox.ID] = err
	}
	return results
}

func (s *Sink) insertPageMetrics(ctx context.Context, items []preparedAnalytics) error {
	batch, err := s.connection.PrepareBatch(ctx, fmt.Sprintf(`INSERT INTO %s.page_metrics`, quoteIdentifier(s.database)))
	if err != nil {
		return fmt.Errorf("prepare ClickHouse page metric: %w", err)
	}
	for _, item := range items {
		payload, result := item.payload, item.payload.Result
		normalizedHash := crawl.URLHash(payload.NormalizedURL)
		if err := batch.Append(
			payload.OwnerID, payload.ScanID, payload.RetentionMonth, payload.PageID,
			payload.RecordVersion, uint8(0), payload.SchemaVersion,
			payload.RequestedURL, payload.NormalizedURL, normalizedHash[:], result.FinalURL,
			payload.Hostname, payload.DiscoveryDepth, result.FetchOutcome, result.ErrorCode,
			result.ErrorMessage, uint16(max(result.StatusCode, 0)), result.ContentType, "",
			uint8(len(result.RedirectURLs)), result.RedirectURLs, result.RedirectCodes,
			result.ResponseBytes, result.ResponseBytes,
			uint32(0), uint32(0), uint32(0), uint32(0), result.TotalMillis,
			result.Title, uint16(min(len(result.Title), 65535)), result.Description,
			uint16(min(len(result.Description), 65535)), result.CanonicalURL, result.MetaRobots,
			result.HTMLLang, result.H1, result.H2, result.WordCount, result.InternalLinks,
			result.ExternalLinks, result.ImageCount, result.MissingAlt, boolByte(result.IsIndexable),
			float32(0), payload.CollectorVersion, payload.ParserVersion,
			result.ObservedAt, time.Now().UTC(),
		); err != nil {
			return fmt.Errorf("append ClickHouse page metric: %w", err)
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("send ClickHouse page metric: %w", err)
	}
	return nil
}

func (s *Sink) insertFindings(ctx context.Context, items []preparedAnalytics) error {
	total := 0
	for _, item := range items {
		total += len(item.payload.Result.Findings)
	}
	if total == 0 {
		return nil
	}
	batch, err := s.connection.PrepareBatch(ctx, fmt.Sprintf(`INSERT INTO %s.findings`, quoteIdentifier(s.database)))
	if err != nil {
		return fmt.Errorf("prepare ClickHouse findings: %w", err)
	}
	for _, item := range items {
		payload := item.payload
		for _, finding := range payload.Result.Findings {
			evidence, err := json.Marshal(finding.Evidence)
			if err != nil {
				return fmt.Errorf("marshal finding evidence: %w", err)
			}
			if err := batch.Append(
				payload.OwnerID, payload.ScanID, payload.RetentionMonth, payload.PageID,
				finding.FindingID, payload.RecordVersion, uint8(0), payload.SchemaVersion,
				finding.RuleID, finding.RuleVersion, finding.Category, finding.Severity,
				finding.Code, finding.Message, string(evidence), payload.Result.ObservedAt, time.Now().UTC(),
			); err != nil {
				return fmt.Errorf("append ClickHouse finding: %w", err)
			}
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("send ClickHouse findings: %w", err)
	}
	return nil
}

func (s *Sink) insertLinks(ctx context.Context, items []preparedAnalytics) error {
	total := 0
	for _, item := range items {
		total += len(item.payload.Result.Links)
	}
	if total == 0 {
		return nil
	}
	batch, err := s.connection.PrepareBatch(ctx, fmt.Sprintf(`INSERT INTO %s.page_links`, quoteIdentifier(s.database)))
	if err != nil {
		return fmt.Errorf("prepare ClickHouse page links: %w", err)
	}
	for _, item := range items {
		payload := item.payload
		for _, link := range payload.Result.Links {
			targetHash := crawl.URLHash(link.TargetURL)
			targetHost := ""
			if parsed, err := url.Parse(link.TargetURL); err == nil {
				targetHost = strings.ToLower(parsed.Hostname())
			}
			edgeID := uuid.NewSHA1(payload.PageID, []byte(fmt.Sprintf("%d:%s", link.Ordinal, link.TargetURL)))
			if err := batch.Append(
				payload.OwnerID, payload.ScanID, payload.RetentionMonth, payload.PageID,
				edgeID, payload.RecordVersion, uint8(0), payload.SchemaVersion,
				payload.NormalizedURL, link.TargetURL, targetHash[:], targetHost,
				link.AnchorText, link.Tag, link.RelValues, boolByte(link.IsInternal),
				boolByte(link.IsFollowable), link.Ordinal, payload.Result.ObservedAt, time.Now().UTC(),
			); err != nil {
				return fmt.Errorf("append ClickHouse page link: %w", err)
			}
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("send ClickHouse page links: %w", err)
	}
	return nil
}

func (s *Sink) insertReceipts(ctx context.Context, items []preparedAnalytics) error {
	batch, err := s.connection.PrepareBatch(ctx, fmt.Sprintf(`INSERT INTO %s.ingestion_receipts`, quoteIdentifier(s.database)))
	if err != nil {
		return fmt.Errorf("prepare ClickHouse receipt: %w", err)
	}
	for _, item := range items {
		if err := batch.Append(
			item.payload.OwnerID, item.payload.ScanID, item.outbox.ID, uint64(item.outbox.ResultVersion),
			item.outbox.PayloadSHA256, uint32(1), uint32(len(item.payload.Result.Findings)),
			uint32(len(item.payload.Result.Links)), item.payload.SchemaVersion, time.Now().UTC(),
		); err != nil {
			return fmt.Errorf("append ClickHouse receipt: %w", err)
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("send ClickHouse receipt: %w", err)
	}
	return nil
}

func equalHash(expected, payload []byte) bool {
	actual := sha256.Sum256(payload)
	return string(expected) == string(actual[:])
}

func quoteIdentifier(value string) string {
	return "`" + strings.ReplaceAll(value, "`", "``") + "`"
}

func boolByte(value bool) uint8 {
	if value {
		return 1
	}
	return 0
}
