package crawl

import "testing"

func TestNormalizeURLRemovesTrackingAndFragment(t *testing.T) {
	t.Parallel()
	normalized, err := NormalizeURL(" HTTPS://Example.COM:443//docs/?b=2&utm_source=test&a=1#part ")
	if err != nil {
		t.Fatalf("NormalizeURL returned an error: %v", err)
	}
	if normalized != "https://example.com/docs/?a=1&b=2" {
		t.Fatalf("unexpected normalized URL: %q", normalized)
	}
}

func TestIsHTTPURLInScopeRejectsCredentialsAndOtherHosts(t *testing.T) {
	t.Parallel()
	cases := []struct {
		url      string
		hostname string
		allowed  bool
	}{
		{"https://example.com/docs", "example.com", true},
		{"https://user@example.com/docs", "example.com", false},
		{"https://sub.example.com/docs", "example.com", false},
		{"file:///etc/passwd", "example.com", false},
	}
	for _, testCase := range cases {
		if actual := IsHTTPURLInScope(testCase.url, testCase.hostname); actual != testCase.allowed {
			t.Errorf("IsHTTPURLInScope(%q, %q) = %v", testCase.url, testCase.hostname, actual)
		}
	}
}
