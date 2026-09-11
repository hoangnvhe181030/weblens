// Adapted from SEObserver/CrawlObserver internal/parser at commit
// 1cc8d7e822e1ffc4b92b437ceb452bad8a01cfc8 (AGPL-3.0).
package crawl

import (
	"bytes"
	"net/url"
	"strings"
	"unicode"

	"github.com/PuerkitoBio/goquery"
)

type PageData struct {
	Title                string
	MetaDescription      string
	CanonicalURL         string
	MetaRobots           string
	HTMLLang             string
	H1                   []string
	H2                   []string
	WordCount            int
	ImageCount           int
	ImageMissingAltCount int
	Links                []Link
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
		Title:           firstText(document, "title", 2048),
		MetaDescription: metaContent(document, "description", 4096),
		CanonicalURL:    canonical(document, base),
		MetaRobots:      metaContent(document, "robots", 512),
		HTMLLang:        bounded(strings.TrimSpace(document.Find("html").First().AttrOr("lang", "")), 64),
		H1:              texts(document, "h1", 50, 2048),
		H2:              texts(document, "h2", 100, 2048),
		WordCount:       countWords(document.Find("body").Text()),
	}
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
		return value[:limit]
	}
	return value
}
