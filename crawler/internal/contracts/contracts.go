package contracts

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	ContractVersionV1 = 1
	ScanRequestedV1   = "SCAN_REQUESTED"
	ScanCancelV1      = "SCAN_CANCEL_REQUESTED"
	ScanProgressV1    = "SCAN_PROGRESS"
)

type ScanCommandEnvelope struct {
	MessageID        uuid.UUID            `json:"messageId"`
	AggregateType    string               `json:"aggregateType"`
	AggregateID      uuid.UUID            `json:"aggregateId"`
	AggregateVersion int64                `json:"aggregateVersion"`
	MessageType      string               `json:"messageType"`
	ContractVersion  int                  `json:"contractVersion"`
	CorrelationID    uuid.UUID            `json:"correlationId"`
	OccurredAt       time.Time            `json:"occurredAt"`
	Payload          ScanRequestedPayload `json:"payload"`
}

type ScanRequestedPayload struct {
	ScanID             uuid.UUID `json:"scanId"`
	OwnerID            uuid.UUID `json:"ownerId"`
	WebsiteID          uuid.UUID `json:"websiteId"`
	TargetURL          string    `json:"targetUrl"`
	TargetHostname     string    `json:"targetHostname"`
	MaxPages           int       `json:"maxPages"`
	MaxDepth           int       `json:"maxDepth"`
	MaxResponseBytes   int64     `json:"maxResponseBytes"`
	MaxDurationSeconds int       `json:"maxDurationSeconds"`
	MaxRedirects       int       `json:"maxRedirects"`
	MaxConcurrency     int       `json:"maxConcurrency"`
	CollectorVersion   string    `json:"collectorVersion"`
}

type ScanCancelCommandEnvelope struct {
	MessageID        uuid.UUID         `json:"messageId"`
	AggregateType    string            `json:"aggregateType"`
	AggregateID      uuid.UUID         `json:"aggregateId"`
	AggregateVersion int64             `json:"aggregateVersion"`
	MessageType      string            `json:"messageType"`
	ContractVersion  int               `json:"contractVersion"`
	CorrelationID    uuid.UUID         `json:"correlationId"`
	OccurredAt       time.Time         `json:"occurredAt"`
	Payload          ScanCancelPayload `json:"payload"`
}

type ScanCancelPayload struct {
	ScanID      uuid.UUID `json:"scanId"`
	OwnerID     uuid.UUID `json:"ownerId"`
	RequestedAt time.Time `json:"requestedAt"`
}

type ScanEventEnvelope struct {
	MessageID        uuid.UUID           `json:"messageId"`
	AggregateType    string              `json:"aggregateType"`
	AggregateID      uuid.UUID           `json:"aggregateId"`
	AggregateVersion int64               `json:"aggregateVersion"`
	MessageType      string              `json:"messageType"`
	ContractVersion  int                 `json:"contractVersion"`
	CorrelationID    uuid.UUID           `json:"correlationId"`
	OccurredAt       time.Time           `json:"occurredAt"`
	Payload          ScanProgressPayload `json:"payload"`
}

type ScanProgressPayload struct {
	ScanID                  uuid.UUID `json:"scanId"`
	OwnerID                 uuid.UUID `json:"ownerId"`
	Status                  string    `json:"status"`
	DiscoveredCount         int       `json:"discoveredCount"`
	QueuedCount             int       `json:"queuedCount"`
	ProcessedCount          int       `json:"processedCount"`
	SucceededCount          int       `json:"succeededCount"`
	FailedCount             int       `json:"failedCount"`
	AnalyticsExpectedCount  int       `json:"analyticsExpectedCount"`
	AnalyticsPublishedCount int       `json:"analyticsPublishedCount"`
	TerminalCode            string    `json:"terminalCode,omitempty"`
	TerminalMessage         string    `json:"terminalMessage,omitempty"`
}

func (e ScanCommandEnvelope) Validate() error {
	var problems []error
	if e.MessageID == uuid.Nil || e.AggregateID == uuid.Nil || e.CorrelationID == uuid.Nil {
		problems = append(problems, errors.New("messageId, aggregateId and correlationId are required"))
	}
	if e.AggregateType != "SCAN" || e.MessageType != ScanRequestedV1 || e.ContractVersion != ContractVersionV1 {
		problems = append(problems, errors.New("unsupported command contract"))
	}
	if e.AggregateVersion < 0 || e.OccurredAt.IsZero() {
		problems = append(problems, errors.New("aggregateVersion and occurredAt are invalid"))
	}
	if e.AggregateID != e.Payload.ScanID || e.Payload.ScanID == uuid.Nil || e.Payload.OwnerID == uuid.Nil || e.Payload.WebsiteID == uuid.Nil {
		problems = append(problems, errors.New("payload identifiers do not match the aggregate"))
	}
	u, err := url.Parse(e.Payload.TargetURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		problems = append(problems, errors.New("targetUrl must be an absolute HTTP(S) URL without userinfo"))
	} else if !strings.EqualFold(u.Hostname(), e.Payload.TargetHostname) {
		problems = append(problems, errors.New("targetHostname must match targetUrl"))
	}
	if e.Payload.MaxPages < 1 || e.Payload.MaxPages > 100 || e.Payload.MaxDepth < 0 || e.Payload.MaxDepth > 10 {
		problems = append(problems, errors.New("page or depth limit is outside the V1 policy"))
	}
	if e.Payload.MaxResponseBytes < 1024 || e.Payload.MaxResponseBytes > 52_428_800 {
		problems = append(problems, errors.New("response byte limit is outside the V1 policy"))
	}
	if e.Payload.MaxDurationSeconds < 1 || e.Payload.MaxDurationSeconds > 3600 || e.Payload.MaxRedirects < 0 || e.Payload.MaxRedirects > 10 || e.Payload.MaxConcurrency < 1 || e.Payload.MaxConcurrency > 10 {
		problems = append(problems, errors.New("execution limits are outside the V1 policy"))
	}
	if strings.TrimSpace(e.Payload.CollectorVersion) == "" || len(e.Payload.CollectorVersion) > 64 {
		problems = append(problems, errors.New("collectorVersion is invalid"))
	}
	return errors.Join(problems...)
}

func (e ScanCancelCommandEnvelope) Validate() error {
	var problems []error
	if e.MessageID == uuid.Nil || e.AggregateID == uuid.Nil || e.CorrelationID == uuid.Nil {
		problems = append(problems, errors.New("messageId, aggregateId and correlationId are required"))
	}
	if e.AggregateType != "SCAN" || e.MessageType != ScanCancelV1 || e.ContractVersion != ContractVersionV1 {
		problems = append(problems, errors.New("unsupported cancellation contract"))
	}
	if e.AggregateVersion < 1 || e.OccurredAt.IsZero() || e.Payload.RequestedAt.IsZero() {
		problems = append(problems, errors.New("cancellation version and timestamps are invalid"))
	}
	if e.AggregateID != e.Payload.ScanID || e.Payload.ScanID == uuid.Nil || e.Payload.OwnerID == uuid.Nil {
		problems = append(problems, errors.New("cancellation identifiers do not match the aggregate"))
	}
	return errors.Join(problems...)
}

func CanonicalHash(value any) ([32]byte, []byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return [32]byte{}, nil, fmt.Errorf("marshal contract: %w", err)
	}
	return sha256.Sum256(encoded), encoded, nil
}
