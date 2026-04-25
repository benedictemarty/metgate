.PHONY: run build test tidy clean

run:
	go run ./cmd/portal

build:
	mkdir -p bin
	go build -o bin/portal ./cmd/portal

test:
	go test ./...

tidy:
	go mod tidy

clean:
	rm -rf bin/
