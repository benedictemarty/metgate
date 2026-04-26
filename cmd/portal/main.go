package main

import (
	"bufio"
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/bmarty/metgate/internal/aircraft"
	"github.com/bmarty/metgate/internal/catalog"
	httpapi "github.com/bmarty/metgate/internal/http"
	"github.com/bmarty/metgate/internal/metgate"
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
	ac := aircraft.New(osUser, osPass)
	if osUser == "" {
		log.Print("opensky: anonymous (100 req/jour). Renseigner OPENSKY_USER/PASS pour 4000 req/jour.")
	} else {
		log.Printf("opensky: authenticated as %s", osUser)
	}

	api := httpapi.NewAPI(cat, ac)
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

func loadDotenv(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

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
			os.Setenv(k, v)
		}
	}
	return s.Err()
}
