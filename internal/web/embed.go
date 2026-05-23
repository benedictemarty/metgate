// Package web embarque le build statique du frontend Vite/React et expose
// un http.Handler qui sert la SPA (avec fallback index.html pour le routing
// client-side).
package web

import (
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"strings"
)

func init() {
	// Sur conteneurs Linux minimaux (Debian/Alpine sans mime-support), le fichier
	// /etc/mime.types peut ne pas contenir text/javascript. http.FileServer tomberait
	// alors sur "text/plain", ce qui bloque le chargement des ES modules dans le
	// navigateur ("MIME type not allowed"). On enregistre explicitement les types
	// critiques pour le frontend Vite/React.
	for ext, ct := range map[string]string{
		".js":    "text/javascript; charset=utf-8",
		".mjs":   "text/javascript; charset=utf-8",
		".css":   "text/css; charset=utf-8",
		".svg":   "image/svg+xml",
		".woff2": "font/woff2",
		".woff":  "font/woff",
	} {
		_ = mime.AddExtensionType(ext, ct)
	}
}

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
//
// Stratégie de cache :
//   - index.html (et toute route SPA) : no-cache, must-revalidate — le
//     navigateur redemande toujours, ce qui garantit que les nouveaux hashes
//     Vite sont chargés après un déploiement. Sans ça, un index.html mis en
//     cache référence des chunks avec d'anciens hashes qui n'existent plus →
//     le serveur renvoie 404 en text/plain → Firefox affiche "MIME interdit".
//   - Assets Vite (*.js, *.css…) : immutable, max-age=1 an — les hashes de
//     contenu garantissent que deux fichiers de même nom sont identiques.
//
// Les assets inconnus (extension explicite mais fichier absent) renvoient 404
// plutôt que le fallback index.html — sinon les sourcemaps DevTools reçoivent
// du HTML que le navigateur tente de parser.
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
			if isAssetPath(path) {
				http.NotFound(w, r)
				return
			}
			path = "index.html"
			r = r.Clone(r.Context())
			r.URL.Path = "/"
		}
		// Cache-Control différencié : index.html toujours revalidé,
		// assets Vite (hashes dans le nom) mis en cache de façon permanente.
		if path == "index.html" || !isAssetPath(path) {
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		fileServer.ServeHTTP(w, r)
	})
}

func isAssetPath(p string) bool {
	idx := strings.LastIndexByte(p, '.')
	if idx < 0 {
		return false
	}
	switch strings.ToLower(p[idx:]) {
	case ".js", ".css", ".map", ".svg", ".ico", ".png", ".jpg", ".jpeg",
		".gif", ".webp", ".woff", ".woff2", ".ttf", ".otf", ".json":
		return true
	}
	return false
}
