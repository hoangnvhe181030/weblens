package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/analytics"
	"github.com/weblens-project/weblens-crawler/internal/contracts"
	"github.com/weblens-project/weblens-crawler/internal/model"
	"github.com/weblens-project/weblens-crawler/internal/postgres"
)

const testServiceToken = "test-service-token-that-is-at-least-32-bytes"

func TestRabbitModeDisablesHTTPCommandAcceptance(t *testing.T) {
	store := &fakeCommandStore{}
	server := NewServer(store, store, testServiceToken, slog.New(slog.NewTextHandler(io.Discard, nil)))
	server.DisableHTTPCommands()
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/commands/scans", strings.NewReader("{}"))
	req.Header.Set("X-WebLens-Service-Token", testServiceToken)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, req)
	if response.Code != http.StatusServiceUnavailable || store.called {
		t.Fatal("HTTP command reached persistence in RabbitMQ mode")
	}
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health/live", nil))
	if response.Code != http.StatusOK {
		t.Fatal("RabbitMQ mode disabled HTTP health")
	}
}

type fakeCommandStore struct {
	called bool
}

func (store *fakeCommandStore) AcceptCommand(_ context.Context, _ contracts.ScanCommandEnvelope) (bool, error) {
	store.called = true
	return false, nil
}

func (store *fakeCommandStore) AcceptCancellation(_ context.Context, _ contracts.ScanCancelCommandEnvelope) (bool, error) {
	store.called = true
	return false, nil
}

func (*fakeCommandStore) Ping(context.Context) error { return nil }

func (*fakeCommandStore) GetReportState(_ context.Context, ownerID, scanID uuid.UUID) (model.ReportState, error) {
	return model.ReportState{OwnerID: ownerID, ScanID: scanID}, nil
}

func (*fakeCommandStore) ListPages(context.Context, uuid.UUID, uuid.UUID, int, string, uuid.UUID, model.PageFilters) ([]model.ReportPage, bool, error) {
	return []model.ReportPage{}, false, nil
}

func (*fakeCommandStore) ScanSummary(context.Context, uuid.UUID, uuid.UUID) (model.ScanReportSummary, error) {
	return model.ScanReportSummary{}, nil
}

func (*fakeCommandStore) GetPage(context.Context, uuid.UUID, uuid.UUID) (model.ReportPage, error) {
	return model.ReportPage{}, nil
}

type correlationReportStore struct {
	fakeCommandStore
	correlation string
}

func (s *correlationReportStore) GetReportState(ctx context.Context, ownerID, scanID uuid.UUID) (model.ReportState, error) {
	s.correlation = analytics.ReportCorrelation(ctx)
	return model.ReportState{OwnerID: ownerID, ScanID: scanID}, nil
}

func TestReportContextMatchesResponseCorrelation(t *testing.T) {
	for _, correlation := range []string{"valid-trace-1", "  valid-trace-2  ", "invalid\r\nsecret", ""} {
		store := &correlationReportStore{}
		server := NewServer(store, store, testServiceToken, testLogger())
		request := httptest.NewRequest(http.MethodGet, "/internal/v1/reports/scans/"+uuid.NewString()+"/pages?ownerId="+uuid.NewString(), nil)
		request.Header.Set("X-WebLens-Service-Token", testServiceToken)
		request.Header.Set("X-Correlation-ID", correlation)
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusOK || store.correlation != response.Header().Get("X-Correlation-ID") || !correlationIDPattern.MatchString(store.correlation) {
			t.Fatal("response and downstream context correlation differ")
		}
	}
}

type blockingHTTPReports struct {
	fakeCommandStore
	entered chan context.Context
	stop    chan struct{}
}

func (s *blockingHTTPReports) wait(ctx context.Context) error {
	s.entered <- ctx
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.stop:
		return context.Canceled
	}
}

func (s *blockingHTTPReports) ListPages(ctx context.Context, _ uuid.UUID, _ uuid.UUID, _ int, _ string, _ uuid.UUID, _ model.PageFilters) ([]model.ReportPage, bool, error) {
	return nil, false, s.wait(ctx)
}

func (s *blockingHTTPReports) GetPage(ctx context.Context, _ uuid.UUID, _ uuid.UUID) (model.ReportPage, error) {
	return model.ReportPage{}, s.wait(ctx)
}

func TestHTTPTransportCancellationReachesReportContext(t *testing.T) {
	for _, secure := range []bool{false, true} {
		for _, pages := range []bool{false, true} {
			for _, timeout := range []bool{false, true} {
				name := fmt.Sprintf("tls=%t/pages=%t/timeout=%t", secure, pages, timeout)
				t.Run(name, func(t *testing.T) {
					store := &reportTestStore{state: model.ReportState{AnalyticsExpectedCount: 1, AnalyticsPublishedCount: 1}}
					reports := &blockingHTTPReports{entered: make(chan context.Context, 1), stop: make(chan struct{})}
					finished := make(chan struct{})
					handler := NewServer(store, reports, testServiceToken, testLogger()).Handler()
					wrapped := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						defer close(finished)
						handler.ServeHTTP(w, r)
					})
					var server *httptest.Server
					if secure {
						server = httptest.NewTLSServer(wrapped)
					} else {
						server = httptest.NewServer(wrapped)
					}
					client := server.Client()
					client.Timeout = 2 * time.Second
					if timeout {
						client.Timeout = 300 * time.Millisecond
					}
					ctx, cancel := context.WithCancel(context.Background())
					defer func() {
						cancel()
						close(reports.stop)
						client.CloseIdleConnections()
						server.Close()
					}()
					path := "/internal/v1/reports/pages/" + uuid.NewString() + "?ownerId=" + uuid.NewString()
					if pages {
						path = "/internal/v1/reports/scans/" + uuid.NewString() + "/pages?ownerId=" + uuid.NewString()
					}
					request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+path, nil)
					if err != nil {
						t.Fatal(err)
					}
					request.Header.Set("X-WebLens-Service-Token", testServiceToken)
					request.Header.Set("X-Correlation-ID", "owned-transport-cancel")
					result := make(chan error, 1)
					go func() {
						response, err := client.Do(request)
						if response != nil {
							_ = response.Body.Close()
						}
						result <- err
					}()
					var reportCtx context.Context
					select {
					case reportCtx = <-reports.entered:
					case <-time.After(time.Second):
						t.Fatal("HTTP fixture did not reach report reader")
					}
					if analytics.ReportCorrelation(reportCtx) != "owned-transport-cancel" {
						t.Fatal("HTTP boundary lost report correlation")
					}
					started := time.Now()
					if !timeout {
						cancel()
					}
					select {
					case err := <-result:
						want := context.Canceled
						if timeout {
							want = context.DeadlineExceeded
						}
						if !errors.Is(err, want) {
							t.Fatalf("unexpected HTTP cancellation result: %v", err)
						}
					case <-time.After(time.Second):
						t.Fatal("HTTP client did not finish within fixture bound")
					}
					select {
					case <-finished:
						if reportCtx.Err() != context.Canceled {
							t.Fatal("HTTP disconnect did not cancel the downstream report context")
						}
					case <-time.After(time.Second):
						t.Fatal("report handler remained running after HTTP disconnect")
					}
					t.Logf("client_cancel_to_handler_finish=%s", time.Since(started))
				})
			}
		}
	}
}
func TestCommandEndpointRequiresServiceToken(t *testing.T) {
	t.Parallel()
	store := &fakeCommandStore{}
	server := NewServer(store, store, testServiceToken, testLogger())
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/commands/scans", strings.NewReader("{}"))
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || store.called {
		t.Fatalf("unexpected response: status=%d called=%v", response.Code, store.called)
	}
	if response.Header().Get("Content-Type") != "application/problem+json" || response.Header().Get("X-Correlation-ID") == "" {
		t.Fatalf("problem response is missing standard headers: %v", response.Header())
	}
}

func TestCommandEndpointRejectsWrongServiceToken(t *testing.T) {
	t.Parallel()
	store := &fakeCommandStore{}
	server := NewServer(store, store, testServiceToken, testLogger())
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/commands/scans", strings.NewReader("{}"))
	request.Header.Set("X-WebLens-Service-Token", "a-different-service-token-at-least-32-bytes")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || store.called {
		t.Fatalf("unexpected response: status=%d called=%v", response.Code, store.called)
	}
}

func TestCommandEndpointRejectsBodyLargerThan64KiB(t *testing.T) {
	t.Parallel()
	store := &fakeCommandStore{}
	server := NewServer(store, store, testServiceToken, testLogger())
	request := httptest.NewRequest(
		http.MethodPost,
		"/internal/v1/commands/scans",
		strings.NewReader(strings.Repeat("x", maxCommandBody+1)),
	)
	request.Header.Set("X-WebLens-Service-Token", testServiceToken)
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusRequestEntityTooLarge || store.called {
		t.Fatalf("unexpected response: status=%d called=%v", response.Code, store.called)
	}
}

func TestPageFiltersAreNormalizedAndValidated(t *testing.T) {
	t.Parallel()
	request := httptest.NewRequest(http.MethodGet,
		"/internal/v1/reports/scans/id/pages?outcome=failed&outcome=SUCCESS&statusMin=400&statusMax=599&q=docs&indexable=false&contentType=Text%2FHTML&severity=warning&findingCode=title.missing",
		nil,
	)
	filters, err := pageFiltersQuery(request)
	if err != nil {
		t.Fatal(err)
	}
	if len(filters.Outcomes) != 2 || filters.Outcomes[0] != "FAILED" || filters.Outcomes[1] != "SUCCESS" {
		t.Fatalf("unexpected outcomes: %#v", filters.Outcomes)
	}
	if filters.StatusMin == nil || *filters.StatusMin != 400 || filters.StatusMax == nil || *filters.StatusMax != 599 {
		t.Fatalf("unexpected status range: %#v", filters)
	}
	if filters.Indexable == nil || *filters.Indexable || filters.ContentTypes[0] != "text/html" {
		t.Fatalf("unexpected normalized filters: %#v", filters)
	}
}

func TestPageCursorIsBoundToFilters(t *testing.T) {
	t.Parallel()
	store := &fakeCommandStore{}
	server := NewServer(store, store, testServiceToken, testLogger())
	cursor := encodePageCursor(pageCursor{URL: "https://example.com/", ID: uuid.New(), Filter: "another-filter"})
	request := httptest.NewRequest(http.MethodGet,
		"/internal/v1/reports/scans/"+uuid.NewString()+"/pages?ownerId="+uuid.NewString()+"&issuesOnly=true&cursor="+url.QueryEscape(cursor),
		nil,
	)
	request.Header.Set("X-WebLens-Service-Token", testServiceToken)
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("expected filter-bound cursor rejection, got %d", response.Code)
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

type reportTestStore struct {
	fakeCommandStore
	state      model.ReportState
	stateError error
	reads      int
}

func (s *reportTestStore) GetReportState(_ context.Context, owner, scan uuid.UUID) (model.ReportState, error) {
	state := s.state
	state.OwnerID, state.ScanID = owner, scan
	return state, s.stateError
}

func (s *reportTestStore) ListPages(context.Context, uuid.UUID, uuid.UUID, int, string, uuid.UUID, model.PageFilters) ([]model.ReportPage, bool, error) {
	s.reads++
	return nil, false, errors.New("ClickHouse unavailable")
}

func TestEmptyReportShortcutKeepsValidationAndDoesNotHidePendingAnalytics(t *testing.T) {
	for _, tc := range []struct {
		name, query                        string
		expected, published, status, reads int
		stateError                         error
	}{
		{name: "empty", status: 200},
		{name: "bad filter", query: "&outcome=invalid", status: 400},
		{name: "bad cursor", query: "&cursor=invalid", status: 400},
		{name: "bad limit", query: "&limit=0", status: 400},
		{name: "wrong owner or missing scan", stateError: postgres.ErrReportNotFound, status: 404},
		{name: "state unavailable", stateError: errors.New("database unavailable"), status: 503},
		{name: "unacknowledged writes", expected: 1, status: 503, reads: 1},
		{name: "published data", expected: 1, published: 1, status: 503, reads: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &reportTestStore{state: model.ReportState{Status: "QUEUED",
				AnalyticsExpectedCount: tc.expected, AnalyticsPublishedCount: tc.published}, stateError: tc.stateError}
			server := NewServer(store, store, testServiceToken, testLogger())
			request := httptest.NewRequest(http.MethodGet, "/internal/v1/reports/scans/"+uuid.NewString()+"/pages?ownerId="+uuid.NewString()+tc.query, nil)
			request.Header.Set("X-WebLens-Service-Token", testServiceToken)
			response := httptest.NewRecorder()
			server.Handler().ServeHTTP(response, request)
			if response.Code != tc.status || store.reads != tc.reads {
				t.Fatalf("status=%d reads=%d, want status=%d reads=%d", response.Code, store.reads, tc.status, tc.reads)
			}
			if response.Code == 200 {
				var report model.ScanPagesReport
				if err := json.Unmarshal(response.Body.Bytes(), &report); err != nil || report.Items == nil || len(report.Items) != 0 || report.NextCursor != "" || report.Summary.TotalURLCount != 0 {
					t.Fatalf("invalid empty report: %s", response.Body.String())
				}
			}
		})
	}
}
