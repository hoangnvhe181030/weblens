package crawl

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

type idlePageStore struct {
	claimCount atomic.Int32
}

func (s *idlePageStore) ClaimPage(context.Context, uuid.UUID, time.Duration, time.Duration) (*model.PageLease, error) {
	s.claimCount.Add(1)
	return nil, nil
}

func (*idlePageStore) ExtendPageLease(context.Context, model.PageLease, time.Duration) error {
	return nil
}

func (*idlePageStore) CommitPageResult(context.Context, model.PageLease, model.PageResult) error {
	return nil
}

func (*idlePageStore) ReclaimExpired(context.Context) error {
	return nil
}

func (*idlePageStore) AnalyticsBackpressured(context.Context, time.Duration) (bool, error) {
	return false, nil
}

func TestHighWorkerLimitDoesNotMultiplyIdleDatabasePolling(t *testing.T) {
	store := &idlePageStore{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(store, nil, 10_000, 20*time.Millisecond, 30*time.Second, time.Second, 15*time.Minute, logger)
	ctx, cancel := context.WithTimeout(context.Background(), 110*time.Millisecond)
	defer cancel()

	engine.Run(ctx)

	claims := store.claimCount.Load()
	if claims < 2 || claims > 10 {
		t.Fatalf("idle dispatcher made %d claims; expected polling independent from 10000 worker slots", claims)
	}
}
