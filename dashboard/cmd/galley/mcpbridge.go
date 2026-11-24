package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// runMCPBridge implements `galley mcp`: a stdio MCP server for agents that
// only speak stdio (newline-delimited JSON-RPC). It forwards each message to
// a galley instance's /mcp endpoint.
//
//	galley mcp --url https://galley.example:8443 [--fingerprint AA:BB:…]
//	with the agent token in GALLEY_TOKEN.
func runMCPBridge(args []string) int {
	fs := flag.NewFlagSet("mcp", flag.ExitOnError)
	base := fs.String("url", os.Getenv("GALLEY_URL"), "galley base URL (or GALLEY_URL)")
	fp := fs.String("fingerprint", os.Getenv("GALLEY_FINGERPRINT"), "SHA-256 fingerprint of galley's TLS certificate, for galley's self-signed certificate (or GALLEY_FINGERPRINT)")
	_ = fs.Parse(args)
	token := os.Getenv("GALLEY_TOKEN")
	if *base == "" || !strings.HasPrefix(token, "glly_") {
		fmt.Fprintln(os.Stderr, "galley mcp: set --url (or GALLEY_URL) and GALLEY_TOKEN=glly_… (create an agent token in galley under Agents)")
		return 2
	}
	u, err := url.Parse(*base)
	if err != nil || u.Host == "" {
		fmt.Fprintln(os.Stderr, "galley mcp: invalid --url")
		return 2
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
		fmt.Fprintln(os.Stderr, "galley mcp: --url must be https:// (the token would travel in clear text)")
		return 2
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if *fp != "" {
		want := strings.ToUpper(strings.NewReplacer(":", "", " ", "").Replace(strings.TrimPrefix(strings.TrimSpace(*fp), "sha256/")))
		tlsCfg.InsecureSkipVerify = true // replaced by the pin check below
		tlsCfg.VerifyConnection = func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("no certificate")
			}
			sum := sha256.Sum256(cs.PeerCertificates[0].Raw)
			if fmt.Sprintf("%X", sum[:]) != want {
				return errors.New("galley certificate does not match --fingerprint")
			}
			return nil
		}
	} else {
		pool, _ := x509.SystemCertPool()
		tlsCfg.RootCAs = pool
	}
	hc := &http.Client{Timeout: 3 * time.Minute, Transport: &http.Transport{TLSClientConfig: tlsCfg}}
	endpoint := strings.TrimRight(*base, "/") + "/mcp"
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 0, 1<<20), 16<<20)
	out := bufio.NewWriter(os.Stdout)
	for in.Scan() {
		line := bytes.TrimSpace(in.Bytes())
		if len(line) == 0 {
			continue
		}
		req, _ := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(line))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Authorization", "Bearer "+token)
		var probe struct {
			ID json.RawMessage `json:"id"`
		}
		_ = json.Unmarshal(line, &probe)
		fail := func(msg string) { // answer requests (not notifications) so clients never hang
			fmt.Fprintln(os.Stderr, "galley mcp:", msg)
			if len(probe.ID) == 0 || line[0] == '[' {
				return
			}
			b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": probe.ID, "error": map[string]any{"code": -32000, "message": msg}})
			out.Write(b)
			out.WriteByte('\n')
			out.Flush()
		}
		resp, err := hc.Do(req)
		if err != nil {
			fail(err.Error())
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
		resp.Body.Close()
		body = bytes.TrimSpace(body)
		if resp.StatusCode == http.StatusAccepted {
			continue
		}
		if resp.StatusCode != http.StatusOK {
			var e struct{ Error string }
			_ = json.Unmarshal(body, &e)
			if resp.StatusCode == http.StatusUnauthorized {
				e.Error = "the agent token was rejected (expired or revoked)"
			}
			if e.Error == "" {
				e.Error = resp.Status
			}
			fail(e.Error)
			continue
		}
		if len(body) == 0 || (body[0] != '{' && body[0] != '[') {
			fail("unexpected response from galley")
			continue
		}
		out.Write(body)
		out.WriteByte('\n')
		out.Flush()
	}
	return 0
}
