package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestBypassProxy(t *testing.T) {
	cases := []struct {
		host, noProxy string
		want          bool
	}{
		{"metgate-int.meteo.fr", "", false},
		{"metgate-int.meteo.fr", "*", true},
		{"metgate-int.meteo.fr", "metgate-int.meteo.fr", true},
		{"metgate-int.meteo.fr", ".meteo.fr", true},
		{"metgate-int.meteo.fr", "meteo.fr", true}, // sous-domaine sans point initial
		{"meteo.fr", "meteo.fr", true},
		{"notmeteo.fr", "meteo.fr", false}, // pas de match partiel sans frontière de domaine
		{"opensky-network.org", "localhost, .meteo.fr ,127.0.0.1", false},
		{"localhost", "localhost,.meteo.fr", true},
		{"METGATE-INT.METEO.FR", ".meteo.fr", true},   // insensible à la casse
		{"metgate-int.meteo.fr", "meteo.fr:443", true}, // port ignoré
		{"::1", "::1", true},                           // IPv6 sans port, non mutilée
	}
	for _, c := range cases {
		if got := bypassProxy(c.host, c.noProxy); got != c.want {
			t.Errorf("bypassProxy(%q, %q) = %v, want %v", c.host, c.noProxy, got, c.want)
		}
	}
}

func TestProxyFuncExplicit(t *testing.T) {
	pf := proxyFunc("http://proxy.corp:3128", ".meteo.fr")

	req := httptest.NewRequest("GET", "https://opensky-network.org/api/states/all", nil)
	u, err := pf(req)
	if err != nil {
		t.Fatalf("err inattendue: %v", err)
	}
	if u == nil || u.Host != "proxy.corp:3128" {
		t.Fatalf("proxy attendu proxy.corp:3128, got %v", u)
	}

	// Hôte dans NO_PROXY → accès direct.
	req = httptest.NewRequest("GET", "https://metgate-int.meteo.fr/broker_service/catalog", nil)
	u, err = pf(req)
	if err != nil {
		t.Fatalf("err inattendue: %v", err)
	}
	if u != nil {
		t.Fatalf("accès direct attendu pour NO_PROXY, got %v", u)
	}
}

func TestProxyFuncInvalidURL(t *testing.T) {
	pf := proxyFunc("proxy.corp:3128", "") // schéma manquant → erreur explicite
	req := httptest.NewRequest("GET", "https://opensky-network.org/", nil)
	if _, err := pf(req); err == nil {
		t.Fatal("erreur attendue pour une OUTBOUND_PROXY_URL sans schéma")
	}
}

func TestProxyFuncEmptyDelegatesToEnvironment(t *testing.T) {
	// Sans OUTBOUND_PROXY_URL et sans HTTP(S)_PROXY, accès direct.
	t.Setenv("HTTP_PROXY", "")
	t.Setenv("HTTPS_PROXY", "")
	t.Setenv("http_proxy", "")
	t.Setenv("https_proxy", "")
	pf := proxyFunc("", "")
	req := httptest.NewRequest("GET", "https://api.eumetsat.int/token", nil)
	u, err := pf(req)
	if err != nil {
		t.Fatalf("err inattendue: %v", err)
	}
	if u != nil {
		t.Fatalf("accès direct attendu sans configuration, got %v", u)
	}
}

// TestTransportRoutesThroughProxy vérifie de bout en bout qu'une requête vers
// un hôte fictif est réellement routée vers le proxy configuré (le serveur de
// test joue le rôle du proxy : il reçoit la requête en URL absolue).
func TestTransportRoutesThroughProxy(t *testing.T) {
	hit := false
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(http.StatusOK)
	}))
	defer proxy.Close()

	t.Setenv("OUTBOUND_PROXY_URL", proxy.URL)
	c := &http.Client{Transport: buildTransport()}
	resp, err := c.Get("http://hote-fictif.invalid/healthz")
	if err != nil {
		t.Fatalf("requête via proxy: %v", err)
	}
	resp.Body.Close() //nolint:errcheck
	if !hit {
		t.Fatal("la requête n'est pas passée par le proxy")
	}
}

func TestEnvOr(t *testing.T) {
	t.Setenv("HTTPX_TEST_URL", "")
	if got := EnvOr("HTTPX_TEST_URL", "https://defaut.example"); got != "https://defaut.example" {
		t.Errorf("défaut attendu, got %q", got)
	}
	t.Setenv("HTTPX_TEST_URL", "https://miroir.interne/")
	if got := EnvOr("HTTPX_TEST_URL", "https://defaut.example"); got != "https://miroir.interne" {
		t.Errorf("surcharge sans slash final attendue, got %q", got)
	}
}

func TestNewClientSharesTransport(t *testing.T) {
	a := NewClient(10 * time.Second)
	b := NewClient(20 * time.Second)
	if a.Transport == nil || a.Transport != b.Transport {
		t.Fatal("les clients doivent partager le même transport sortant")
	}
	if a.Timeout != 10*time.Second || b.Timeout != 20*time.Second {
		t.Fatal("timeouts indépendants attendus")
	}
}
