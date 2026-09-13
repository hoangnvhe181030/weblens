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

func TestScanCommandValidationAcceptsStructuralLoadTestCaps(t *testing.T) {
	t.Parallel()
	envelope := validScanCommand()
	envelope.Payload.MaxPages = MaxScanPages
	envelope.Payload.MaxDurationSeconds = MaxScanDurationSeconds
	envelope.Payload.MaxConcurrency = MaxScanConcurrency

	if err := envelope.Validate(); err != nil {
		t.Fatalf("structural load-test caps were rejected: %v", err)
	}
}

func TestScanCommandValidationRejectsValuesAboveStructuralCaps(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		mutate func(*ScanRequestedPayload)
	}{
		{"pages", func(payload *ScanRequestedPayload) { payload.MaxPages = MaxScanPages + 1 }},
		{"duration", func(payload *ScanRequestedPayload) { payload.MaxDurationSeconds = MaxScanDurationSeconds + 1 }},
		{"concurrency", func(payload *ScanRequestedPayload) { payload.MaxConcurrency = MaxScanConcurrency + 1 }},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			envelope := validScanCommand()
			testCase.mutate(&envelope.Payload)
			if err := envelope.Validate(); err == nil {
				t.Fatal("value above structural cap was accepted")
			}
		})
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

func validScanCommand() ScanCommandEnvelope {
	scanID := uuid.New()
	return ScanCommandEnvelope{
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
}
