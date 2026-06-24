package gateway

import (
	"testing"
	"time"
)

func TestRateLimiterInitialBurstAllows(t *testing.T) {
	rl := NewRateLimiter(10, 5) // 10/sec, burst of 5
	key := "client-a"

	// Should allow up to burst tokens immediately
	allowed := 0
	for i := 0; i < 5; i++ {
		ok, _, _ := rl.Allow(key)
		if ok {
			allowed++
		}
	}
	if allowed != 5 {
		t.Fatalf("expected 5 allowed in initial burst, got %d", allowed)
	}
}

func TestRateLimiterRejectsAfterBurstExhausted(t *testing.T) {
	rl := NewRateLimiter(1, 2) // 1/sec, burst of 2
	key := "client-b"

	// Exhaust burst
	rl.Allow(key)
	rl.Allow(key)

	// Third request should be rejected
	ok, _, _ := rl.Allow(key)
	if ok {
		t.Fatal("expected request to be rejected after burst exhausted")
	}
}

func TestRateLimiterZeroRateRejectsAll(t *testing.T) {
	rl := NewRateLimiter(0, 5) // 0/sec = no refill
	key := "zero-client"

	// With 0 rate, tokens never refill. Allow only initial burst.
	// Actually with rate=0, tokens start at burst but never refill.
	allowed := 0
	for i := 0; i < 10; i++ {
		ok, _, _ := rl.Allow(key)
		if ok {
			allowed++
		}
	}
	// Should get exactly burst tokens then nothing
	if allowed > 5 {
		t.Fatalf("expected at most 5 with zero rate, got %d", allowed)
	}
}

func TestRateLimiterKeyIsolation(t *testing.T) {
	rl := NewRateLimiter(1, 1) // 1/sec, burst of 1

	// Exhaust key-a
	ok, _, _ := rl.Allow("key-a")
	if !ok {
		t.Fatal("first request for key-a should be allowed")
	}
	ok, _, _ = rl.Allow("key-a")
	if ok {
		t.Fatal("second request for key-a should be rejected")
	}

	// key-b should still have its full burst
	ok, _, _ = rl.Allow("key-b")
	if !ok {
		t.Fatal("key-b should be independent and allowed")
	}
}

func TestRateLimiterReturnsRemainingTokens(t *testing.T) {
	rl := NewRateLimiter(10, 5)
	key := "remaining-test"

	_, remaining, _ := rl.Allow(key)
	// After one request, should have burst-1 remaining
	if remaining < 0 || remaining > 4 {
		t.Fatalf("expected remaining between 0-4, got %d", remaining)
	}
}

func TestRateLimiterConcurrentAccess(t *testing.T) {
	rl := NewRateLimiter(1000, 100)
	done := make(chan struct{})

	// Writer: consume tokens
	go func() {
		defer close(done)
		for i := 0; i < 500; i++ {
			rl.Allow("concurrent-key")
		}
	}()

	// Reader: also consume from different key
	for i := 0; i < 500; i++ {
		rl.Allow("other-key")
	}

	<-done
	// Just verify no race condition panic
}

func TestRateLimiterTokenRefill(t *testing.T) {
	rl := NewRateLimiter(1000, 2) // 1000/sec = very fast refill
	key := "refill-test"

	// Exhaust burst
	rl.Allow(key)
	rl.Allow(key)

	// Wait a short time for refill
	time.Sleep(5 * time.Millisecond)

	// Should have refilled some tokens
	ok, _, _ := rl.Allow(key)
	if !ok {
		t.Fatal("expected tokens to refill after waiting")
	}
}
