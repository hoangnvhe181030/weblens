package crawl

import (
	"strings"
	"testing"
)

func TestParseHTMLExtractsBoundedDeterministicSignals(t *testing.T) {
	t.Parallel()
	body := strings.NewReader(`<!doctype html><html lang="vi"><head>
		<title>WebLens</title><meta name="description" content="Giám sát website">
		<link rel="canonical" href="/home?utm_source=test"></head><body>
		<h1>Tổng quan</h1><h2>Chi tiết</h2><p>Một hai ba</p>
		<img src="a.png"><img src="b.png" alt="Mô tả">
		<a href="/docs?utm_campaign=x">Tài liệu</a>
		<a href="https://other.example/path" rel="nofollow">Ngoài</a>
		</body></html>`)
	data, err := ParseHTML([]byte(readAll(t, body)), "https://example.com/start", "example.com")
	if err != nil {
		t.Fatalf("ParseHTML returned an error: %v", err)
	}
	if data.Title != "WebLens" || data.CanonicalURL != "https://example.com/home" {
		t.Fatalf("unexpected metadata: title=%q canonical=%q", data.Title, data.CanonicalURL)
	}
	if len(data.Links) != 2 || !data.Links[0].IsInternal || data.Links[1].IsFollowable {
		t.Fatalf("unexpected links: %#v", data.Links)
	}
	if data.ImageCount != 2 || data.ImageMissingAltCount != 1 || data.WordCount < 5 {
		t.Fatalf("unexpected counts: %#v", data)
	}
}

func readAll(t *testing.T, reader *strings.Reader) string {
	t.Helper()
	buffer := make([]byte, reader.Len())
	if _, err := reader.Read(buffer); err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return string(buffer)
}
