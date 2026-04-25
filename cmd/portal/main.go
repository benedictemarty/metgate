package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/bmarty/metgate/internal/metgate"
)

func main() {
	service := flag.String("service", "RAW", "OGC service: RAW | WFS | WCS")
	version := flag.String("version", "1.0.0", "service version (RAW=1.0.0, WFS=2.0.0, WCS=2.0.1)")
	flag.Parse()

	if err := loadDotenv(".env"); err != nil {
		log.Printf("warn: .env: %v", err)
	}

	baseURL := os.Getenv("METGATE_BASE_URL")
	token := os.Getenv("METGATE_TOKEN")
	if baseURL == "" || token == "" {
		log.Fatal("METGATE_BASE_URL et METGATE_TOKEN doivent être définis (cf .env)")
	}

	client := metgate.New(baseURL, token)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	body, status, err := client.GetCapabilities(ctx, *service, *version)
	if err != nil {
		log.Fatalf("GetCapabilities: %v", err)
	}
	fmt.Printf("service=%s version=%s\n", *service, *version)
	fmt.Printf("status: %d\n", status)
	fmt.Printf("content-length: %d bytes\n\n", len(body))

	preview := body
	if len(preview) > 1500 {
		preview = preview[:1500]
	}
	fmt.Println(string(preview))
	if len(body) > 1500 {
		fmt.Println("\n... [tronqué]")
	}
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
