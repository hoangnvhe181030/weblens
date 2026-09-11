// Derived from SEObserver/CrawlObserver internal/normalizer/url.go at
// commit 1cc8d7e822e1ffc4b92b437ceb452bad8a01cfc8 (AGPL-3.0).
package crawl

import (
	"crypto/sha256"
	"net/url"
	"strings"

	"github.com/PuerkitoBio/purell"
)

const normalizationFlags = purell.FlagLowercaseScheme |
	purell.FlagLowercaseHost |
	purell.FlagUppercaseEscapes |
	purell.FlagDecodeUnnecessaryEscapes |
	purell.FlagRemoveDefaultPort |
	purell.FlagRemoveEmptyQuerySeparator |
	purell.FlagRemoveFragment |
	purell.FlagRemoveDuplicateSlashes |
	purell.FlagSortQuery

var trackingParameters = map[string]struct{}{
	"utm_source": {}, "utm_medium": {}, "utm_campaign": {}, "utm_term": {},
	"utm_content": {}, "fbclid": {}, "gclid": {}, "mc_cid": {}, "mc_eid": {},
}

func NormalizeURL(raw string) (string, error) {
	normalized, err := purell.NormalizeURLString(strings.TrimSpace(raw), normalizationFlags)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(normalized)
	if err != nil {
		return "", err
	}
	query := u.Query()
	for parameter := range trackingParameters {
		query.Del(parameter)
	}
	u.RawQuery = query.Encode()
	if u.Host != "" && u.Path == "" {
		u.Path = "/"
	}
	return u.String(), nil
}

func ResolveURL(base, reference string) (string, error) {
	baseURL, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	referenceURL, err := url.Parse(strings.TrimSpace(reference))
	if err != nil {
		return "", err
	}
	return NormalizeURL(baseURL.ResolveReference(referenceURL).String())
}

func URLHash(value string) [32]byte {
	return sha256.Sum256([]byte(value))
}

func IsHTTPURLInScope(raw, hostname string) bool {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return false
	}
	return strings.EqualFold(u.Hostname(), hostname)
}
