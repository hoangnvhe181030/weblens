// Package commands receives scan commands; PostgreSQL remains the workflow owner.
package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math/rand/v2"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	amqp "github.com/rabbitmq/amqp091-go"
	"github.com/weblens-project/weblens-crawler/internal/contracts"
	"github.com/weblens-project/weblens-crawler/internal/postgres"
)

const (
	Exchange     = "weblens.scan.commands"
	Queue        = "weblens.scan.commands.v1"
	DeadExchange = "weblens.scan.dead"
	DeadQueue    = "weblens.scan.dead.v1"
	maxBody      = 64 * 1024
	maxRetries   = 8
)

var ErrInvalidCommand = errors.New("invalid scan command")

type Store interface {
	AcceptCommand(context.Context, contracts.ScanCommandEnvelope) (bool, error)
	AcceptCancellation(context.Context, contracts.ScanCancelCommandEnvelope) (bool, error)
}

type Consumer struct {
	url         string
	username    string
	publisher   string
	concurrency int
	store       Store
	logger      *slog.Logger
	connected   atomic.Int32
}

func NewConsumer(url, username, publisher string, concurrency int, store Store, logger *slog.Logger) *Consumer {
	return &Consumer{url: url, username: username, publisher: publisher, concurrency: concurrency, store: store, logger: logger}
}

func (c *Consumer) Ready() bool { return c.connected.Load() == int32(c.concurrency) }

func (c *Consumer) Run(ctx context.Context) {
	var workers sync.WaitGroup
	for i := 0; i < c.concurrency; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			backoff := time.Second
			for ctx.Err() == nil {
				started := time.Now()
				_ = c.session(ctx)
				if ctx.Err() != nil {
					return
				}
				// Connection errors can contain credentials or untrusted broker text.
				c.logger.Warn("scan command consumer disconnected; reconnect scheduled")
				if time.Since(started) > time.Minute {
					backoff = time.Second
				}
				if !wait(ctx, backoff+time.Duration(rand.Int64N(int64(backoff/2)))) {
					return
				}
				backoff = min(10*time.Second, 2*backoff)
			}
		}()
	}
	workers.Wait()
}

// AMQP has synchronous channel operations; bound writes as well as handshakes.
type boundedConn struct{ net.Conn }

func (c boundedConn) Write(p []byte) (int, error) {
	if err := c.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return 0, err
	}
	return c.Conn.Write(p)
}

func (c *Consumer) session(ctx context.Context) error {
	var socket net.Conn
	connection, err := amqp.DialConfig(c.url, amqp.Config{
		Heartbeat: 5 * time.Second,
		Dial: func(network, addr string) (net.Conn, error) {
			raw, err := (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			socket = raw
			if err := raw.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				raw.Close()
				return nil, err
			}
			return boundedConn{raw}, nil
		},
	})
	if err != nil {
		if socket != nil {
			socket.Close()
		}
		return err
	}
	defer socket.Close() // Abort promptly on cancellation; unacked deliveries remain in RabbitMQ.
	stop := context.AfterFunc(ctx, func() { socket.Close() })
	defer stop()
	ch, err := connection.Channel()
	if err != nil {
		return err
	}
	if err = ch.Qos(1, 0, false); err != nil {
		return err
	}
	if err = ch.Confirm(false); err != nil {
		return err
	}
	returns := ch.NotifyReturn(make(chan amqp.Return, 1))
	deliveries, err := ch.Consume(Queue, "", false, false, false, false, nil)
	if err != nil {
		return err
	}
	c.connected.Add(1)
	defer c.connected.Add(-1)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case delivery, ok := <-deliveries:
			if !ok {
				return errors.New("consumer channel closed")
			}
			attemptCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := c.accept(attemptCtx, delivery)
			cancel()
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if err == nil {
				if err := delivery.Ack(false); err != nil {
					return err
				}
				c.logger.Info("scan command committed", "messageId", delivery.MessageId, "correlationId", delivery.CorrelationId)
				continue
			}
			retries, valid := retryCount(delivery.Headers)
			permanent := errors.Is(err, ErrInvalidCommand) || errors.Is(err, postgres.ErrMessageCollision) || !valid
			exchange, key, reason := Exchange, "scan", "ACCEPTANCE_RETRY"
			if permanent || retries >= maxRetries {
				exchange, key, reason = DeadExchange, "rejected", "COMMAND_REJECTED"
				if !permanent {
					reason = "ACCEPTANCE_RETRIES_EXHAUSTED"
				}
			} else if !wait(ctx, retryDelay(retries)) {
				return ctx.Err()
			}
			// Confirm the replacement before ACKing the original. A lost ACK can duplicate, never discard.
			headers := amqp.Table{"x-weblens-retry": int32(min(retries+1, maxRetries)), "x-weblens-reason": reason}
			publishCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			confirm, publishErr := ch.PublishWithDeferredConfirmWithContext(publishCtx, exchange, key, true, false, amqp.Publishing{
				ContentType: "application/json", ContentEncoding: "UTF-8", DeliveryMode: amqp.Persistent,
				MessageId: delivery.MessageId, CorrelationId: delivery.CorrelationId,
				UserId: c.username, Headers: headers, Body: delivery.Body,
			})
			if publishErr == nil {
				var ack bool
				ack, publishErr = confirm.WaitContext(publishCtx)
				if publishErr == nil && !ack {
					publishErr = errors.New("handoff not confirmed")
				}
			}
			cancel()
			if publishErr != nil {
				return publishErr
			}
			select {
			case <-returns:
				return errors.New("handoff not routed")
			default:
			}
			if err := delivery.Ack(false); err != nil {
				return err
			}
			messageID := "invalid"
			if id, err := uuid.Parse(delivery.MessageId); err == nil {
				messageID = id.String()
			}
			c.logger.Warn("scan command handed off", "messageId", messageID, "reason", reason, "retry", retries)
		}
	}
}

func (c *Consumer) accept(ctx context.Context, d amqp.Delivery) error {
	if len(d.Body) == 0 || len(d.Body) > maxBody || d.ContentType != "application/json" ||
		(d.UserId != c.publisher && d.UserId != c.username) {
		return ErrInvalidCommand
	}
	if _, valid := retryCount(d.Headers); !valid {
		return ErrInvalidCommand
	}
	var header struct {
		MessageType string `json:"messageType"`
	}
	if json.Unmarshal(d.Body, &header) != nil {
		return ErrInvalidCommand
	}
	switch header.MessageType {
	case contracts.ScanRequestedV1:
		var command contracts.ScanCommandEnvelope
		if strict(d.Body, &command) != nil || command.Validate() != nil || d.MessageId != command.MessageID.String() || d.CorrelationId != command.CorrelationID.String() {
			return ErrInvalidCommand
		}
		_, err := c.store.AcceptCommand(ctx, command)
		return err
	case contracts.ScanCancelV1:
		var command contracts.ScanCancelCommandEnvelope
		if strict(d.Body, &command) != nil || command.Validate() != nil || d.MessageId != command.MessageID.String() || d.CorrelationId != command.CorrelationID.String() {
			return ErrInvalidCommand
		}
		_, err := c.store.AcceptCancellation(ctx, command)
		return err
	default:
		return ErrInvalidCommand
	}
}

func strict(body []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return ErrInvalidCommand
	}
	return nil
}

func retryCount(headers amqp.Table) (int, bool) {
	raw, exists := headers["x-weblens-retry"]
	if !exists {
		return 0, true
	}
	var n int64
	switch v := raw.(type) {
	case int32:
		n = int64(v)
	case int64:
		n = v
	default:
		return 0, false
	}
	return int(n), n >= 0 && n <= maxRetries
}

func retryDelay(retries int) time.Duration {
	return min(10*time.Second, (500*time.Millisecond)<<min(retries, maxRetries))
}

func wait(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
