.PHONY: run build deploy test lint tidy clean web web-dev dev

# Variables déploiement LXC Proxmox
PROXMOX_SSH  := root@atlas.alterop.ovh
PROXMOX_PORT := 210
LXC_ID       := 121
LXC_DEST     := /opt/metgate/portal

# Build complet : frontend puis binaire avec dist embarqué.
# CGO_ENABLED=0 pour un binaire statique compatible LXC/Docker.
build: web
	mkdir -p bin
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o bin/portal ./cmd/portal

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
	golangci-lint run ./cmd/... ./internal/...

tidy:
	go mod tidy

clean:
	rm -rf bin/ internal/web/dist/assets internal/web/dist/index.html web/dist

# Déploiement sur le LXC Proxmox.
# pct push corrompt les gros binaires (>~10 MB) → on passe par le rootfs monté.
deploy: build
	@echo "→ SCP vers Proxmox…"
	scp -P $(PROXMOX_PORT) -o StrictHostKeyChecking=no bin/portal $(PROXMOX_SSH):/tmp/portal_new
	@echo "→ Injection via rootfs (évite la corruption pct push)…"
	ssh -p $(PROXMOX_PORT) -o StrictHostKeyChecking=no $(PROXMOX_SSH) \
	  "pct mount $(LXC_ID) && \
	   cp /tmp/portal_new /var/lib/lxc/$(LXC_ID)/rootfs$(LXC_DEST) && \
	   chmod +x /var/lib/lxc/$(LXC_ID)/rootfs$(LXC_DEST) && \
	   pct unmount $(LXC_ID) && \
	   pct exec $(LXC_ID) -- systemctl restart metgate && \
	   sleep 3 && pct exec $(LXC_ID) -- systemctl is-active metgate"
