// Adapted from SEObserver/CrawlObserver internal/parser at commit
// 1cc8d7e822e1ffc4b92b437ceb452bad8a01cfc8 (AGPL-3.0).
package crawl

import (
	"bytes"
	"encoding/json"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/PuerkitoBio/goquery"
)

type PageData struct {
	Title                 string
	MetaDescription       string
	MetaKeywords          string
	CanonicalURL          string
	CanonicalRelation     string
	MetaRobots            string
	HTMLLang              string
	H1                    []string
	H2                    []string
	H3                    []string
	H4                    []string
	H5                    []string
	H6                    []string
	Hreflang              []Hreflang
	OpenGraphTitle        string
	OpenGraphDescription  string
	OpenGraphImageURL     string
	SchemaOrgTypes        []string
	SchemaOrgItemCount    int
	SchemaOrgValidCount   int
	SchemaOrgErrorCount   int
	SchemaOrgWarningCount int
	SchemaOrgIssueCodes   []string
	WordCount             int
	ImageCount            int
	ImageMissingAltCount  int
	ScriptCount           int
	StylesheetCount       int
	Links                 []Link
}

type Hreflang struct {
	Language string `json:"language"`
	URL      string `json:"url"`
}

type Link struct {
	TargetURL    string   `json:"targetUrl"`
	AnchorText   string   `json:"anchorText"`
	Tag          string   `json:"tag"`
	RelValues    []string `json:"relValues"`
	IsInternal   bool     `json:"isInternal"`
	IsFollowable bool     `json:"isFollowable"`
}

func ParseHTML(body []byte, pageURL, scopeHostname string) (PageData, error) {
	document, err := goquery.NewDocumentFromReader(bytes.NewReader(body))
	if err != nil {
		return PageData{}, err
	}
	base, err := url.Parse(pageURL)
	if err != nil {
		return PageData{}, err
	}
	data := PageData{
		Title:                firstText(document, "title", 2048),
		MetaDescription:      metaContent(document, "description", 4096),
		MetaKeywords:         metaContent(document, "keywords", 4096),
		CanonicalURL:         canonical(document, base),
		MetaRobots:           metaContent(document, "robots", 512),
		HTMLLang:             bounded(strings.TrimSpace(document.Find("html").First().AttrOr("lang", "")), 64),
		H1:                   texts(document, "h1", 50, 2048),
		H2:                   texts(document, "h2", 100, 2048),
		H3:                   texts(document, "h3", 150, 2048),
		H4:                   texts(document, "h4", 100, 2048),
		H5:                   texts(document, "h5", 50, 2048),
		H6:                   texts(document, "h6", 50, 2048),
		OpenGraphTitle:       propertyContent(document, "og:title", 2048),
		OpenGraphDescription: propertyContent(document, "og:description", 4096),
		WordCount:            countWords(document.Find("body").Text()),
	}
	data.CanonicalRelation = canonicalRelation(data.CanonicalURL, base.String())
	data.OpenGraphImageURL = resolvedPropertyURL(document, "og:image", base, 8192)
	data.Hreflang = hreflangLinks(document, base)
	extractStructuredData(document, &data)
	data.ScriptCount = document.Find("script").Length()
	document.Find("link").Each(func(_ int, selection *goquery.Selection) {
		if containsToken(tokenValues(selection.AttrOr("rel", "")), "stylesheet") {
			data.StylesheetCount++
		}
	})
	document.Find("img").Each(func(_ int, image *goquery.Selection) {
		data.ImageCount++
		if _, present := image.Attr("alt"); !present || strings.TrimSpace(image.AttrOr("alt", "")) == "" {
			data.ImageMissingAltCount++
		}
	})
	document.Find("a, area").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if len(data.Links) >= 2000 {
			return false
		}
		href := strings.TrimSpace(selection.AttrOr("href", ""))
		if href == "" || isNonHTTPReference(href) {
			return true
		}
		resolved, resolveErr := ResolveURL(base.String(), href)
		if resolveErr != nil {
			return true
		}
		rel := tokenValues(selection.AttrOr("rel", ""))
		data.Links = append(data.Links, Link{
			TargetURL: resolved, AnchorText: bounded(strings.TrimSpace(selection.Text()), 2048),
			Tag: goquery.NodeName(selection), RelValues: rel,
			IsInternal: IsHTTPURLInScope(resolved, scopeHostname), IsFollowable: !containsToken(rel, "nofollow"),
		})
		return true
	})
	return data, nil
}

func propertyContent(document *goquery.Document, property string, limit int) string {
	var result string
	document.Find("meta").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if strings.EqualFold(strings.TrimSpace(selection.AttrOr("property", "")), property) {
			result = bounded(strings.TrimSpace(selection.AttrOr("content", "")), limit)
			return false
		}
		return true
	})
	return result
}

func resolvedPropertyURL(document *goquery.Document, property string, base *url.URL, limit int) string {
	raw := propertyContent(document, property, limit)
	if raw == "" {
		return ""
	}
	resolved, err := ResolveURL(base.String(), raw)
	if err != nil {
		return ""
	}
	return bounded(resolved, limit)
}

func canonicalRelation(canonicalURL, pageURL string) string {
	if canonicalURL == "" {
		return "MISSING"
	}
	canonicalNormalized, canonicalErr := NormalizeURL(canonicalURL)
	pageNormalized, pageErr := NormalizeURL(pageURL)
	if canonicalErr == nil && pageErr == nil && canonicalNormalized == pageNormalized {
		return "SELF"
	}
	return "NON_SELF"
}

func hreflangLinks(document *goquery.Document, base *url.URL) []Hreflang {
	values := make([]Hreflang, 0)
	document.Find("link").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if len(values) >= 100 {
			return false
		}
		if !containsToken(tokenValues(selection.AttrOr("rel", "")), "alternate") {
			return true
		}
		language := bounded(strings.TrimSpace(selection.AttrOr("hreflang", "")), 64)
		if language == "" {
			return true
		}
		resolved, err := ResolveURL(base.String(), strings.TrimSpace(selection.AttrOr("href", "")))
		if err != nil {
			return true
		}
		values = append(values, Hreflang{Language: language, URL: bounded(resolved, 8192)})
		return true
	})
	return values
}

const (
	maxJSONLDBlocks = 20
	maxJSONLDBytes  = 1 << 20
)

func extractStructuredData(document *goquery.Document, data *PageData) {
	types := make([]string, 0)
	seen := make(map[string]struct{})
	totalBytes := 0
	blocks := 0
	document.Find("script").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if blocks >= maxJSONLDBlocks || totalBytes >= maxJSONLDBytes {
			return false
		}
		if !strings.EqualFold(strings.TrimSpace(selection.AttrOr("type", "")), "application/ld+json") {
			return true
		}
		blocks++
		raw := []byte(strings.TrimSpace(selection.Text()))
		remaining := maxJSONLDBytes - totalBytes
		if len(raw) > remaining {
			raw = raw[:remaining]
			data.SchemaOrgWarningCount++
			addIssueCode(data, "JSON_LD_INPUT_TRUNCATED")
		}
		totalBytes += len(raw)
		var value any
		if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
			data.SchemaOrgErrorCount++
			addIssueCode(data, "JSON_LD_INVALID")
			return true
		}
		before := data.SchemaOrgItemCount
		collectSchemaTypes(value, &types, seen, &data.SchemaOrgItemCount)
		if data.SchemaOrgItemCount == before {
			data.SchemaOrgWarningCount++
			addIssueCode(data, "JSON_LD_TYPE_MISSING")
		} else {
			data.SchemaOrgValidCount++
		}
		return true
	})
	document.Find("[itemscope][itemtype]").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if len(types) >= 100 {
			return false
		}
		for _, rawType := range strings.Fields(selection.AttrOr("itemtype", "")) {
			addSchemaType(schemaTypeName(rawType), &types, seen)
			data.SchemaOrgItemCount++
			data.SchemaOrgValidCount++
		}
		return true
	})
	data.SchemaOrgTypes = types
}

func collectSchemaTypes(value any, types *[]string, seen map[string]struct{}, itemCount *int) {
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			collectSchemaTypes(item, types, seen, itemCount)
		}
	case map[string]any:
		if rawType, ok := typed["@type"]; ok {
			before := len(*types)
			switch typeValue := rawType.(type) {
			case string:
				addSchemaType(schemaTypeName(typeValue), types, seen)
			case []any:
				for _, candidate := range typeValue {
					if text, ok := candidate.(string); ok {
						addSchemaType(schemaTypeName(text), types, seen)
					}
				}
			}
			if len(*types) > before {
				(*itemCount)++
			}
		}
		for key, child := range typed {
			if key == "@type" {
				continue
			}
			collectSchemaTypes(child, types, seen, itemCount)
		}
	}
}

func schemaTypeName(value string) string {
	value = strings.TrimSpace(value)
	if parsed, err := url.Parse(value); err == nil && parsed.IsAbs() {
		if fragment := parsed.Fragment; fragment != "" {
			value = fragment
		} else if path := strings.Trim(parsed.Path, "/"); path != "" {
			parts := strings.Split(path, "/")
			value = parts[len(parts)-1]
		}
	}
	return bounded(value, 255)
}

func addSchemaType(value string, values *[]string, seen map[string]struct{}) {
	if value == "" || len(*values) >= 100 {
		return
	}
	key := strings.ToLower(value)
	if _, exists := seen[key]; exists {
		return
	}
	seen[key] = struct{}{}
	*values = append(*values, value)
}

func addIssueCode(data *PageData, code string) {
	if len(data.SchemaOrgIssueCodes) >= 20 {
		return
	}
	for _, existing := range data.SchemaOrgIssueCodes {
		if existing == code {
			return
		}
	}
	data.SchemaOrgIssueCodes = append(data.SchemaOrgIssueCodes, code)
}

func firstText(document *goquery.Document, selector string, limit int) string {
	return bounded(strings.TrimSpace(document.Find(selector).First().Text()), limit)
}

func metaContent(document *goquery.Document, name string, limit int) string {
	var result string
	document.Find("meta").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if strings.EqualFold(strings.TrimSpace(selection.AttrOr("name", "")), name) {
			result = bounded(strings.TrimSpace(selection.AttrOr("content", "")), limit)
			return false
		}
		return true
	})
	return result
}

func canonical(document *goquery.Document, base *url.URL) string {
	var result string
	document.Find("link").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if containsToken(tokenValues(selection.AttrOr("rel", "")), "canonical") {
			if resolved, err := ResolveURL(base.String(), selection.AttrOr("href", "")); err == nil {
				result = bounded(resolved, 8192)
			}
			return false
		}
		return true
	})
	return result
}

func texts(document *goquery.Document, selector string, maxItems, maxLength int) []string {
	values := make([]string, 0)
	document.Find(selector).EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if len(values) >= maxItems {
			return false
		}
		value := bounded(strings.TrimSpace(selection.Text()), maxLength)
		if value != "" {
			values = append(values, value)
		}
		return true
	})
	return values
}

func countWords(value string) int {
	count, inWord := 0, false
	for _, character := range value {
		if unicode.IsLetter(character) || unicode.IsDigit(character) {
			if !inWord {
				count++
			}
			inWord = true
		} else {
			inWord = false
		}
	}
	return count
}

func tokenValues(value string) []string {
	parts := strings.Fields(strings.ToLower(value))
	if len(parts) > 32 {
		parts = parts[:32]
	}
	return parts
}

func containsToken(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func isNonHTTPReference(value string) bool {
	lower := strings.ToLower(value)
	return strings.HasPrefix(lower, "#") || strings.HasPrefix(lower, "mailto:") ||
		strings.HasPrefix(lower, "tel:") || strings.HasPrefix(lower, "javascript:") ||
		strings.HasPrefix(lower, "data:")
}

func bounded(value string, limit int) string {
	if len(value) > limit {
		value = value[:limit]
		for !utf8.ValidString(value) {
			value = value[:len(value)-1]
		}
	}
	return value
}
