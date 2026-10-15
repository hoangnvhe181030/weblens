package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	amqp "github.com/rabbitmq/amqp091-go"
	"github.com/weblens-project/weblens-crawler/internal/contracts"
	"github.com/weblens-project/weblens-crawler/internal/postgres"
)

type faultStore struct {
	Store
	fail          atomic.Int32
	cancellations atomic.Int32
	duplicates    atomic.Int32
	failAll       atomic.Bool
	loseAck       atomic.Bool
	commitHook    func()
}

func (s *faultStore) AcceptCommand(ctx context.Context, c contracts.ScanCommandEnvelope) (bool, error) {
	if s.failAll.Load() || s.fail.Add(-1) >= 0 {
		return false, errors.New("test database outage")
	}
	duplicate, err := s.Store.AcceptCommand(ctx, c)
	if err == nil && duplicate {
		s.duplicates.Add(1)
	}
	if err == nil && s.loseAck.CompareAndSwap(true, false) {
		s.commitHook()
	}
	return duplicate, err
}
func (s *faultStore) AcceptCancellation(ctx context.Context, c contracts.ScanCancelCommandEnvelope) (bool, error) {
	s.cancellations.Add(1)
	return s.Store.AcceptCancellation(ctx, c)
}

func TestRabbitPostgresIntegration(t *testing.T) {
	adminURL := os.Getenv("WEBLENS_TEST_RABBITMQ_URL")
	management := os.Getenv("WEBLENS_TEST_RABBITMQ_MANAGEMENT_URL")
	databaseURL := os.Getenv("WEBLENS_TEST_POSTGRES_URL")
	if adminURL == "" || management == "" || databaseURL == "" {
		t.Skip("set WEBLENS_TEST_RABBITMQ_URL, WEBLENS_TEST_RABBITMQ_MANAGEMENT_URL and WEBLENS_TEST_POSTGRES_URL")
	}
	endpoint, err := url.Parse(adminURL)
	if err != nil {
		t.Fatal("invalid test broker URL")
	}
	password, _ := endpoint.User.Password()
	request := func(method, path string, body []byte) {
		t.Helper()
		req, err := http.NewRequest(method, strings.TrimRight(management, "/")+path, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.SetBasicAuth(endpoint.User.Username(), password)
		req.Header.Set("Content-Type", "application/json")
		response, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
		if err != nil {
			t.Fatal("broker management request failed")
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			t.Fatalf("broker management status %d", response.StatusCode)
		}
	}
	vhost := "weblens_rabbit_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	data, err := os.ReadFile("../../../infra/rabbitmq/definitions.json")
	if err != nil {
		t.Fatal(err)
	}
	var definitions map[string]any
	if err := json.Unmarshal(data, &definitions); err != nil {
		t.Fatal(err)
	}
	delete(definitions, "users") // Never modify existing broker credentials.
	definitions["vhosts"] = []any{map[string]any{"name": vhost}}
	for _, key := range []string{"permissions", "exchanges", "queues", "bindings"} {
		for _, item := range definitions[key].([]any) {
			item.(map[string]any)["vhost"] = vhost
		}
	}
	data, _ = json.Marshal(definitions)
	request("POST", "/api/definitions", data)
	t.Cleanup(func() { request("DELETE", "/api/vhosts/"+url.PathEscape(vhost), nil) })
	endpoint.Path = "/" + vhost
	conn, err := amqp.Dial(endpoint.String())
	if err != nil {
		t.Fatal("connect test broker failed")
	}
	defer conn.Close()
	channel, err := conn.Channel()
	if err != nil {
		t.Fatal(err)
	}
	defer channel.Close()
	if err := channel.Confirm(false); err != nil {
		t.Fatal(err)
	}
	consumerURL := *endpoint
	consumerURL.User = url.UserPassword("weblens_crawler", "weblens-crawler-local-only")
	publisherURL := *endpoint
	publisherURL.User = url.UserPassword("weblens_control", "weblens-control-local-only")
	producer, err := amqp.Dial(publisherURL.String())
	if err != nil {
		t.Fatal("connect test publisher failed")
	}
	defer producer.Close()
	producerChannel, err := producer.Channel()
	if err != nil {
		t.Fatal(err)
	}
	defer producerChannel.Close()
	if err := producerChannel.Confirm(false); err != nil {
		t.Fatal(err)
	}
	db, err := pgx.Connect(context.Background(), databaseURL)
	if err != nil {
		t.Fatal("connect test database failed")
	}
	defer db.Close(context.Background())
	schema := pgx.Identifier{vhost}.Sanitize()
	if _, err := db.Exec(context.Background(), "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer db.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
	dbURL, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	query := dbURL.Query()
	query.Set("search_path", vhost)
	dbURL.RawQuery = query.Encode()
	if err := postgres.Migrate(context.Background(), dbURL.String()); err != nil {
		t.Fatal(err)
	}
	realStore, err := postgres.Open(context.Background(), dbURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer realStore.Close()
	store := &faultStore{Store: realStore}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	start := func() (*Consumer, context.CancelFunc, <-chan struct{}) {
		ctx, cancel := context.WithCancel(context.Background())
		c := NewConsumer(consumerURL.String(), "weblens_crawler", "weblens_control", 2, store, logger)
		done := make(chan struct{})
		go func() { defer close(done); c.Run(ctx) }()
		until(t, 10*time.Second, c.Ready)
		return c, cancel, done
	}
	c, cancel, done := start()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("consumer failed to stop")
		}
	}()
	publish := func(d amqp.Delivery) {
		t.Helper()
		confirm, err := producerChannel.PublishWithDeferredConfirm(Exchange, "scan", true, false, amqp.Publishing{ContentType: d.ContentType,
			DeliveryMode: amqp.Persistent, MessageId: d.MessageId, CorrelationId: d.CorrelationId, UserId: "weblens_control", Headers: d.Headers, Body: d.Body})
		if err != nil {
			t.Fatal(err)
		}
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		ack, err := confirm.WaitContext(ctx)
		if err != nil || !ack {
			t.Fatal("publish was not confirmed")
		}
	}
	count := func(table, column string, id uuid.UUID) int {
		t.Helper()
		var n int
		if err := db.QueryRow(context.Background(), fmt.Sprintf("SELECT count(*) FROM %s.%s WHERE %s=$1", schema, table, column), id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	dead := func(id string) amqp.Delivery {
		t.Helper()
		var result amqp.Delivery
		until(t, 10*time.Second, func() bool {
			d, ok, err := channel.Get(DeadQueue, true)
			if err != nil {
				t.Fatal(err)
			}
			if ok {
				result = d
			}
			return ok
		})
		if result.MessageId != id {
			t.Fatal("dead queue lost message identity")
		}
		return result
	}

	t.Run("duplicate delivery commits once and collision is parked", func(t *testing.T) {
		cmd := command()
		d := delivery(cmd)
		publish(d)
		publish(d)
		until(t, 10*time.Second, func() bool { return count("inbox_messages", "message_id", cmd.MessageID) == 1 })
		if count("crawl_executions", "scan_id", cmd.AggregateID) != 1 {
			t.Fatal("execution duplicated")
		}
		cmd.Payload.MaxPages = 2
		publish(delivery(cmd))
		if dead(d.MessageId).Headers["x-weblens-reason"] != "COMMAND_REJECTED" {
			t.Fatal("collision was not rejected")
		}
	})
	t.Run("cancellation delivered before create retries then commits", func(t *testing.T) {
		cmd := command()
		now := time.Now().UTC()
		cancellation := contracts.ScanCancelCommandEnvelope{MessageID: uuid.New(), AggregateType: "SCAN", AggregateID: cmd.AggregateID, AggregateVersion: 2,
			MessageType: contracts.ScanCancelV1, ContractVersion: 1, CorrelationID: cmd.CorrelationID, OccurredAt: now,
			Payload: contracts.ScanCancelPayload{ScanID: cmd.AggregateID, OwnerID: cmd.Payload.OwnerID, RequestedAt: now}}
		body, _ := json.Marshal(cancellation)
		d := amqp.Delivery{Body: body, MessageId: cancellation.MessageID.String(), CorrelationId: cmd.CorrelationID.String(), ContentType: "application/json"}
		before := store.cancellations.Load()
		publish(d)
		until(t, 5*time.Second, func() bool { return store.cancellations.Load() > before })
		publish(delivery(cmd))
		until(t, 10*time.Second, func() bool { return count("inbox_messages", "message_id", cancellation.MessageID) == 1 })
		state, err := realStore.GetReportState(context.Background(), cmd.Payload.OwnerID, cmd.AggregateID)
		if err != nil || state.Status != "CANCELLED" {
			t.Fatalf("cancellation did not win: %v", err)
		}
	})
	t.Run("temporary database failure retries without losing accepted work", func(t *testing.T) {
		store.fail.Store(2)
		cmd := command()
		publish(delivery(cmd))
		until(t, 10*time.Second, func() bool { return count("inbox_messages", "message_id", cmd.MessageID) == 1 })
	})
	t.Run("retry exhaustion and malformed messages are retained", func(t *testing.T) {
		store.failAll.Store(true)
		d := delivery(command())
		d.Headers = amqp.Table{"x-weblens-retry": int32(maxRetries)}
		publish(d)
		if dead(d.MessageId).Headers["x-weblens-reason"] != "ACCEPTANCE_RETRIES_EXHAUSTED" {
			t.Fatal("retry limit not enforced")
		}
		store.failAll.Store(false)
		d = delivery(command())
		d.Body = []byte("{malformed")
		publish(d)
		if !bytes.Equal(dead(d.MessageId).Body, d.Body) {
			t.Fatal("poison evidence lost")
		}
	})
	t.Run("commit followed by consumer shutdown is redelivered safely", func(t *testing.T) {
		before := store.duplicates.Load()
		store.commitHook = cancel
		store.loseAck.Store(true)
		cmd := command()
		publish(delivery(cmd))
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatal("shutdown timed out")
		}
		if count("inbox_messages", "message_id", cmd.MessageID) != 1 {
			t.Fatal("commit did not precede shutdown")
		}
		c, cancel, done = start()
		_ = c
		until(t, 10*time.Second, func() bool { return store.duplicates.Load() > before })
		if count("crawl_executions", "scan_id", cmd.AggregateID) != 1 {
			t.Fatal("redelivery created duplicate execution")
		}
	})
	t.Run("unroutable dead handoff retains original across reconnect", func(t *testing.T) {
		if err := channel.QueueUnbind(DeadQueue, "rejected", DeadExchange, nil); err != nil {
			t.Fatal(err)
		}
		d := delivery(command())
		d.Body = []byte("{malformed")
		publish(d)
		until(t, 10*time.Second, func() bool { return !c.Ready() })
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatal("consumer did not stop after failed handoff")
		}
		until(t, 10*time.Second, func() bool {
			queue, err := channel.QueueInspect(Queue)
			if err != nil {
				t.Fatal(err)
			}
			return queue.Messages == 1
		})
		if err := channel.QueueBind(DeadQueue, "rejected", DeadExchange, false, nil); err != nil {
			t.Fatal(err)
		}
		c, cancel, done = start()
		if !bytes.Equal(dead(d.MessageId).Body, d.Body) {
			t.Fatal("failed handoff lost original evidence")
		}
	})
}

func until(t *testing.T, timeout time.Duration, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition was not reached before deadline")
}
