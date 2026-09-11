package crawl

import (
	"context"
	"net/url"
	"sync"
	"time"

	"github.com/temoto/robotstxt"
)

type robotsEntry struct {
	group     *robotstxt.Group
	expiresAt time.Time
}

type RobotsCache struct {
	mu        sync.Mutex
	entries   map[string]robotsEntry
	fetcher   *Fetcher
	userAgent string
}

func NewRobotsCache(fetcher *Fetcher, userAgent string) *RobotsCache {
	return &RobotsCache{entries: make(map[string]robotsEntry), fetcher: fetcher, userAgent: userAgent}
}

func (c *RobotsCache) Allowed(ctx context.Context, targetURL, hostname string, maxRedirects int) bool {
	target, err := url.Parse(targetURL)
	if err != nil {
		return false
	}
	key := target.Scheme + "://" + target.Host
	c.mu.Lock()
	entry, present := c.entries[key]
	c.mu.Unlock()
	if present && time.Now().Before(entry.expiresAt) {
		return entry.group == nil || entry.group.Test(target.EscapedPath())
	}

	robotsURL := key + "/robots.txt"
	result := c.fetcher.Fetch(ctx, robotsURL, hostname, 512*1024, maxRedirects)
	var group *robotstxt.Group
	if result.ErrorCode == "" && result.StatusCode >= 200 && result.StatusCode < 300 {
		if robots, parseErr := robotstxt.FromBytes(result.Body); parseErr == nil {
			group = robots.FindGroup(c.userAgent)
		}
	}
	c.mu.Lock()
	c.entries[key] = robotsEntry{group: group, expiresAt: time.Now().Add(time.Hour)}
	c.mu.Unlock()
	return group == nil || group.Test(target.EscapedPath())
}
