.PHONY: run build test lint tidy clean web web-dev dev

# Build complet : frontend puis binaire avec dist embarqué.
build: web
	mkdir -p bin
	go build -o bin/portal ./cmd/portal

# Lance le serveur Go (utilise le dist déjà buildé dans internal/web/dist).
run:
	go run ./cmd/portal

# Build du frontend uniquement (sortie dans internal/web/dist/).
web:
	cd web && npm run build
	touch internal/web/dist/.gitkeep

# Frontend en mode dev (hot reload, proxy /api → :8080). Lancer le backend
# avec `make run` dans un autre terminal.
web-dev:
	cd web && npm run dev

# Boucle dev: on lance vite et le go en parallèle, à toi d'ouvrir 2 terminaux.
dev:
	@echo "lance 'make run' dans un terminal et 'make web-dev' dans un autre"

test:
	go test ./...

lint:
	golangci-lint run ./...

tidy:
	go mod tidy

clean:
	rm -rf bin/ internal/web/dist/assets internal/web/dist/index.html web/dist
