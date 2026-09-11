// Adapted from SEObserver/CrawlObserver internal/fetcher at commit
// 1cc8d7e822e1ffc4b92b437ceb452bad8a01cfc8 (AGPL-3.0).
package crawl

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var ErrOutOfScopeRedirect = errors.New("redirect leaves the registered hostname")

type requestPolicyKey struct{}

type requestPolicy struct {
	hostname     string
	maxRedirects int
	redirects    []RedirectHop
}

type RedirectHop struct {
	URL        string `json:"url"`
	StatusCode int    `json:"statusCode"`
}

type FetchResult struct {
	RequestedURL  string
	FinalURL      string
	StatusCode    int
	ContentType   string
	Body          []byte
	BodyBytes     int64
	BodyTruncated bool
	TotalDuration time.Duration
	Redirects     []RedirectHop
	ErrorCode     string
	ErrorMessage  string
}

type Fetcher struct {
	client    *http.Client
	userAgent string
}

func NewFetcher(userAgent string, timeout time.Duration, allowPrivate bool) *Fetcher {
	dialer := NewSafeDialer(allowPrivate)
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            dialer.DialContext,
		ForceAttemptHTTP2:      true,
		MaxIdleConns:           100,
		MaxIdleConnsPerHost:    2,
		IdleConnTimeout:        90 * time.Second,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  15 * time.Second,
		ExpectContinueTimeout:  time.Second,
		MaxResponseHeaderBytes: 1 << 20,
	}
	client := &http.Client{Timeout: timeout, Transport: transport}
	client.CheckRedirect = func(request *http.Request, previous []*http.Request) error {
		policy, ok := request.Context().Value(requestPolicyKey{}).(*requestPolicy)
		if !ok {
			return errors.New("missing redirect policy")
		}
		if len(previous) > policy.maxRedirects {
			return errors.New("redirect limit exceeded")
		}
		if !strings.EqualFold(request.URL.Hostname(), policy.hostname) {
			return fmt.Errorf("%w: %s", ErrOutOfScopeRedirect, request.URL.Hostname())
		}
		if request.Response != nil && len(previous) > 0 {
			policy.redirects = append(policy.redirects, RedirectHop{
				URL: previous[len(previous)-1].URL.String(), StatusCode: request.Response.StatusCode,
			})
		}
		return nil
	}
	return &Fetcher{client: client, userAgent: userAgent}
}

func (f *Fetcher) Fetch(ctx context.Context, targetURL, hostname string, maxBodyBytes int64, maxRedirects int) FetchResult {
	result := FetchResult{RequestedURL: targetURL}
	started := time.Now()
	defer func() { result.TotalDuration = time.Since(started) }()

	policy := &requestPolicy{hostname: hostname, maxRedirects: maxRedirects}
	ctx = context.WithValue(ctx, requestPolicyKey{}, policy)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		result.ErrorCode, result.ErrorMessage = "invalid_url", boundedMessage(err.Error())
		return result
	}
	request.Header.Set("User-Agent", f.userAgent)
	request.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9")

	response, err := f.client.Do(request)
	if err != nil {
		result.ErrorCode, result.ErrorMessage = categorizeFetchError(err), boundedMessage(err.Error())
		return result
	}
	defer response.Body.Close()

	result.FinalURL = response.Request.URL.String()
	result.StatusCode = response.StatusCode
	result.ContentType = response.Header.Get("Content-Type")
	result.Redirects = append(result.Redirects, policy.redirects...)
	reader := io.LimitReader(response.Body, maxBodyBytes+1)
	body, err := io.ReadAll(reader)
	if err != nil {
		result.ErrorCode, result.ErrorMessage = "body_read_failed", boundedMessage(err.Error())
		return result
	}
	if int64(len(body)) > maxBodyBytes {
		body = body[:maxBodyBytes]
		result.BodyTruncated = true
	}
	result.Body = body
	result.BodyBytes = int64(len(body))
	return result
}

func (f *Fetcher) Client() *http.Client { return f.client }

func IsHTMLContentType(value string) bool {
	lower := strings.ToLower(value)
	return value == "" || strings.Contains(lower, "text/html") || strings.Contains(lower, "application/xhtml+xml")
}

func categorizeFetchError(err error) string {
	if errors.Is(err, ErrUnsafeAddress) {
		return "ssrf_blocked"
	}
	if errors.Is(err, ErrOutOfScopeRedirect) {
		return "redirect_out_of_scope"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	var dnsError *net.DNSError
	if errors.As(err, &dnsError) {
		return "dns_failed"
	}
	var urlError *url.Error
	if errors.As(err, &urlError) && urlError.Timeout() {
		return "timeout"
	}
	return "network_failed"
}

func boundedMessage(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 500 {
		return value[:500]
	}
	return value
}
