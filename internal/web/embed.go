// Package web embarque le build statique du frontend Vite/React et expose
// un http.Handler qui sert la SPA (avec fallback index.html pour le routing
// client-side).
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:dist
var distFS embed.FS

// FS retourne la racine du build (web/dist).
func FS() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic("web: dist filesystem indisponible: " + err.Error())
	}
	return sub
}

// Handler sert les fichiers statiques avec fallback sur index.html.
// Les requêtes vers /api/* et /healthz sont laissées en 404 (elles doivent
// être routées avant ce handler dans le ServeMux).
func Handler() http.Handler {
	sub := FS()
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/healthz" {
			http.NotFound(w, r)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if _, err := fs.Stat(sub, path); err != nil {
			r = r.Clone(r.Context())
			r.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, r)
	})
}
