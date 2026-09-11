package postgres

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/weblens-project/weblens-crawler/internal/contracts"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

func TestStoreWorkflowIntegration(t *testing.T) {
	baseDatabaseURL := os.Getenv("WEBLENS_TEST_POSTGRES_URL")
	if baseDatabaseURL == "" {
		t.Skip("set WEBLENS_TEST_POSTGRES_URL to run PostgreSQL integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, baseDatabaseURL)
	if err != nil {
		t.Fatalf("connect integration database: %v", err)
	}
	schemaName := "weblens_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	identifier := pgx.Identifier{schemaName}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		admin.Close(ctx)
		t.Fatalf("create isolated test schema: %v", err)
	}
	t.Cleanup(func() {
		cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupContext, "DROP SCHEMA "+identifier+" CASCADE")
		_ = admin.Close(cleanupContext)
	})
	databaseURL := withSearchPath(t, baseDatabaseURL, schemaName)
	if err := Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate test database: %v", err)
	}
	store, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	t.Cleanup(store.Close)

	t.Run("command idempotency and successful analytics acknowledgement", func(t *testing.T) {
		command := newTestScanCommand("https://success.example.com/")
		duplicate, err := store.AcceptCommand(ctx, command)
		if err != nil || duplicate {
			t.Fatalf("accept first command: duplicate=%v err=%v", duplicate, err)
		}
		duplicate, err = store.AcceptCommand(ctx, command)
		if err != nil || !duplicate {
			t.Fatalf("accept duplicate command: duplicate=%v err=%v", duplicate, err)
		}

		collision := command
		collision.Payload.MaxDepth++
		if _, err := store.AcceptCommand(ctx, collision); !errors.Is(err, ErrMessageCollision) {
			t.Fatalf("expected message collision, got %v", err)
		}

		workerID := uuid.New()
		lease, err := store.ClaimPage(ctx, workerID, time.Minute, 0)
		if err != nil || lease == nil || lease.ScanID != command.Payload.ScanID {
			t.Fatalf("claim seed page: lease=%+v err=%v", lease, err)
		}
		result := successfulPageResult(command.Payload.TargetURL)
		if err := store.CommitPageResult(ctx, *lease, result); err != nil {
			t.Fatalf("commit page result: %v", err)
		}
		if err := store.CommitPageResult(ctx, *lease, result); !errors.Is(err, ErrStaleLease) {
			t.Fatalf("expected stale lease after result commit, got %v", err)
		}

		analyticsWorker := uuid.New()
		batches, err := store.ClaimAnalytics(ctx, analyticsWorker, 10, time.Minute)
		if err != nil || len(batches) != 1 {
			t.Fatalf("claim analytics batch: count=%d err=%v", len(batches), err)
		}
		if err := store.CompleteAnalytics(ctx, batches[0]); err != nil {
			t.Fatalf("acknowledge analytics batch: %v", err)
		}
		state, err := store.GetReportState(ctx, command.Payload.OwnerID, command.Payload.ScanID)
		if err != nil {
			t.Fatalf("read completed report state: %v", err)
		}
		if state.Status != "COMPLETED" || state.AnalyticsExpectedCount != 1 || state.AnalyticsPublishedCount != 1 {
			t.Fatalf("unexpected completed report state: %+v", state)
		}
	})

	t.Run("cancellation fences a leased worker", func(t *testing.T) {
		command := newTestScanCommand("https://cancel.example.com/")
		if _, err := store.AcceptCommand(ctx, command); err != nil {
			t.Fatalf("accept cancellable command: %v", err)
		}
		lease, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
		if err != nil || lease == nil || lease.ScanID != command.Payload.ScanID {
			t.Fatalf("claim cancellable page: lease=%+v err=%v", lease, err)
		}
		cancelCommand := newTestCancelCommand(command, 2)
		duplicate, err := store.AcceptCancellation(ctx, cancelCommand)
		if err != nil || duplicate {
			t.Fatalf("apply cancellation: duplicate=%v err=%v", duplicate, err)
		}
		if err := store.CommitPageResult(ctx, *lease, successfulPageResult(command.Payload.TargetURL)); !errors.Is(err, ErrStaleLease) {
			t.Fatalf("expected cancellation to fence old lease, got %v", err)
		}
		state, err := store.GetReportState(ctx, command.Payload.OwnerID, command.Payload.ScanID)
		if err != nil || state.Status != "CANCELLED" {
			t.Fatalf("read cancelled report state: state=%+v err=%v", state, err)
		}
		duplicate, err = store.AcceptCancellation(ctx, cancelCommand)
		if err != nil || !duplicate {
			t.Fatalf("accept duplicate cancellation: duplicate=%v err=%v", duplicate, err)
		}
	})

	t.Run("expired lease is reclaimed with a new fencing generation", func(t *testing.T) {
		command := newTestScanCommand("https://reclaim.example.com/")
		if _, err := store.AcceptCommand(ctx, command); err != nil {
			t.Fatalf("accept reclaim command: %v", err)
		}
		oldLease, err := store.ClaimPage(ctx, uuid.New(), 5*time.Millisecond, 0)
		if err != nil || oldLease == nil || oldLease.ScanID != command.Payload.ScanID {
			t.Fatalf("claim expiring page: lease=%+v err=%v", oldLease, err)
		}
		time.Sleep(20 * time.Millisecond)
		if err := store.ReclaimExpired(ctx); err != nil {
			t.Fatalf("reclaim expired lease: %v", err)
		}
		newLease, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
		if err != nil || newLease == nil || newLease.PageID != oldLease.PageID {
			t.Fatalf("claim reclaimed page: lease=%+v err=%v", newLease, err)
		}
		if newLease.LeaseGeneration <= oldLease.LeaseGeneration {
			t.Fatalf("lease generation did not advance: old=%d new=%d", oldLease.LeaseGeneration, newLease.LeaseGeneration)
		}
		if err := store.CommitPageResult(ctx, *oldLease, successfulPageResult(command.Payload.TargetURL)); !errors.Is(err, ErrStaleLease) {
			t.Fatalf("expected reclaimed worker to be fenced, got %v", err)
		}
		if err := store.CommitPageResult(ctx, *newLease, successfulPageResult(command.Payload.TargetURL)); err != nil {
			t.Fatalf("commit reclaimed page result: %v", err)
		}
	})

	t.Run("claim and cancellation use a deadlock-safe lock order", func(t *testing.T) {
		for iteration := 0; iteration < 10; iteration++ {
			command := newTestScanCommand("https://claim-cancel-" + uuid.NewString() + ".example.com/")
			if _, err := store.AcceptCommand(ctx, command); err != nil {
				t.Fatalf("accept race command: %v", err)
			}
			start := make(chan struct{})
			results := make(chan error, 2)
			raceContext, raceCancel := context.WithTimeout(ctx, 3*time.Second)
			go func() {
				<-start
				_, claimErr := store.ClaimPage(raceContext, uuid.New(), time.Minute, 0)
				results <- claimErr
			}()
			go func() {
				<-start
				_, cancellationErr := store.AcceptCancellation(raceContext, newTestCancelCommand(command, 2))
				results <- cancellationErr
			}()
			close(start)
			for completed := 0; completed < 2; completed++ {
				if err := <-results; err != nil {
					raceCancel()
					t.Fatalf("claim/cancel race failed on iteration %d: %v", iteration, err)
				}
			}
			raceCancel()
			state, err := store.GetReportState(ctx, command.Payload.OwnerID, command.Payload.ScanID)
			if err != nil || state.Status != "CANCELLED" {
				t.Fatalf("race did not finish cancelled: state=%+v err=%v", state, err)
			}
		}
	})

	t.Run("heartbeat and cancellation use a deadlock-safe lock order", func(t *testing.T) {
		for iteration := 0; iteration < 10; iteration++ {
			command := newTestScanCommand("https://heartbeat-cancel-" + uuid.NewString() + ".example.com/")
			if _, err := store.AcceptCommand(ctx, command); err != nil {
				t.Fatalf("accept heartbeat race command: %v", err)
			}
			lease, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
			if err != nil || lease == nil || lease.ScanID != command.Payload.ScanID {
				t.Fatalf("claim heartbeat race page: lease=%+v err=%v", lease, err)
			}
			start := make(chan struct{})
			results := make(chan error, 2)
			raceContext, raceCancel := context.WithTimeout(ctx, 3*time.Second)
			go func() {
				<-start
				heartbeatErr := store.ExtendPageLease(raceContext, *lease, time.Minute)
				if errors.Is(heartbeatErr, ErrStaleLease) {
					heartbeatErr = nil
				}
				results <- heartbeatErr
			}()
			go func() {
				<-start
				_, cancellationErr := store.AcceptCancellation(raceContext, newTestCancelCommand(command, 2))
				results <- cancellationErr
			}()
			close(start)
			for completed := 0; completed < 2; completed++ {
				if err := <-results; err != nil {
					raceCancel()
					t.Fatalf("heartbeat/cancel race failed on iteration %d: %v", iteration, err)
				}
			}
			raceCancel()
		}
	})

	t.Run("old analytics backlog activates load shedding", func(t *testing.T) {
		command := newTestScanCommand("https://backpressure.example.com/")
		if _, err := store.AcceptCommand(ctx, command); err != nil {
			t.Fatalf("accept backpressure command: %v", err)
		}
		lease, err := store.ClaimPage(ctx, uuid.New(), time.Minute, 0)
		if err != nil || lease == nil || lease.ScanID != command.Payload.ScanID {
			t.Fatalf("claim backpressure page: lease=%+v err=%v", lease, err)
		}
		if err := store.CommitPageResult(ctx, *lease, successfulPageResult(command.Payload.TargetURL)); err != nil {
			t.Fatalf("stage backpressure result: %v", err)
		}
		if _, err := store.pool.Exec(ctx, `
			UPDATE analytics_outbox
			SET created_at = clock_timestamp() - interval '16 minutes',
				updated_at = clock_timestamp() - interval '16 minutes'
			WHERE page_id = $1`, lease.PageID); err != nil {
			t.Fatalf("age analytics backlog: %v", err)
		}
		blocked, err := store.AnalyticsBackpressured(ctx, 15*time.Minute)
		if err != nil || !blocked {
			t.Fatalf("expected old backlog to activate backpressure: blocked=%v err=%v", blocked, err)
		}
	})
}

func newTestScanCommand(targetURL string) contracts.ScanCommandEnvelope {
	now := time.Now().UTC()
	scanID := uuid.New()
	return contracts.ScanCommandEnvelope{
		MessageID:        uuid.New(),
		AggregateType:    "SCAN",
		AggregateID:      scanID,
		AggregateVersion: 1,
		MessageType:      contracts.ScanRequestedV1,
		ContractVersion:  contracts.ContractVersionV1,
		CorrelationID:    uuid.New(),
		OccurredAt:       now,
		Payload: contracts.ScanRequestedPayload{
			ScanID: scanID, OwnerID: uuid.New(), WebsiteID: uuid.New(),
			TargetURL: targetURL, TargetHostname: mustHostname(targetURL),
			MaxPages: 1, MaxDepth: 1, MaxResponseBytes: 1_048_576,
			MaxDurationSeconds: 60, MaxRedirects: 3, MaxConcurrency: 1,
			CollectorVersion: "integration-test-v1",
		},
	}
}

func newTestCancelCommand(command contracts.ScanCommandEnvelope, version int64) contracts.ScanCancelCommandEnvelope {
	now := time.Now().UTC()
	return contracts.ScanCancelCommandEnvelope{
		MessageID: uuid.New(), AggregateType: "SCAN", AggregateID: command.AggregateID,
		AggregateVersion: version, MessageType: contracts.ScanCancelV1,
		ContractVersion: contracts.ContractVersionV1, CorrelationID: command.CorrelationID,
		OccurredAt: now,
		Payload: contracts.ScanCancelPayload{
			ScanID: command.Payload.ScanID, OwnerID: command.Payload.OwnerID, RequestedAt: now,
		},
	}
}

func successfulPageResult(finalURL string) model.PageResult {
	return model.PageResult{
		FinalURL: finalURL, FetchOutcome: "SUCCESS", StatusCode: 200,
		ContentType: "text/html", IsIndexable: true, ObservedAt: time.Now().UTC(),
	}
}

func mustHostname(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		panic(err)
	}
	return parsed.Hostname()
}

func withSearchPath(t *testing.T, databaseURL, schemaName string) string {
	t.Helper()
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatalf("parse integration database URL: %v", err)
	}
	query := parsed.Query()
	query.Set("search_path", schemaName)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}
