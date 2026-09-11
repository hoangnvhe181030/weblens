package crawl

import (
	"net/netip"
	"testing"
)

func TestPublicAddressPolicy(t *testing.T) {
	t.Parallel()
	cases := []struct {
		address string
		public  bool
	}{
		{"8.8.8.8", true},
		{"2606:4700:4700::1111", true},
		{"127.0.0.1", false},
		{"10.0.0.1", false},
		{"169.254.169.254", false},
		{"100.64.0.1", false},
		{"192.0.2.10", false},
		{"198.18.0.1", false},
		{"2001:db8::1", false},
		{"::1", false},
	}
	for _, testCase := range cases {
		address := netip.MustParseAddr(testCase.address)
		if actual := isPublicAddress(address); actual != testCase.public {
			t.Errorf("isPublicAddress(%s) = %v, want %v", address, actual, testCase.public)
		}
	}
}
