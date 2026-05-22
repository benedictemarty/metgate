package main

import (
	"bufio"
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/bmarty/metgate/internal/aircraft"
	"github.com/bmarty/metgate/internal/airports"
	"github.com/bmarty/metgate/internal/catalog"
	httpapi "github.com/bmarty/metgate/internal/http"
	"github.com/bmarty/metgate/internal/cloudtop"
	"github.com/bmarty/metgate/internal/eumetsat"
	"github.com/bmarty/metgate/internal/lightning"
	"github.com/bmarty/metgate/internal/metgate"
	"github.com/bmarty/metgate/internal/satellite"
)

func main() {
	if err := loadDotenv(".env"); err != nil {
		log.Printf("warn: .env: %v", err)
	}

	baseURL := os.Getenv("METGATE_BASE_URL")
	token := os.Getenv("METGATE_TOKEN")
	port := envOr("PORT", "8080")
	if baseURL == "" || token == "" {
		log.Fatal("METGATE_BASE_URL et METGATE_TOKEN doivent être définis (cf .env)")
	}

	cacheTTL := 60 * time.Second
	if v := os.Getenv("METGATE_CACHE_TTL_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cacheTTL = time.Duration(n) * time.Second
		}
	}

	mg := metgate.New(baseURL, token)
	cat := catalog.New(mg, cacheTTL)

	osUser := os.Getenv("OPENSKY_USER")
	osPass := os.Getenv("OPENSKY_PASS")
	osClientID := os.Getenv("OPENSKY_CLIENT_ID")
	osClientSecret := os.Getenv("OPENSKY_CLIENT_SECRET")
	acClient := aircraft.New(osUser, osPass, osClientID, osClientSecret)
	acService := aircraft.NewService(acClient, 30*time.Minute)
	switch {
	case osClientID != "":
		log.Printf("opensky: OAuth2 (client_id=%s…)", osClientID[:min(8, len(osClientID))])
	case osUser != "":
		log.Printf("opensky: basic auth as %s (legacy)", osUser)
	default:
		log.Print("opensky: anonymous (~100 req/jour). Voir .env pour OPENSKY_CLIENT_ID/SECRET.")
	}

	euKey := os.Getenv("EUMETSAT_CONSUMER_KEY")
	euSecret := os.Getenv("EUMETSAT_CONSUMER_SECRET")
	euClient := eumetsat.New(euKey, euSecret)
	ltClient := lightning.NewFromEUMETSAT(euClient)
	ltService := lightning.NewService(ltClient)
	ctService := cloudtop.NewService(euClient)
	if euClient.Authenticated() {
		log.Printf("eumetsat MTG: OAuth2 actif (key=%s…) — LI / CTTH disponibles", euKey[:min(8, len(euKey))])
	} else {
		log.Print("eumetsat MTG: désactivé (clés absentes — voir .env EUMETSAT_CONSUMER_KEY/SECRET)")
	}

	satProxy := satellite.NewProxy()
	log.Print("eumetview WMS proxy : actif (FCI IR / RGB Convection — situationnel non OPMET)")

	apStore, err := airports.New()
	if err != nil {
		log.Fatalf("airports store: %v", err)
	}
	apStore.LogStats()

	// Pré-chargement CTH en arrière-plan dès le démarrage pour que le premier
	// utilisateur ne subisse pas les 20+ s de téléchargement EUMETSAT.
	ctx, cancelBg := context.WithCancel(context.Background())
	if euClient.Authenticated() {
		ctService.StartBackground(ctx)
		log.Print("CTH: pré-chargement EUMETSAT démarré en arrière-plan")
	}

	// Nettoyer les fichiers temporaires NetCDF laissés par des crashs antérieurs
	// (les defer cleanup() ne s'exécutent pas en cas de SIGSEGV/SIGKILL).
	go cleanupOrphanTempFiles()

	api := httpapi.NewAPI(cat, acService, ltService, satProxy, ctService, apStore)
	log.Printf("cache TTL: %s", cacheTTL)

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           withLogging(api.Routes()),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Printf("portal écoute sur :%s (metgate=%s)", port, baseURL)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-errCh:
		cancelBg()
		log.Fatalf("listen: %v", err)
	case <-quit:
		log.Println("shutdown...")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

type loggingResponseWriter struct {
	http.ResponseWriter
	status int
}

func (w *loggingResponseWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		lw := &loggingResponseWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(lw, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.RequestURI(), lw.status, time.Since(start))
	})
}

func envOr(k, def string) string {
	if v, ok := os.LookupEnv(k); ok && v != "" {
		return v
	}
	return def
}

// cleanupOrphanTempFiles supprime les fichiers temporaires NetCDF laissés par
// des crashs antérieurs (SIGSEGV / SIGKILL empêchent les defer de s'exécuter).
// On ne touche qu'aux fichiers de plus de 5 minutes pour ne pas gêner les
// décodages en cours au moment d'un redémarrage gracieux.
func cleanupOrphanTempFiles() {
	files, _ := filepath.Glob(os.TempDir() + "/metgate-nc-*.nc")
	removed := 0
	for _, f := range files {
		info, err := os.Stat(f)
		if err != nil {
			continue
		}
		if time.Since(info.ModTime()) > 5*time.Minute {
			if os.Remove(f) == nil {
				removed++
			}
		}
	}
	if removed > 0 {
		log.Printf("startup: %d fichier(s) temp NetCDF orphelin(s) supprimé(s)", removed)
	}
}

func loadDotenv(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close() //nolint:errcheck

	s := bufio.NewScanner(f)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		v = strings.Trim(v, `"'`)
		if _, exists := os.LookupEnv(k); !exists {
			os.Setenv(k, v) //nolint:errcheck
		}
	}
	return s.Err()
}
