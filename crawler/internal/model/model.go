package model

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
)

var ErrStaleLease = errors.New("lease is stale")

type PageLease struct {
	RetentionMonth   time.Time
	PageID           uuid.UUID
	ExecutionID      uuid.UUID
	ScanID           uuid.UUID
	OwnerID          uuid.UUID
	WebsiteID        uuid.UUID
	CorrelationID    uuid.UUID
	NormalizedURL    string
	Hostname         string
	DiscoveryDepth   int
	LeaseOwner       uuid.UUID
	LeaseGeneration  int64
	MaxPages         int
	MaxDepth         int
	MaxResponseBytes int64
	MaxDuration      time.Duration
	MaxRedirects     int
	CollectorVersion string
	AcceptedAt       time.Time
}

type PageResult struct {
	FinalURL      string
	FetchOutcome  string
	ErrorCode     string
	ErrorMessage  string
	StatusCode    int
	ContentType   string
	RedirectURLs  []string
	RedirectCodes []uint16
	ResponseBytes uint64
	TotalMillis   uint32
	Title         string
	Description   string
	CanonicalURL  string
	MetaRobots    string
	HTMLLang      string
	H1            []string
	H2            []string
	WordCount     uint32
	InternalLinks uint32
	ExternalLinks uint32
	ImageCount    uint32
	MissingAlt    uint32
	IsIndexable   bool
	Links         []DiscoveredLink
	Findings      []Finding
	ObservedAt    time.Time
}

type DiscoveredLink struct {
	TargetURL    string   `json:"targetUrl"`
	AnchorText   string   `json:"anchorText"`
	Tag          string   `json:"tag"`
	RelValues    []string `json:"relValues"`
	IsInternal   bool     `json:"isInternal"`
	IsFollowable bool     `json:"isFollowable"`
	Ordinal      uint32   `json:"ordinal"`
}

type Finding struct {
	FindingID   uuid.UUID      `json:"findingId"`
	RuleID      string         `json:"ruleId"`
	RuleVersion uint32         `json:"ruleVersion"`
	Category    string         `json:"category"`
	Severity    string         `json:"severity"`
	Code        string         `json:"code"`
	Message     string         `json:"message"`
	Evidence    map[string]any `json:"evidence"`
}

type AnalyticsPayload struct {
	SchemaVersion    uint16     `json:"schemaVersion"`
	OwnerID          uuid.UUID  `json:"ownerId"`
	ScanID           uuid.UUID  `json:"scanId"`
	RetentionMonth   time.Time  `json:"retentionMonth"`
	PageID           uuid.UUID  `json:"pageId"`
	RecordVersion    uint64     `json:"recordVersion"`
	RequestedURL     string     `json:"requestedUrl"`
	NormalizedURL    string     `json:"normalizedUrl"`
	FinalURL         string     `json:"finalUrl"`
	Hostname         string     `json:"hostname"`
	DiscoveryDepth   uint16     `json:"discoveryDepth"`
	Result           PageResult `json:"result"`
	CollectorVersion string     `json:"collectorVersion"`
	ParserVersion    string     `json:"parserVersion"`
}

type AnalyticsBatch struct {
	ID               uuid.UUID
	RetentionMonth   time.Time
	ExecutionID      uuid.UUID
	OwnerID          uuid.UUID
	PageID           uuid.UUID
	ResultVersion    int64
	Payload          json.RawMessage
	PayloadSHA256    []byte
	DeliveryAttempts int
	LeaseOwner       uuid.UUID
}

type OutboxMessage struct {
	MessageID        uuid.UUID
	AggregateType    string
	AggregateID      uuid.UUID
	AggregateVersion int64
	EventType        string
	ContractVersion  int
	CorrelationID    uuid.UUID
	Payload          json.RawMessage
	CreatedAt        time.Time
	DeliveryAttempts int
	LeaseOwner       uuid.UUID
}

type ReportState struct {
	ScanID                  uuid.UUID  `json:"scanId"`
	OwnerID                 uuid.UUID  `json:"ownerId"`
	Status                  string     `json:"status"`
	AnalyticsExpectedCount  int        `json:"analyticsExpectedCount"`
	AnalyticsPublishedCount int        `json:"analyticsPublishedCount"`
	AnalyticsWatermark      *time.Time `json:"analyticsWatermark,omitempty"`
}

type ReportFinding struct {
	ID          uuid.UUID      `json:"id"`
	Severity    string         `json:"severity"`
	Title       string         `json:"title"`
	Description string         `json:"description"`
	Evidence    map[string]any `json:"evidence"`
}

type ReportPage struct {
	ID             uuid.UUID       `json:"id"`
	ScanID         uuid.UUID       `json:"scanId"`
	URL            string          `json:"url"`
	FinalURL       string          `json:"finalUrl"`
	StatusCode     int             `json:"statusCode,omitempty"`
	Outcome        string          `json:"outcome"`
	ResponseTimeMS uint32          `json:"responseTimeMs,omitempty"`
	ResponseBytes  uint64          `json:"responseBytes,omitempty"`
	Title          string          `json:"title,omitempty"`
	H1             []string        `json:"h1"`
	Links          uint32          `json:"links"`
	Images         uint32          `json:"images"`
	Findings       []ReportFinding `json:"findings"`
	ObservedAt     time.Time       `json:"observedAt"`
}

type ScanPagesReport struct {
	State ReportState  `json:"state"`
	Items []ReportPage `json:"items"`
}
