VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X github.com/JongoDB/pve-cookbook/dashboard/internal/server.Version=$(VERSION)
# node_modules contains a stray Go package; never use ./...
PKGS := ./cmd/... ./internal/... ./docs/...

.PHONY: all web build test lint dist e2e
all: web build

web:
	cd web && npm ci && npm run build

build:
	CGO_ENABLED=0 go build -trimpath -ldflags '$(LDFLAGS)' -o galley ./cmd/galley

test:
	go test -race -count=1 $(PKGS)
	cd web && npm test

lint:
	go vet $(PKGS)
	test -z "$$(gofmt -l cmd internal)"
	cd web && npm run typecheck && npm run lint

dist: web
	mkdir -p dist
	for a in amd64 arm64; do CGO_ENABLED=0 GOOS=linux GOARCH=$$a go build -trimpath -ldflags '$(LDFLAGS)' -o dist/galley-linux-$$a ./cmd/galley; done

# End-to-end: the real binary in demo mode, driven by Chromium (see README.md, "end-to-end tests").
e2e: web build
	cd e2e && npm ci && npx playwright install chromium && npx playwright test
