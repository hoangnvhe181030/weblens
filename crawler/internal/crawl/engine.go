package crawl

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

type pageStore interface {
	ClaimPage(context.Context, uuid.UUID, time.Duration, time.Duration) (*model.PageLease, error)
	ExtendPageLease(context.Context, model.PageLease, time.Duration) error
	CommitPageResult(context.Context, model.PageLease, model.PageResult) error
	ReclaimExpired(context.Context) error
	AnalyticsBackpressured(context.Context, time.Duration) (bool, error)
}

type Engine struct {
	store         pageStore
	fetcher       *Fetcher
	robots        *RobotsCache
	workers       int
	pollInterval  time.Duration
	leaseDuration time.Duration
	hostDelay     time.Duration
	backlogAge    time.Duration
	backpressured atomic.Bool
	logger        *slog.Logger
}

func NewEngine(
	store pageStore,
	fetcher *Fetcher,
	workers int,
	pollInterval, leaseDuration, hostDelay, backlogAge time.Duration,
	logger *slog.Logger,
) *Engine {
	return &Engine{
		store: store, fetcher: fetcher, robots: NewRobotsCache(fetcher, "WebLensCrawler"),
		workers: workers, pollInterval: pollInterval, leaseDuration: leaseDuration,
		hostDelay: hostDelay, backlogAge: backlogAge, logger: logger,
	}
}

func (e *Engine) Run(ctx context.Context) {
	e.refreshBackpressure(ctx)
	var workers sync.WaitGroup
	for range e.workers {
		workers.Add(1)
		go func(workerID uuid.UUID) {
			defer workers.Done()
			e.runWorker(ctx, workerID)
		}(uuid.New())
	}
	workers.Add(1)
	go func() {
		defer workers.Done()
		e.runReclaimer(ctx)
	}()
	workers.Wait()
}

func (e *Engine) runWorker(ctx context.Context, workerID uuid.UUID) {
	ticker := time.NewTicker(e.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if e.backpressured.Load() {
				continue
			}
			lease, err := e.store.ClaimPage(ctx, workerID, e.leaseDuration, e.hostDelay)
			if err != nil {
				e.logger.Error("claim page failed", "error", err)
				continue
			}
			if lease == nil {
				continue
			}
			e.process(ctx, *lease)
		}
	}
}

func (e *Engine) process(parent context.Context, lease model.PageLease) {
	deadline := lease.AcceptedAt.Add(lease.MaxDuration)
	ctx, cancel := context.WithDeadline(parent, deadline)
	defer cancel()
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		interval := max(e.leaseDuration/3, time.Second)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := e.store.ExtendPageLease(ctx, lease, e.leaseDuration); err != nil {
					e.logger.Warn("page lease heartbeat failed", "scanId", lease.ScanID, "pageId", lease.PageID, "error", err)
					cancel()
					return
				}
			}
		}
	}()
	result := model.PageResult{FinalURL: lease.NormalizedURL, ObservedAt: time.Now().UTC()}
	if !e.robots.Allowed(ctx, lease.NormalizedURL, lease.Hostname, lease.MaxRedirects) {
		result.FetchOutcome = "SKIPPED"
		result.ErrorCode = "ROBOTS_DISALLOWED"
		result.ErrorMessage = "The target robots policy disallows this page."
	} else {
		fetched := e.fetcher.Fetch(ctx, lease.NormalizedURL, lease.Hostname, lease.MaxResponseBytes, lease.MaxRedirects)
		result = buildResult(lease, fetched)
	}
	cancel()
	<-heartbeatDone
	if err := e.store.CommitPageResult(parent, lease, result); err != nil && !errors.Is(err, model.ErrStaleLease) {
		e.logger.Error("commit page result failed", "scanId", lease.ScanID, "pageId", lease.PageID, "error", err)
	}
}

func buildResult(lease model.PageLease, fetched FetchResult) model.PageResult {
	result := model.PageResult{
		FinalURL: fetched.FinalURL, ErrorCode: fetched.ErrorCode,
		ErrorMessage: fetched.ErrorMessage, StatusCode: fetched.StatusCode,
		ContentType: fetched.ContentType, ResponseBytes: uint64(max(fetched.BodyBytes, 0)),
		TotalMillis: uint32(min(fetched.TotalDuration.Milliseconds(), int64(^uint32(0)))),
		ObservedAt:  time.Now().UTC(),
	}
	if result.FinalURL == "" {
		result.FinalURL = lease.NormalizedURL
	}
	for _, redirect := range fetched.Redirects {
		result.RedirectURLs = append(result.RedirectURLs, redirect.URL)
		result.RedirectCodes = append(result.RedirectCodes, uint16(max(redirect.StatusCode, 0)))
	}
	if fetched.ErrorCode != "" {
		result.FetchOutcome = "FAILED"
		result.Findings = append(result.Findings, finding(lease.PageID, "fetch.failed", "TECHNICAL", "ERROR", "FETCH_FAILED", "Page fetch failed.", map[string]any{"errorCode": fetched.ErrorCode}))
		return result
	}
	if fetched.StatusCode >= 400 {
		result.FetchOutcome = "HTTP_ERROR"
		result.Findings = append(result.Findings, finding(lease.PageID, "http.error", "TECHNICAL", "ERROR", "HTTP_ERROR", "Page returned an HTTP error status.", map[string]any{"statusCode": fetched.StatusCode}))
	} else {
		result.FetchOutcome = "SUCCESS"
	}
	if !IsHTMLContentType(fetched.ContentType) {
		return result
	}
	data, err := ParseHTML(fetched.Body, result.FinalURL, lease.Hostname)
	if err != nil {
		result.FetchOutcome = "FAILED"
		result.ErrorCode = "HTML_PARSE_FAILED"
		result.ErrorMessage = "HTML could not be parsed."
		return result
	}
	result.Title, result.Description, result.CanonicalURL = data.Title, data.MetaDescription, data.CanonicalURL
	result.MetaRobots, result.HTMLLang, result.H1, result.H2 = data.MetaRobots, data.HTMLLang, data.H1, data.H2
	result.WordCount = uint32(data.WordCount)
	result.ImageCount, result.MissingAlt = uint32(data.ImageCount), uint32(data.ImageMissingAltCount)
	result.IsIndexable = fetched.StatusCode >= 200 && fetched.StatusCode < 400 && !strings.Contains(strings.ToLower(data.MetaRobots), "noindex")
	for index, link := range data.Links {
		converted := model.DiscoveredLink{
			TargetURL: link.TargetURL, AnchorText: link.AnchorText, Tag: link.Tag,
			RelValues: link.RelValues, IsInternal: link.IsInternal,
			IsFollowable: link.IsFollowable, Ordinal: uint32(index),
		}
		result.Links = append(result.Links, converted)
		if link.IsInternal {
			result.InternalLinks++
		} else {
			result.ExternalLinks++
		}
	}
	if data.Title == "" {
		result.Findings = append(result.Findings, finding(lease.PageID, "title.missing", "CONTENT", "WARNING", "TITLE_MISSING", "Page does not have a title.", nil))
	}
	if data.MetaDescription == "" {
		result.Findings = append(result.Findings, finding(lease.PageID, "meta-description.missing", "CONTENT", "INFO", "META_DESCRIPTION_MISSING", "Page does not have a meta description.", nil))
	}
	if len(data.H1) == 0 {
		result.Findings = append(result.Findings, finding(lease.PageID, "h1.missing", "CONTENT", "WARNING", "H1_MISSING", "Page does not have an H1 heading.", nil))
	}
	if data.ImageMissingAltCount > 0 {
		result.Findings = append(result.Findings, finding(lease.PageID, "image.alt.missing", "CONTENT", "INFO", "IMAGE_ALT_MISSING", "One or more images have no alternative text.", map[string]any{"count": data.ImageMissingAltCount}))
	}
	return result
}

func finding(pageID uuid.UUID, ruleID, category, severity, code, message string, evidence map[string]any) model.Finding {
	if evidence == nil {
		evidence = map[string]any{}
	}
	return model.Finding{
		FindingID: uuid.NewSHA1(pageID, []byte(ruleID+":1")), RuleID: ruleID,
		RuleVersion: 1, Category: category, Severity: severity, Code: code,
		Message: message, Evidence: evidence,
	}
}

func (e *Engine) runReclaimer(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := e.store.ReclaimExpired(ctx); err != nil {
				e.logger.Error("reclaim expired leases failed", "error", err)
			}
			e.refreshBackpressure(ctx)
		}
	}
}

func (e *Engine) refreshBackpressure(ctx context.Context) {
	blocked, err := e.store.AnalyticsBackpressured(ctx, e.backlogAge)
	if err != nil {
		if !e.backpressured.Swap(true) {
			e.logger.Error("analytics backlog check failed; page claiming paused", "error", err)
		}
		return
	}
	previous := e.backpressured.Swap(blocked)
	if blocked && !previous {
		e.logger.Warn("analytics backlog exceeded limit; page claiming paused", "maximumAge", e.backlogAge)
	} else if !blocked && previous {
		e.logger.Info("analytics backlog recovered; page claiming resumed")
	}
}
