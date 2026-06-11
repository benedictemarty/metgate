// Package httpx centralise la construction des clients HTTP sortants du
// portail (MetGate, OpenSky, adsb.fi, EUMETSAT, EUMETView). Tous les flux
// extérieurs partagent le même http.Transport, ce qui permet de configurer un
// proxy d'entreprise en un seul endroit, via l'environnement (.env inclus) :
//
//   - OUTBOUND_PROXY_URL : proxy explicite (http://host:port, https://… ou
//     socks5://…) appliqué à tous les flux sortants. Prioritaire sur les
//     variables standard. Une URL invalide fait échouer toutes les requêtes
//     sortantes avec une erreur explicite (pas de fallback silencieux en
//     accès direct).
//   - HTTP_PROXY / HTTPS_PROXY / NO_PROXY (ou minuscules) : convention Unix
//     standard, honorée via http.ProxyFromEnvironment quand OUTBOUND_PROXY_URL
//     est absent.
//   - NO_PROXY : hôtes à joindre en direct, séparés par des virgules. Entrée
//     exacte (`metgate-int.meteo.fr`), suffixe de domaine (`.meteo.fr`) ou
//     `*` (tout en direct). Honoré aussi avec OUTBOUND_PROXY_URL.
//   - OUTBOUND_CA_FILE : certificats CA PEM supplémentaires (proxy TLS
//     interceptant) ajoutés au pool système.
//   - OUTBOUND_TLS_INSECURE=1 : désactive la vérification TLS sortante.
//     Dernier recours uniquement ; loggé en Warn au démarrage.
package httpx

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

var (
	once   sync.Once
	shared http.RoundTripper
)

// NewClient retourne un client HTTP sortant avec le timeout demandé, branché
// sur le transport partagé (proxy + TLS configurés depuis l'environnement).
func NewClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: Transport()}
}

// EnvOr retourne la valeur de la variable d'environnement key, ou def si elle
// est absente ou vide. Utilisé par les clients sortants pour rendre leurs URLs
// surchargables (.env / docker compose) tout en gardant un défaut codé.
// Un éventuel `/` final est retiré pour que la concaténation de chemins reste
// stable quelle que soit la forme saisie.
func EnvOr(key, def string) string {
	v := os.Getenv(key)
	if v == "" {
		v = def
	}
	return strings.TrimRight(v, "/")
}

// Transport retourne le transport sortant partagé. Construit une seule fois ;
// le .env doit donc être chargé avant le premier appel (cas de main.go).
func Transport() http.RoundTripper {
	once.Do(func() { shared = buildTransport() })
	return shared
}

func buildTransport() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = proxyFunc(os.Getenv("OUTBOUND_PROXY_URL"), noProxyEnv())

	if caFile := os.Getenv("OUTBOUND_CA_FILE"); caFile != "" {
		if pool, err := caPool(caFile); err == nil {
			ensureTLS(t).RootCAs = pool
		} else {
			slog.Error("OUTBOUND_CA_FILE illisible — pool système seul", "file", caFile, "err", err)
		}
	}
	if os.Getenv("OUTBOUND_TLS_INSECURE") == "1" {
		ensureTLS(t).InsecureSkipVerify = true
	}
	return t
}

func ensureTLS(t *http.Transport) *tls.Config {
	if t.TLSClientConfig == nil {
		t.TLSClientConfig = &tls.Config{}
	}
	return t.TLSClientConfig
}

func caPool(file string) (*x509.CertPool, error) {
	pem, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("aucun certificat PEM valide dans %s", file)
	}
	return pool, nil
}

// proxyFunc construit la fonction Proxy du transport. proxyRaw vaut
// OUTBOUND_PROXY_URL ; vide → délégation à http.ProxyFromEnvironment
// (HTTP_PROXY/HTTPS_PROXY/NO_PROXY standard).
func proxyFunc(proxyRaw, noProxy string) func(*http.Request) (*url.URL, error) {
	if proxyRaw == "" {
		return http.ProxyFromEnvironment
	}
	proxyURL, parseErr := url.Parse(proxyRaw)
	if parseErr == nil && (proxyURL.Scheme == "" || proxyURL.Host == "") {
		parseErr = fmt.Errorf("schéma ou hôte manquant (attendu http://host:port)")
	}
	return func(req *http.Request) (*url.URL, error) {
		if parseErr != nil {
			return nil, fmt.Errorf("OUTBOUND_PROXY_URL invalide (%q) : %w", proxyRaw, parseErr)
		}
		if bypassProxy(req.URL.Hostname(), noProxy) {
			return nil, nil
		}
		return proxyURL, nil
	}
}

func noProxyEnv() string {
	if v := os.Getenv("NO_PROXY"); v != "" {
		return v
	}
	return os.Getenv("no_proxy")
}

// bypassProxy retourne true si host (sans port) figure dans la liste NO_PROXY.
// Règles : `*` court-circuite tout ; une entrée préfixée d'un point est un
// suffixe de domaine ; sinon correspondance exacte ou sous-domaine.
func bypassProxy(host, noProxy string) bool {
	host = strings.ToLower(host)
	for entry := range strings.SplitSeq(noProxy, ",") {
		entry = strings.ToLower(strings.TrimSpace(entry))
		if entry == "" {
			continue
		}
		if entry == "*" {
			return true
		}
		// Ignorer un éventuel :port dans l'entrée (on ne filtre que l'hôte).
		// Une IP littérale (dont IPv6 sans crochets, ex. ::1) est gardée telle
		// quelle ; sinon on coupe si ce qui suit le dernier `:` est numérique.
		if net.ParseIP(entry) == nil {
			if i := strings.LastIndex(entry, ":"); i > 0 && isDigits(entry[i+1:]) {
				entry = entry[:i]
			}
			entry = strings.Trim(entry, "[]")
		}
		entry = strings.TrimPrefix(entry, ".")
		if host == entry || strings.HasSuffix(host, "."+entry) {
			return true
		}
	}
	return false
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// LogConfig logge au démarrage la configuration proxy/TLS effective des flux
// sortants (credentials masqués). À appeler après le chargement du .env.
func LogConfig() {
	switch raw := os.Getenv("OUTBOUND_PROXY_URL"); {
	case raw != "":
		if u, err := url.Parse(raw); err == nil && u.Scheme != "" && u.Host != "" {
			slog.Info("flux sortants via proxy", "proxy", u.Redacted(), "no_proxy", noProxyEnv())
		} else {
			slog.Error("OUTBOUND_PROXY_URL invalide — toutes les requêtes sortantes échoueront", "valeur", raw)
		}
	case os.Getenv("HTTPS_PROXY") != "" || os.Getenv("https_proxy") != "" ||
		os.Getenv("HTTP_PROXY") != "" || os.Getenv("http_proxy") != "":
		slog.Info("flux sortants via proxy d'environnement",
			"https_proxy", redactEnvProxy("HTTPS_PROXY", "https_proxy"),
			"http_proxy", redactEnvProxy("HTTP_PROXY", "http_proxy"),
			"no_proxy", noProxyEnv())
	default:
		slog.Info("flux sortants en accès direct (pas de proxy configuré)")
	}

	if f := os.Getenv("OUTBOUND_CA_FILE"); f != "" {
		slog.Info("CA supplémentaire pour les flux sortants", "file", f)
	}
	if os.Getenv("OUTBOUND_TLS_INSECURE") == "1" {
		slog.Warn("OUTBOUND_TLS_INSECURE=1 — vérification TLS sortante DÉSACTIVÉE")
	}
}

func redactEnvProxy(keys ...string) string {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			if u, err := url.Parse(v); err == nil && u.Host != "" {
				return u.Redacted()
			}
			return v
		}
	}
	return ""
}
