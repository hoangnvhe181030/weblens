package analytics

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

type analyticsStore interface {
	ClaimAnalytics(context.Context, uuid.UUID, int, time.Duration) ([]model.AnalyticsBatch, error)
	CompleteAnalytics(context.Context, model.AnalyticsBatch) error
	RetryAnalytics(context.Context, model.AnalyticsBatch, string) error
}

type Worker struct {
	store         analyticsStore
	sink          *Sink
	workerID      uuid.UUID
	pollInterval  time.Duration
	leaseDuration time.Duration
	logger        *slog.Logger
}

func NewWorker(store analyticsStore, sink *Sink, pollInterval, leaseDuration time.Duration, logger *slog.Logger) *Worker {
	return &Worker{
		store: store, sink: sink, workerID: uuid.New(), pollInterval: pollInterval,
		leaseDuration: leaseDuration, logger: logger,
	}
}

func (w *Worker) Run(ctx context.Context) {
	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.deliver(ctx)
		}
	}
}

func (w *Worker) deliver(ctx context.Context) {
	batches, err := w.store.ClaimAnalytics(ctx, w.workerID, 100, w.leaseDuration)
	if err != nil {
		w.logger.Error("claim analytics outbox failed", "error", err)
		return
	}
	results := w.sink.WriteBatch(ctx, batches)
	for _, batch := range batches {
		if err := results[batch.ID]; err != nil {
			w.logger.Warn("ClickHouse delivery failed", "batchId", batch.ID, "error", err)
			_ = w.store.RetryAnalytics(ctx, batch, "CLICKHOUSE_DELIVERY_FAILED")
			continue
		}
		if err := w.store.CompleteAnalytics(ctx, batch); err != nil {
			w.logger.Error("analytics acknowledgement failed", "batchId", batch.ID, "error", err)
		}
	}
}
