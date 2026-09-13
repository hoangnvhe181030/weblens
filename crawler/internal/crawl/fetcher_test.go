package crawl

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"testing"
	"time"
)

func TestFetcherMeasuresNetworkPhasesAndTotalDuration(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		time.Sleep(20 * time.Millisecond)
		response.Header().Set("Content-Type", "text/html")
		_, _ = response.Write([]byte("<html><title>Timing fixture</title></html>"))
	}))
	t.Cleanup(server.Close)

	target := fixtureURL(t, server.URL)
	fetcher := NewFetcher("WebLensTimingTest", 2*time.Second, 2, true)
	useFixtureResolver(t, fetcher)
	result := fetcher.Fetch(context.Background(), target, "fixture.test", 1<<20, 3)

	if result.ErrorCode != "" {
		t.Fatalf("fetch failed: %s (%s)", result.ErrorCode, result.ErrorMessage)
	}
	if !result.DNSObserved {
		t.Fatalf("expected an observed DNS phase, got observed=%v duration=%s", result.DNSObserved, result.DNSDuration)
	}
	if !result.ConnectObserved || result.ConnectDuration <= 0 {
		t.Fatalf("expected an observed connect phase, got observed=%v duration=%s", result.ConnectObserved, result.ConnectDuration)
	}
	if result.TLSObserved {
		t.Fatal("plain HTTP request must not report a TLS handshake")
	}
	if !result.TTFBObserved || result.TTFBDuration < 15*time.Millisecond {
		t.Fatalf("expected TTFB to include the delayed response, got observed=%v duration=%s", result.TTFBObserved, result.TTFBDuration)
	}
	if result.TotalDuration < result.TTFBDuration || result.TotalDuration <= 0 {
		t.Fatalf("invalid total duration %s for TTFB %s", result.TotalDuration, result.TTFBDuration)
	}
}

func TestFetcherDoesNotInventConnectionPhasesWhenKeepAliveIsReused(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "text/html")
		_, _ = response.Write([]byte("<html><title>Keep-alive fixture</title></html>"))
	}))
	t.Cleanup(server.Close)

	target := fixtureURL(t, server.URL)
	fetcher := NewFetcher("WebLensTimingTest", 2*time.Second, 1, true)
	useFixtureResolver(t, fetcher)
	first := fetcher.Fetch(context.Background(), target, "fixture.test", 1<<20, 3)
	second := fetcher.Fetch(context.Background(), target, "fixture.test", 1<<20, 3)

	if first.ErrorCode != "" || second.ErrorCode != "" {
		t.Fatalf("fixture fetch failed: first=%s second=%s", first.ErrorCode, second.ErrorCode)
	}
	if !first.ConnectObserved {
		t.Fatal("first request should establish a connection")
	}
	if second.ConnectObserved || second.DNSObserved || second.TLSObserved {
		t.Fatalf(
			"reused connection reported phases: dns=%v connect=%v tls=%v",
			second.DNSObserved,
			second.ConnectObserved,
			second.TLSObserved,
		)
	}
	if !second.TTFBObserved {
		t.Fatalf(
			"reused connection must still report TTFB: observed=%v ttfb=%s total=%s",
			second.TTFBObserved,
			second.TTFBDuration,
			second.TotalDuration,
		)
	}
}

func fixtureURL(t *testing.T, raw string) string {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse fixture URL: %v", err)
	}
	_, port, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		t.Fatalf("split fixture host: %v", err)
	}
	parsed.Host = net.JoinHostPort("fixture.test", port)
	return parsed.String()
}

func useFixtureResolver(t *testing.T, fetcher *Fetcher) {
	t.Helper()
	transport, ok := fetcher.Client().Transport.(*http.Transport)
	if !ok {
		t.Fatal("fetcher transport is not *http.Transport")
	}
	transport.DialContext = newSafeDialerWithResolver(staticResolver{
		addresses: []netip.Addr{netip.MustParseAddr("127.0.0.1")},
	}, true).DialContext
}
