package httpapi

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/contracts"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

const testServiceToken = "test-service-token-that-is-at-least-32-bytes"

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

func (*fakeCommandStore) ListPages(context.Context, uuid.UUID, uuid.UUID, int, string, uuid.UUID) ([]model.ReportPage, bool, error) {
	return []model.ReportPage{}, false, nil
}

func (*fakeCommandStore) GetPage(context.Context, uuid.UUID, uuid.UUID) (model.ReportPage, error) {
	return model.ReportPage{}, nil
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

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
