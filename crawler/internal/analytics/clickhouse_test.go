package analytics

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	clickhouseDriver "github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

func TestSecureConnectionRequiresHostAndPort(t *testing.T) {
	_, err := openConnection(Options{Address: "clickhouse.example", Database: "analytics", Secure: true}, "analytics", 7)
	if err == nil {
		t.Fatal("secure address without a port was accepted")
	}
}

func TestOpenRejectsInvalidReadBudgetBeforeConnecting(t *testing.T) {
	for _, limit := range []int{-1, 65} {
		if _, err := Open(context.Background(), Options{ReadMaxConnections: limit}); err == nil {
			t.Fatal("unsafe read budget accepted")
		}
	}
}

func TestHTTPTransportKeepsTLSValidationAndMigrationGate(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("untrusted TLS reached HTTP") }))
	defer server.Close()
	connection, err := openConnection(Options{Address: "unused:9000", HTTPURL: server.URL}, "default", 7)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := connection.Ping(ctx); err == nil {
		t.Fatal("untrusted HTTPS certificate accepted")
	}
	if err := Migrate(ctx, Options{HTTPURL: server.URL}); err == nil {
		t.Fatal("HTTP migration gate bypassed")
	}
}

func TestHTTPReportDeadlineReleasesSlot(t *testing.T) {
	stop := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		select {
		case <-request.Context().Done():
		case <-stop:
		}
	}))
	defer server.Close()
	defer close(stop)
	connection, err := openConnection(Options{Address: "unused:9000", HTTPURL: server.URL}, "default", 1)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	sink := &Sink{readConnection: connection, readSlots: make(chan struct{}, 1), database: "default", logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, _, err = sink.ListPages(ctx, uuid.New(), uuid.New(), 20, "", uuid.Nil, model.PageFilters{})
	if err == nil || time.Since(started) > time.Second || len(sink.readSlots) != 0 {
		t.Fatal("HTTP deadline failed or retained report capacity")
	}
}

// A real native client connects to an owned loopback peer, not a query mock.
func TestNativeReportHandshakeFaultsReleaseCapacity(t *testing.T) {
	for _, operation := range []string{"pages", "summary", "page_detail"} {
		for _, faultCase := range []string{"disconnect", "deadline", "cancel", "tls_disconnect", "tls_deadline", "tls_cancel"} {
			t.Run(operation+"/"+faultCase, func(t *testing.T) {
				secure := strings.HasPrefix(faultCase, "tls_")
				fault := strings.TrimPrefix(faultCase, "tls_")
				listener, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = listener.Close() })
				accepted := make(chan net.Conn, 1)
				peerDone := make(chan struct{})
				go func() {
					defer close(peerDone)
					peer, acceptErr := listener.Accept()
					if acceptErr != nil {
						return
					}
					defer peer.Close()
					var hello [1]byte
					if _, readErr := io.ReadFull(peer, hello[:]); readErr != nil {
						return
					}
					accepted <- peer
					if fault != "disconnect" {
						_, _ = io.Copy(io.Discard, peer)
					}
				}()
				connection, err := openConnection(Options{Address: listener.Addr().String(), Secure: secure}, "analytics", 1)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = connection.Close() })
				var traceOutput bytes.Buffer
				sink := &Sink{readConnection: connection, database: "analytics", readSlots: make(chan struct{}, 1),
					logger: slog.New(slog.NewJSONHandler(&traceOutput, &slog.HandlerOptions{Level: slog.LevelDebug}))}
				ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
				ctx = WithReportCorrelation(ctx, "owned-native-fault")
				defer cancel()
				result := make(chan error, 1)
				started := time.Now()
				go func() {
					var reportErr error
					switch operation {
					case "pages":
						_, _, reportErr = sink.ListPages(ctx, uuid.New(), uuid.New(), 10, "", uuid.Nil, model.PageFilters{})
					case "summary":
						_, reportErr = sink.ScanSummary(ctx, uuid.New(), uuid.New())
					case "page_detail":
						_, reportErr = sink.GetPage(ctx, uuid.New(), uuid.New())
					}
					result <- reportErr
				}()
				var peer net.Conn
				select {
				case peer = <-accepted:
				case <-time.After(time.Second):
					t.Fatal("native client did not reach the loopback peer")
				}
				t.Cleanup(func() {
					_ = peer.Close()
					select {
					case <-peerDone:
					case <-time.After(time.Second):
						t.Error("owned peer did not exit")
					}
				})
				if fault == "cancel" {
					cancel()
				}
				select {
				case reportErr := <-result:
					if reportErr == nil {
						t.Fatal("native handshake failure became a successful report")
					}
					if fault != "disconnect" && !errors.Is(reportErr, ctx.Err()) {
						t.Fatalf("request cancellation was not preserved: error type %T", reportErr)
					}
					if len(sink.readSlots) != 0 || connection.Stats().Open != 0 {
						t.Fatal("failed handshake retained report/native capacity")
					}
					var phaseTraces int
					for _, line := range strings.Split(strings.TrimSpace(traceOutput.String()), "\n") {
						var trace map[string]any
						if err := json.Unmarshal([]byte(line), &trace); err != nil {
							t.Fatal(err)
						}
						if trace["msg"] != "ClickHouse native dial timing" {
							continue
						}
						phaseTraces++
						expectedPhase := "native_setup"
						if secure {
							expectedPhase = "tcp_tls"
						}
						if trace["last_phase"] != expectedPhase || trace["secure"] != secure ||
							trace["success"] != false || trace["correlationId"] != "owned-native-fault" ||
							trace["context_cancelled"] != (fault != "disconnect") ||
							trace["operation"] != operation {
							t.Fatal("native phase trace lost failure, cancellation or request identity")
						}
						for _, field := range []string{"tcp_tls_ms", "native_setup_ms", "dial_ms"} {
							if value, ok := trace[field].(float64); !ok || value < 0 {
								t.Fatal("invalid native timing")
							}
						}
						if _, err := uuid.Parse(trace["query_id"].(string)); err != nil {
							t.Fatal(err)
						}
					}
					if phaseTraces != 1 || strings.Contains(traceOutput.String(), listener.Addr().String()) {
						t.Fatal("native trace was missing, duplicated or leaked endpoint")
					}
					t.Logf("fault=%s elapsed=%s report_slots=0 native_open=0", fault, time.Since(started))
				case <-time.After(time.Second):
					_ = peer.Close()
					<-result
					t.Fatal("native handshake outlived request cancellation by more than one second")
				}
			})
		}
	}
}

func TestNativeDialKeepsTLSCertificateValidation(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer server.Close()
	connection, err := openConnection(Options{Address: server.Listener.Addr().String(), Secure: true}, "analytics", 1)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err = connection.Ping(ctx)
	var untrusted x509.UnknownAuthorityError
	if !errors.As(err, &untrusted) {
		t.Fatalf("expected an untrusted TLS certificate to be rejected, got error type %T", err)
	}
	if connection.Stats().Open != 0 {
		t.Fatal("TLS rejection retained native capacity")
	}
}

func TestReportQueryTraceKeepsUniqueIDsAndSafeCorrelation(t *testing.T) {
	for _, correlation := range []string{"owned-request-1", "unsafe\r\nAuthorization: secret", strings.Repeat("x", 65), ""} {
		var output bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug}))
		sink := &Sink{readConnection: &reportConnectionStub{}, readSlots: make(chan struct{}, 1), logger: logger}
		ctx := WithReportCorrelation(context.Background(), correlation)
		seen := map[string]bool{}
		for _, operation := range []string{"pages", "findings", "summary"} {
			_, release, err := sink.beginReport(ctx, operation)
			if err != nil {
				t.Fatal(err)
			}
			release()
			release()
		}
		for _, line := range strings.Split(strings.TrimSpace(output.String()), "\n") {
			var entry map[string]any
			if err := json.Unmarshal([]byte(line), &entry); err != nil {
				t.Fatal(err)
			}
			queryID, _ := entry["query_id"].(string)
			if _, err := uuid.Parse(queryID); err != nil || seen[queryID] {
				t.Fatal("query IDs are invalid or reused")
			}
			seen[queryID] = true
			if entry["correlationId"] != ReportCorrelation(ctx) || !reportCorrelationPattern.MatchString(ReportCorrelation(ctx)) {
				t.Fatal("trace lost normalized correlation")
			}
		}
		if len(seen) != 3 || len(sink.readSlots) != 0 || strings.Contains(output.String(), "Authorization") {
			t.Fatal("trace leaked input, lost a query, or retained a slot")
		}
	}
}

type receiptConnectionStub struct {
	driver.Conn
	queries int
	ids     []uuid.UUID
}

func (c *receiptConnectionStub) Query(context.Context, string, ...any) (driver.Rows, error) {
	c.queries++
	return &receiptRowsStub{ids: c.ids}, nil
}

type receiptRowsStub struct {
	driver.Rows
	ids   []uuid.UUID
	index int
}

func (r *receiptRowsStub) Next() bool { return r.index < len(r.ids) }
func (r *receiptRowsStub) Scan(dest ...any) error {
	*dest[0].(*uuid.UUID) = r.ids[r.index]
	r.index++
	return nil
}
func (*receiptRowsStub) Close() error { return nil }
func (*receiptRowsStub) Err() error   { return nil }

func TestBatchReplayChecksAllReceiptsWithOneQuery(t *testing.T) {
	first, second := analyticsBatchFixture(t), analyticsBatchFixture(t)
	connection := &receiptConnectionStub{ids: []uuid.UUID{first.ID, second.ID}}
	sink := &Sink{connection: connection, database: "analytics"}
	results := sink.WriteBatch(context.Background(), []model.AnalyticsBatch{first, second})
	if connection.queries != 1 || len(results) != 2 || results[first.ID] != nil || results[second.ID] != nil {
		t.Fatalf("receipt replay was not batched: queries=%d results=%v", connection.queries, results)
	}
}

type reportConnectionStub struct {
	driver.Conn
	queries, closed int
	rowsClosed      bool
	failure         error
}

func (c *reportConnectionStub) Query(_ context.Context, query string, _ ...any) (driver.Rows, error) {
	c.queries++
	return &reportRowsStub{connection: c, remaining: strings.Contains(query, "page_metrics_current")}, nil
}

func (c *reportConnectionStub) QueryRow(context.Context, string, ...any) driver.Row {
	c.queries++
	return &reportRowStub{failure: c.failure}
}

func (c *reportConnectionStub) Stats() driver.Stats { return driver.Stats{MaxOpenConns: 7} }
func (c *reportConnectionStub) Close() error        { c.closed++; return c.failure }

type reportRowsStub struct {
	driver.Rows
	connection *reportConnectionStub
	remaining  bool
}

func (r *reportRowsStub) Next() bool           { result := r.remaining; r.remaining = false; return result }
func (*reportRowsStub) Scan(dest ...any) error { *dest[0].(*uuid.UUID) = uuid.New(); return nil }
func (r *reportRowsStub) Close() error         { r.connection.rowsClosed = true; return nil }
func (r *reportRowsStub) Err() error           { return r.connection.failure }

type reportRowStub struct {
	driver.Row
	failure error
}

func (r *reportRowStub) Scan(...any) error { return r.failure }

func TestReportsUseReadPoolAndReleaseRowsOnFailure(t *testing.T) {
	for _, failure := range []error{nil, context.DeadlineExceeded} {
		read, write := &reportConnectionStub{failure: failure}, &reportConnectionStub{}
		sink := &Sink{connection: write, readConnection: read, readSlots: make(chan struct{}, 1), database: "analytics", logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
		_, _, pageErr := sink.ListPages(context.Background(), uuid.New(), uuid.New(), 10, "", uuid.Nil, model.PageFilters{})
		_, summaryErr := sink.ScanSummary(context.Background(), uuid.New(), uuid.New())
		_, detailErr := sink.GetPage(context.Background(), uuid.New(), uuid.New())
		if read.queries < 3 || write.queries != 0 || !read.rowsClosed {
			t.Fatalf("report used write pool or leaked rows: read=%d write=%d closed=%v", read.queries, write.queries, read.rowsClosed)
		}
		if failure != nil && (!errors.Is(pageErr, failure) || !errors.Is(summaryErr, failure) || !errors.Is(detailErr, failure)) {
			t.Fatal("report hid a ClickHouse failure")
		}
		if err := sink.Close(); !errors.Is(err, failure) || read.closed != 1 || write.closed != 1 {
			t.Fatalf("pool close did not release both pools: err=%v read=%d write=%d", err, read.closed, write.closed)
		}
	}
}

func TestReportAdmissionDeadlineDoesNotCallClickHouse(t *testing.T) {
	read := &reportConnectionStub{}
	sink := &Sink{readConnection: read, readSlots: make(chan struct{}, 1), logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	sink.readSlots <- struct{}{}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := sink.ScanSummary(ctx, uuid.New(), uuid.New())
	if !errors.Is(err, context.DeadlineExceeded) || read.queries != 0 || len(sink.readSlots) != 1 {
		t.Fatalf("admission deadline called ClickHouse or lost another caller's slot: err=%v queries=%d slots=%d", err, read.queries, len(sink.readSlots))
	}
}

func TestDecodeAnalyticsBatchAcceptsJSONBNormalizedPayload(t *testing.T) {
	batch := analyticsBatchFixture(t)
	var normalized map[string]any
	decoder := json.NewDecoder(bytes.NewReader(batch.Payload))
	decoder.UseNumber()
	if err := decoder.Decode(&normalized); err != nil {
		t.Fatalf("decode analytics fixture: %v", err)
	}
	normalizedPayload, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		t.Fatalf("normalize analytics fixture: %v", err)
	}
	batch.Payload = normalizedPayload

	payload, err := decodeAnalyticsBatch(batch)

	if err != nil {
		t.Fatalf("decode JSONB-normalized payload: %v", err)
	}
	if payload.PageID != batch.PageID {
		t.Fatalf("expected page %s, got %s", batch.PageID, payload.PageID)
	}
}

func TestDecodeAnalyticsBatchRejectsSemanticPayloadChange(t *testing.T) {
	batch := analyticsBatchFixture(t)
	var tampered map[string]any
	if err := json.Unmarshal(batch.Payload, &tampered); err != nil {
		t.Fatalf("decode analytics fixture: %v", err)
	}
	tampered["hostname"] = "tampered.example"
	tamperedPayload, err := json.Marshal(tampered)
	if err != nil {
		t.Fatalf("encode tampered analytics fixture: %v", err)
	}
	batch.Payload = tamperedPayload

	_, err = decodeAnalyticsBatch(batch)

	if err == nil || err.Error() != "analytics payload checksum mismatch" {
		t.Fatalf("expected checksum mismatch, got %v", err)
	}
}

func TestObjectAlreadyExistsOnlyAcceptsClickHouseCode57(t *testing.T) {
	if !isObjectAlreadyExists(&clickhouseDriver.Exception{Code: 57}) {
		t.Fatal("expected ClickHouse code 57 to be accepted")
	}
	if isObjectAlreadyExists(&clickhouseDriver.Exception{Code: 60}) {
		t.Fatal("did not expect ClickHouse code 60 to be accepted")
	}
	if isObjectAlreadyExists(errors.New("table already exists")) {
		t.Fatal("did not expect an untyped error to be accepted")
	}
}

func analyticsBatchFixture(t *testing.T) model.AnalyticsBatch {
	t.Helper()
	ownerID, scanID, pageID := uuid.New(), uuid.New(), uuid.New()
	now := time.Date(2026, time.September, 12, 8, 30, 0, 0, time.UTC)
	payload := model.AnalyticsPayload{
		SchemaVersion: 1,
		OwnerID:       ownerID,
		ScanID:        scanID,
		RetentionMonth: time.Date(
			now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC,
		),
		PageID:           pageID,
		RecordVersion:    1,
		RequestedURL:     "https://example.com/",
		NormalizedURL:    "https://example.com/",
		FinalURL:         "https://example.com/",
		Hostname:         "example.com",
		CollectorVersion: "test-collector-v1",
		ParserVersion:    "test-parser-v1",
		Result: model.PageResult{
			FinalURL:     "https://example.com/",
			FetchOutcome: "SUCCESS",
			StatusCode:   200,
			ContentType:  "text/html",
			ObservedAt:   now,
			Findings: []model.Finding{{
				FindingID: uuid.New(), RuleID: "numeric-evidence", RuleVersion: 1,
				Category: "CONTENT", Severity: "INFO", Code: "NUMERIC_EVIDENCE",
				Message: "Preserve an exact integer.", Evidence: map[string]any{"exact": int64(9_007_199_254_740_993)},
			}},
		},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode analytics fixture: %v", err)
	}
	checksum := sha256.Sum256(encoded)
	return model.AnalyticsBatch{
		ID:            uuid.New(),
		OwnerID:       ownerID,
		PageID:        pageID,
		ResultVersion: 1,
		Payload:       encoded,
		PayloadSHA256: checksum[:],
	}
}
