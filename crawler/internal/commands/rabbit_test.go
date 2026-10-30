package commands

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"
	amqp "github.com/rabbitmq/amqp091-go"
	"github.com/weblens-project/weblens-crawler/internal/contracts"
)

type fakeStore struct {
	calls int
	err   error
}

func (s *fakeStore) AcceptCommand(context.Context, contracts.ScanCommandEnvelope) (bool, error) {
	s.calls++
	return false, s.err
}
func (s *fakeStore) AcceptCancellation(context.Context, contracts.ScanCancelCommandEnvelope) (bool, error) {
	s.calls++
	return false, s.err
}

func command() contracts.ScanCommandEnvelope {
	id := uuid.New()
	return contracts.ScanCommandEnvelope{MessageID: uuid.New(), AggregateType: "SCAN", AggregateID: id, AggregateVersion: 1,
		MessageType: contracts.ScanRequestedV1, ContractVersion: 1, CorrelationID: uuid.New(), OccurredAt: time.Now().UTC(),
		Payload: contracts.ScanRequestedPayload{ScanID: id, OwnerID: uuid.New(), WebsiteID: uuid.New(), TargetURL: "https://example.com/",
			TargetHostname: "example.com", MaxPages: 1, MaxDepth: 1, MaxResponseBytes: 1024, MaxDurationSeconds: 60,
			MaxRedirects: 1, MaxConcurrency: 1, CollectorVersion: "rabbit-test"}}
}

func delivery(cmd contracts.ScanCommandEnvelope) amqp.Delivery {
	body, _ := json.Marshal(cmd)
	return amqp.Delivery{Body: body, MessageId: cmd.MessageID.String(), CorrelationId: cmd.CorrelationID.String(), ContentType: "application/json", UserId: "weblens_control"}
}

func TestCommandValidationBeforePersistence(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*amqp.Delivery)
	}{
		{"unknown publisher", func(d *amqp.Delivery) { d.UserId = "unknown" }},
		{"missing content type", func(d *amqp.Delivery) { d.ContentType = "" }},
		{"message identity mismatch", func(d *amqp.Delivery) { d.MessageId = uuid.NewString() }},
		{"correlation mismatch", func(d *amqp.Delivery) { d.CorrelationId = uuid.NewString() }},
		{"oversize", func(d *amqp.Delivery) { d.Body = make([]byte, maxBody+1) }},
		{"malformed", func(d *amqp.Delivery) { d.Body = []byte("{") }},
		{"extra JSON", func(d *amqp.Delivery) { d.Body = append(d.Body, []byte(" {}")...) }},
		{"unknown field", func(d *amqp.Delivery) { d.Body = append([]byte(`{"extra":1,`), d.Body[1:]...) }},
		{"negative retry", func(d *amqp.Delivery) { d.Headers = amqp.Table{"x-weblens-retry": int32(-1)} }},
		{"invalid retry type", func(d *amqp.Delivery) { d.Headers = amqp.Table{"x-weblens-retry": "8"} }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{}
			c := NewConsumer("", "weblens_crawler", "weblens_control", 1, store, slog.New(slog.NewTextHandler(io.Discard, nil)))
			d := delivery(command())
			tc.mutate(&d)
			if !errors.Is(c.accept(context.Background(), d), ErrInvalidCommand) || store.calls != 0 {
				t.Fatal("invalid command reached persistence")
			}
		})
	}
	store := &fakeStore{err: errors.New("database unavailable")}
	c := NewConsumer("", "weblens_crawler", "weblens_control", 1, store, slog.Default())
	if err := c.accept(context.Background(), delivery(command())); !errors.Is(err, store.err) || store.calls != 1 {
		t.Fatal("database error was not propagated")
	}
}

func TestRetryBounds(t *testing.T) {
	previous := time.Duration(0)
	for n := 0; n <= maxRetries; n++ {
		d := retryDelay(n)
		if d < previous || d > 10*time.Second {
			t.Fatal("invalid backoff")
		}
		previous = d
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if wait(ctx, time.Minute) {
		t.Fatal("shutdown waited for retry")
	}
}
