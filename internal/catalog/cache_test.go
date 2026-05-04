package catalog

import (
	"context"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bmarty/metgate/internal/metgate"
)

// TestCache_HitAfterMiss : second call sur la même clé n'appelle pas fetch.
func TestCache_HitAfterMiss(t *testing.T) {
	c := newResponseCache(time.Minute)
	var calls atomic.Int32
	fetch := func(ctx context.Context) (*metgate.Response, error) {
		calls.Add(1)
		return &metgate.Response{Status: 200, Body: []byte("hello")}, nil
	}

	q := url.Values{"a": {"1"}}
	r1, err := c.get(context.Background(), "/p", q, fetch)
	if err != nil {
		t.Fatal(err)
	}
	if r1.FromCache {
		t.Error("première lecture: FromCache attendu false")
	}

	r2, err := c.get(context.Background(), "/p", q, fetch)
	if err != nil {
		t.Fatal(err)
	}
	if !r2.FromCache {
		t.Error("seconde lecture: FromCache attendu true")
	}
	if calls.Load() != 1 {
		t.Errorf("fetch appelé %d fois, attendu 1", calls.Load())
	}
}

// TestCache_TTLExpiry : après TTL, on refetch.
func TestCache_TTLExpiry(t *testing.T) {
	c := newResponseCache(50 * time.Millisecond)
	var calls atomic.Int32
	fetch := func(ctx context.Context) (*metgate.Response, error) {
		calls.Add(1)
		return &metgate.Response{Status: 200, Body: []byte("v")}, nil
	}

	_, _ = c.get(context.Background(), "/p", nil, fetch)
	time.Sleep(80 * time.Millisecond)
	_, _ = c.get(context.Background(), "/p", nil, fetch)

	if got := calls.Load(); got != 2 {
		t.Errorf("après expiration, attendu 2 fetches, got %d", got)
	}
}

// TestCache_SingleflightDedup : 100 goroutines sur la même clé n'appellent
// fetch qu'une seule fois (singleflight).
func TestCache_SingleflightDedup(t *testing.T) {
	c := newResponseCache(time.Minute)
	var calls atomic.Int32
	// fetch lent pour garantir que les 100 goroutines arrivent pendant
	// que la première est en vol.
	fetch := func(ctx context.Context) (*metgate.Response, error) {
		calls.Add(1)
		time.Sleep(50 * time.Millisecond)
		return &metgate.Response{Status: 200, Body: []byte("dedup")}, nil
	}

	var wg sync.WaitGroup
	const N = 100
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := c.get(context.Background(), "/dedup", nil, fetch)
			if err != nil {
				t.Errorf("get: %v", err)
			}
		}()
	}
	wg.Wait()

	if got := calls.Load(); got != 1 {
		t.Errorf("singleflight: attendu 1 fetch, got %d", got)
	}
}

// TestCache_Status500NotCached : un 500 ne pollue pas le cache (le prochain
// call refait la requête).
func TestCache_Status500NotCached(t *testing.T) {
	c := newResponseCache(time.Minute)
	var calls atomic.Int32
	fetch := func(ctx context.Context) (*metgate.Response, error) {
		calls.Add(1)
		return &metgate.Response{Status: 500, Body: []byte("err")}, nil
	}

	for i := 0; i < 3; i++ {
		_, _ = c.get(context.Background(), "/err", nil, fetch)
	}
	if got := calls.Load(); got != 3 {
		t.Errorf("statuts !=200 ne doivent pas être cachés, got %d fetches sur 3 calls", got)
	}
}

// TestCache_DistinctKeysIndependent : deux clés différentes (path+query)
// donnent deux entrées indépendantes.
func TestCache_DistinctKeysIndependent(t *testing.T) {
	c := newResponseCache(time.Minute)
	var calls atomic.Int32
	fetch := func(ctx context.Context) (*metgate.Response, error) {
		calls.Add(1)
		return &metgate.Response{Status: 200, Body: []byte("ok")}, nil
	}

	_, _ = c.get(context.Background(), "/a", url.Values{"x": {"1"}}, fetch)
	_, _ = c.get(context.Background(), "/a", url.Values{"x": {"2"}}, fetch)
	_, _ = c.get(context.Background(), "/b", url.Values{"x": {"1"}}, fetch)

	if got := calls.Load(); got != 3 {
		t.Errorf("3 clés distinctes attendues, got %d fetches", got)
	}
}

// TestCache_TTLZeroDisabled : TTL <= 0 court-circuite le cache.
func TestCache_TTLZeroDisabled(t *testing.T) {
	c := newResponseCache(0)
	var calls atomic.Int32
	fetch := func(ctx context.Context) (*metgate.Response, error) {
		calls.Add(1)
		return &metgate.Response{Status: 200, Body: []byte("ok")}, nil
	}

	for i := 0; i < 5; i++ {
		_, _ = c.get(context.Background(), "/p", nil, fetch)
	}
	if got := calls.Load(); got != 5 {
		t.Errorf("TTL=0: chaque call doit fetch, got %d sur 5", got)
	}
}

// TestCache_FromCacheCopyDoesntMutate : muter la copie reçue par un caller
// ne corrompt pas l'entrée du cache.
func TestCache_FromCacheCopyDoesntMutate(t *testing.T) {
	c := newResponseCache(time.Minute)
	fetch := func(ctx context.Context) (*metgate.Response, error) {
		return &metgate.Response{Status: 200, Body: []byte("origin")}, nil
	}

	r1, _ := c.get(context.Background(), "/p", nil, fetch)
	// Le caller mute le champ FromCache (cas réaliste : on attend false la
	// 1ère fois). On vérifie que le 2ème call retourne bien FromCache=true.
	r1.FromCache = true

	r2, _ := c.get(context.Background(), "/p", nil, fetch)
	if !r2.FromCache {
		t.Error("seconde lecture doit indiquer FromCache=true (entrée du cache préservée)")
	}
}
