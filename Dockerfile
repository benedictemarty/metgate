# syntax=docker/dockerfile:1.7

# ─── Étape 1 : build du frontend React/Vite ─────────────────────────────────
# Base pin par digest (immutabilité, anti tag-drift). Bumper via Renovate/Dependabot.
FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS web-builder
WORKDIR /src/web

# Cache npm sur le lockfile
COPY web/package.json web/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY web/ ./
# tsc -b && vite build → sortie dans ../internal/web/dist (go:embed)
COPY internal/web/dist/.gitkeep /src/internal/web/dist/.gitkeep
RUN npm run build

# ─── Étape 2 : build du binaire Go avec dist embarqué ───────────────────────
FROM golang:1.24-alpine@sha256:8bee1901f1e530bfb4a7850aa7a479d17ae3a18beb6e09064ed54cfd245b7191 AS go-builder
WORKDIR /src

# Cache modules sur go.sum
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY . .
# Récupère le dist frontend produit à l'étape précédente (écrase le .gitkeep)
COPY --from=web-builder /src/internal/web/dist/ ./internal/web/dist/

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ARG VERSION=dev

RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.Version=$VERSION" \
    -o /out/portal ./cmd/portal

# ─── Étape 3 : runtime minimal ──────────────────────────────────────────────
FROM gcr.io/distroless/static-debian12:nonroot@sha256:d093aa3e30dbadd3efe1310db061a14da60299baff8450a17fe0ccc514a16639 AS runtime
WORKDIR /app
COPY --from=go-builder /out/portal /app/portal

ENV PORT=8080
EXPOSE 8080
USER nonroot:nonroot

ENTRYPOINT ["/app/portal"]
