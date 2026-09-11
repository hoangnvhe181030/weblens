package events

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

type eventStore interface {
	ClaimEvents(context.Context, uuid.UUID, int, time.Duration) ([]model.OutboxMessage, error)
	CompleteEvent(context.Context, model.OutboxMessage) error
	RetryEvent(context.Context, model.OutboxMessage, string) error
}

type Publisher struct {
	store         eventStore
	client        *http.Client
	targetURL     string
	serviceToken  string
	workerID      uuid.UUID
	pollInterval  time.Duration
	leaseDuration time.Duration
	logger        *slog.Logger
}

func NewPublisher(
	store eventStore,
	targetURL, serviceToken string,
	pollInterval, leaseDuration time.Duration,
	logger *slog.Logger,
) *Publisher {
	return &Publisher{
		store: store, client: &http.Client{Timeout: 10 * time.Second},
		targetURL: targetURL, serviceToken: serviceToken, workerID: uuid.New(),
		pollInterval: pollInterval, leaseDuration: leaseDuration, logger: logger,
	}
}

func (p *Publisher) Run(ctx context.Context) {
	ticker := time.NewTicker(p.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.publishAvailable(ctx)
		}
	}
}

func (p *Publisher) publishAvailable(ctx context.Context) {
	messages, err := p.store.ClaimEvents(ctx, p.workerID, 25, p.leaseDuration)
	if err != nil {
		p.logger.Error("claim event outbox failed", "error", err)
		return
	}
	for _, message := range messages {
		if err := p.publish(ctx, message); err != nil {
			p.logger.Warn("event delivery failed", "messageId", message.MessageID, "error", err)
			_ = p.store.RetryEvent(ctx, message, errorCode(err))
			continue
		}
		if err := p.store.CompleteEvent(ctx, message); err != nil {
			p.logger.Error("event acknowledgement failed", "messageId", message.MessageID, "error", err)
		}
	}
}

func (p *Publisher) publish(ctx context.Context, message model.OutboxMessage) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, p.targetURL, bytes.NewReader(message.Payload))
	if err != nil {
		return fmt.Errorf("create event request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-WebLens-Service-Token", p.serviceToken)
	request.Header.Set("X-Correlation-ID", message.CorrelationID.String())
	request.Header.Set("Idempotency-Key", message.MessageID.String())
	response, err := p.client.Do(request)
	if err != nil {
		return fmt.Errorf("send event request: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("control plane returned HTTP %d", response.StatusCode)
	}
	return nil
}

func errorCode(err error) string {
	if err == nil {
		return "UNKNOWN"
	}
	var timeout interface{ Timeout() bool }
	if errors.As(err, &timeout) && timeout.Timeout() {
		return "TIMEOUT"
	}
	digest := sha256.Sum256([]byte(err.Error()))
	return "DELIVERY_" + hex.EncodeToString(digest[:4])
}
