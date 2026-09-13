// Adapted and hardened from SEObserver/CrawlObserver internal/fetcher/safedialer.go
// at commit 1cc8d7e822e1ffc4b92b437ceb452bad8a01cfc8 (AGPL-3.0).
package crawl

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http/httptrace"
	"net/netip"
	"time"
)

var ErrUnsafeAddress = errors.New("destination address is disallowed by the network policy")

type targetNetworkPolicy uint8

const (
	publicTargetsOnly targetNetworkPolicy = iota
	localTargetsOnly
)

type Resolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}

type networkResolver struct{}

func (networkResolver) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	return net.DefaultResolver.LookupNetIP(ctx, network, host)
}

type SafeDialer struct {
	resolver Resolver
	dialer   net.Dialer
	policy   targetNetworkPolicy
}

func NewSafeDialer(requireLocal bool) *SafeDialer {
	return &SafeDialer{
		resolver: networkResolver{},
		dialer:   net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second},
		policy:   networkPolicy(requireLocal),
	}
}

func newSafeDialerWithResolver(resolver Resolver, requireLocal bool) *SafeDialer {
	return &SafeDialer{
		resolver: resolver,
		dialer:   net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second},
		policy:   networkPolicy(requireLocal),
	}
}

func networkPolicy(requireLocal bool) targetNetworkPolicy {
	if requireLocal {
		return localTargetsOnly
	}
	return publicTargetsOnly
}

func (d *SafeDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, fmt.Errorf("split destination: %w", err)
	}
	if literal, err := netip.ParseAddr(host); err == nil {
		if !d.addressAllowed(literal) {
			return nil, fmt.Errorf("%w: %s", ErrUnsafeAddress, literal)
		}
		return d.dialer.DialContext(ctx, network, net.JoinHostPort(literal.String(), port))
	}

	trace := httptrace.ContextClientTrace(ctx)
	if trace != nil && trace.DNSStart != nil {
		trace.DNSStart(httptrace.DNSStartInfo{Host: host})
	}
	addresses, err := d.resolver.LookupNetIP(ctx, "ip", host)
	if trace != nil && trace.DNSDone != nil {
		info := httptrace.DNSDoneInfo{Err: err}
		if err == nil {
			info.Addrs = make([]net.IPAddr, 0, len(addresses))
			for _, address := range addresses {
				info.Addrs = append(info.Addrs, net.IPAddr{IP: net.IP(address.AsSlice())})
			}
		}
		trace.DNSDone(info)
	}
	if err != nil {
		return nil, fmt.Errorf("resolve destination: %w", err)
	}
	if len(addresses) == 0 {
		return nil, fmt.Errorf("resolve destination: no address for %s", host)
	}
	for _, candidate := range addresses {
		if !d.addressAllowed(candidate) {
			return nil, fmt.Errorf("%w: %s resolves to %s", ErrUnsafeAddress, host, candidate)
		}
	}
	return d.dialer.DialContext(ctx, network, net.JoinHostPort(addresses[0].String(), port))
}

func (d *SafeDialer) addressAllowed(address netip.Addr) bool {
	if d.policy == localTargetsOnly {
		return isLocalAddress(address)
	}
	return isPublicAddress(address)
}

func isLocalAddress(address netip.Addr) bool {
	address = address.Unmap()
	return address.IsValid() && (address.IsLoopback() || address.IsPrivate())
}

var blockedNetworks = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001:db8::/32"),
}

func isPublicAddress(address netip.Addr) bool {
	address = address.Unmap()
	if !address.IsValid() || !address.IsGlobalUnicast() || address.IsPrivate() ||
		address.IsLoopback() || address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() ||
		address.IsMulticast() || address.IsUnspecified() {
		return false
	}
	for _, network := range blockedNetworks {
		if network.Contains(address) {
			return false
		}
	}
	return true
}
