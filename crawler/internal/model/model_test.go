package model

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestReportPageUsesPublicIndexableField(t *testing.T) {
	t.Parallel()

	payload, err := json.Marshal(ReportPage{IsIndexable: true, IndexabilityReason: "INDEXABLE"})
	if err != nil {
		t.Fatalf("marshal report page: %v", err)
	}
	encoded := string(payload)
	if !strings.Contains(encoded, `"indexable":true`) {
		t.Fatalf("expected public indexable field, got %s", encoded)
	}
	if strings.Contains(encoded, `"isIndexable"`) {
		t.Fatalf("legacy field must not leak into public contract: %s", encoded)
	}
}
