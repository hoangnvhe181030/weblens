package analytics

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

var ErrPageNotFound = errors.New("page report was not found")

func (s *Sink) ListPages(ctx context.Context, ownerID, scanID uuid.UUID) ([]model.ReportPage, error) {
	rows, err := s.connection.Query(ctx, fmt.Sprintf(`
		SELECT page_id, scan_id, normalized_url, final_url, status_code,
		       fetch_outcome, total_ms, response_bytes, title, h1,
		       internal_link_count + external_link_count, image_count, observed_at
		FROM %s.page_metrics_current
		WHERE owner_id = ? AND scan_id = ?
		ORDER BY normalized_url, page_id
		LIMIT 100`, quoteIdentifier(s.database)), ownerID, scanID)
	if err != nil {
		return nil, fmt.Errorf("query page report: %w", err)
	}
	defer rows.Close()
	pages := make([]model.ReportPage, 0)
	for rows.Next() {
		var page model.ReportPage
		var statusCode uint16
		var fetchOutcome string
		if err := rows.Scan(
			&page.ID, &page.ScanID, &page.URL, &page.FinalURL, &statusCode,
			&fetchOutcome, &page.ResponseTimeMS, &page.ResponseBytes, &page.Title,
			&page.H1, &page.Links, &page.Images, &page.ObservedAt,
		); err != nil {
			return nil, fmt.Errorf("scan page report: %w", err)
		}
		page.StatusCode = int(statusCode)
		page.Outcome = publicPageOutcome(fetchOutcome, statusCode)
		page.Findings = make([]model.ReportFinding, 0)
		pages = append(pages, page)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate page report: %w", err)
	}
	findings, err := s.listFindings(ctx, ownerID, scanID, uuid.Nil)
	if err != nil {
		return nil, err
	}
	byPage := make(map[uuid.UUID][]model.ReportFinding)
	for _, finding := range findings {
		byPage[finding.pageID] = append(byPage[finding.pageID], finding.value)
	}
	for index := range pages {
		if pageFindings, ok := byPage[pages[index].ID]; ok {
			pages[index].Findings = pageFindings
		}
	}
	return pages, nil
}

func (s *Sink) GetPage(ctx context.Context, ownerID, pageID uuid.UUID) (model.ReportPage, error) {
	var page model.ReportPage
	var statusCode uint16
	var fetchOutcome string
	err := s.connection.QueryRow(ctx, fmt.Sprintf(`
		SELECT page_id, scan_id, normalized_url, final_url, status_code,
		       fetch_outcome, total_ms, response_bytes, title, h1,
		       internal_link_count + external_link_count, image_count, observed_at
		FROM %s.page_metrics_current
		WHERE owner_id = ? AND page_id = ?
		LIMIT 1`, quoteIdentifier(s.database)), ownerID, pageID).Scan(
		&page.ID, &page.ScanID, &page.URL, &page.FinalURL, &statusCode,
		&fetchOutcome, &page.ResponseTimeMS, &page.ResponseBytes, &page.Title,
		&page.H1, &page.Links, &page.Images, &page.ObservedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.ReportPage{}, ErrPageNotFound
		}
		return model.ReportPage{}, fmt.Errorf("query page detail: %w", err)
	}
	page.StatusCode = int(statusCode)
	page.Outcome = publicPageOutcome(fetchOutcome, statusCode)
	page.Findings = make([]model.ReportFinding, 0)
	findings, err := s.listFindings(ctx, ownerID, page.ScanID, pageID)
	if err != nil {
		return model.ReportPage{}, err
	}
	for _, finding := range findings {
		page.Findings = append(page.Findings, finding.value)
	}
	return page, nil
}

type pageFinding struct {
	pageID uuid.UUID
	value  model.ReportFinding
}

func (s *Sink) listFindings(ctx context.Context, ownerID, scanID, pageID uuid.UUID) ([]pageFinding, error) {
	query := fmt.Sprintf(`
		SELECT page_id, finding_id, severity, finding_code, message, evidence_json
		FROM %s.findings_current
		WHERE owner_id = ? AND scan_id = ?`, quoteIdentifier(s.database))
	arguments := []any{ownerID, scanID}
	if pageID != uuid.Nil {
		query += " AND page_id = ?"
		arguments = append(arguments, pageID)
	}
	query += " ORDER BY page_id, severity, rule_id, finding_id LIMIT 5000"
	rows, err := s.connection.Query(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("query findings report: %w", err)
	}
	defer rows.Close()
	findings := make([]pageFinding, 0)
	for rows.Next() {
		var finding pageFinding
		var evidenceJSON string
		if err := rows.Scan(
			&finding.pageID, &finding.value.ID, &finding.value.Severity,
			&finding.value.Title, &finding.value.Description, &evidenceJSON,
		); err != nil {
			return nil, fmt.Errorf("scan finding report: %w", err)
		}
		finding.value.Evidence = make(map[string]any)
		if err := json.Unmarshal([]byte(evidenceJSON), &finding.value.Evidence); err != nil {
			return nil, fmt.Errorf("decode finding evidence: %w", err)
		}
		findings = append(findings, finding)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate findings report: %w", err)
	}
	return findings, nil
}

func publicPageOutcome(fetchOutcome string, statusCode uint16) string {
	if strings.EqualFold(fetchOutcome, "SUCCESS") && statusCode < 400 {
		return "SUCCESS"
	}
	if strings.EqualFold(fetchOutcome, "SKIPPED") {
		return "WARNING"
	}
	return "FAILED"
}
