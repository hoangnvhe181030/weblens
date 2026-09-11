package contracts

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestScanCommandValidation(t *testing.T) {
	t.Parallel()
	scanID := uuid.New()
	envelope := ScanCommandEnvelope{
		MessageID: uuid.New(), AggregateType: "SCAN", AggregateID: scanID,
		AggregateVersion: 0, MessageType: ScanRequestedV1, ContractVersion: ContractVersionV1,
		CorrelationID: uuid.New(), OccurredAt: time.Now().UTC(),
		Payload: ScanRequestedPayload{
			ScanID: scanID, OwnerID: uuid.New(), WebsiteID: uuid.New(),
			TargetURL: "https://example.com/", TargetHostname: "example.com",
			MaxPages: 25, MaxDepth: 3, MaxResponseBytes: 10_485_760,
			MaxDurationSeconds: 120, MaxRedirects: 5, MaxConcurrency: 3,
			CollectorVersion: "crawler-v1",
		},
	}
	if err := envelope.Validate(); err != nil {
		t.Fatalf("valid envelope was rejected: %v", err)
	}
	envelope.Payload.TargetHostname = "other.example"
	if err := envelope.Validate(); err == nil {
		t.Fatal("hostname mismatch was accepted")
	}
}

func TestScanCancellationValidation(t *testing.T) {
	t.Parallel()
	scanID := uuid.New()
	now := time.Now().UTC()
	envelope := ScanCancelCommandEnvelope{
		MessageID: uuid.New(), AggregateType: "SCAN", AggregateID: scanID,
		AggregateVersion: 1, MessageType: ScanCancelV1, ContractVersion: ContractVersionV1,
		CorrelationID: uuid.New(), OccurredAt: now,
		Payload: ScanCancelPayload{ScanID: scanID, OwnerID: uuid.New(), RequestedAt: now},
	}
	if err := envelope.Validate(); err != nil {
		t.Fatalf("valid cancellation was rejected: %v", err)
	}
	envelope.AggregateVersion = 0
	if err := envelope.Validate(); err == nil {
		t.Fatal("zero-version cancellation was accepted")
	}
}
