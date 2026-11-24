// Package pve is a small Proxmox VE API client with multi-endpoint failover,
// TLS fingerprint pinning, API-token auth (read-only poller) and ticket auth
// (per-user mutations, including TOTP second factor).
package pve

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Endpoint is one node's API address and the pinned leaf-certificate fingerprint.
type Endpoint struct {
	Host        string `json:"host"`        // "192.0.2.11" or "pve1.example.internal:8006"
	Fingerprint string `json:"fingerprint"` // "AB:CD:…" sha256 of leaf cert; empty = system roots only
}

func (e Endpoint) baseURL() string {
	h := e.Host
	if _, _, err := net.SplitHostPort(h); err != nil {
		h = net.JoinHostPort(h, "8006")
	}
	return "https://" + h + "/api2/json"
}

// Auth adds credentials to a request.
type Auth interface{ apply(r *http.Request) }

// TokenAuth is a PVE API token ("user@realm!name", secret uuid).
type TokenAuth struct{ ID, Secret string }

func (t TokenAuth) apply(r *http.Request) {
	r.Header.Set("Authorization", "PVEAPIToken="+t.ID+"="+t.Secret)
}

// Ticket is a user session ticket from /access/ticket.
type Ticket struct {
	User    string    `json:"user"`
	Ticket  string    `json:"-"`
	CSRF    string    `json:"-"`
	Expires time.Time `json:"expires"`
}

func (t *Ticket) apply(r *http.Request) {
	r.AddCookie(&http.Cookie{Name: "PVEAuthCookie", Value: t.Ticket})
	if r.Method != http.MethodGet {
		r.Header.Set("CSRFPreventionToken", t.CSRF)
	}
}

// APIError is a non-2xx response from PVE.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("pve: %d %s", e.Status, e.Message) }

// Client talks to one cluster through any of its endpoints.
type Client struct {
	endpoints []Endpoint
	auth      Auth
	http      *http.Client

	mu     sync.Mutex
	active int
}

// New returns a client. auth may be nil (only Login/Probe then work).
func New(endpoints []Endpoint, auth Auth) *Client {
	c := &Client{endpoints: endpoints, auth: auth}
	c.http = &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			Proxy:               nil,
			TLSHandshakeTimeout: 8 * time.Second,
			MaxIdleConnsPerHost: 4,
			IdleConnTimeout:     90 * time.Second,
			DialContext:         (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
			// Verification happens per-endpoint in DialTLSContext below.
			DialTLSContext: c.dialTLS,
		},
	}
	return c
}

// WithAuth returns a copy sharing endpoints but using different credentials.
func (c *Client) WithAuth(a Auth) *Client { return New(c.endpoints, a) }

// Active reports the endpoint currently in use.
func (c *Client) Active() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.endpoints[c.active].Host
}

func (c *Client) dialTLS(ctx context.Context, network, addr string) (net.Conn, error) {
	var ep *Endpoint
	for i := range c.endpoints {
		u, _ := url.Parse(c.endpoints[i].baseURL())
		if u.Host == addr {
			ep = &c.endpoints[i]
			break
		}
	}
	if ep == nil {
		return nil, fmt.Errorf("pve: unknown endpoint %s", addr)
	}
	host, _, _ := net.SplitHostPort(addr)
	cfg := &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: true, // we verify ourselves: system roots OR pinned fingerprint
		VerifyConnection: func(cs tls.ConnectionState) error {
			return verifyEndpoint(cs, host, ep.Fingerprint)
		},
	}
	d := &tls.Dialer{NetDialer: &net.Dialer{Timeout: 5 * time.Second}, Config: cfg}
	return d.DialContext(ctx, network, addr)
}

func verifyEndpoint(cs tls.ConnectionState, host, pin string) error {
	if len(cs.PeerCertificates) == 0 {
		return errors.New("pve: no peer certificate")
	}
	leaf := cs.PeerCertificates[0]
	if pin != "" && strings.EqualFold(Fingerprint(leaf), pin) {
		return nil
	}
	inter := x509.NewCertPool()
	for _, c := range cs.PeerCertificates[1:] {
		inter.AddCert(c)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{DNSName: host, Intermediates: inter}); err == nil {
		return nil
	}
	if pin == "" {
		return fmt.Errorf("pve: certificate for %s is not trusted by system roots and no fingerprint is pinned (got %s)", host, Fingerprint(leaf))
	}
	return fmt.Errorf("pve: certificate fingerprint mismatch for %s: pinned %s, got %s", host, pin, Fingerprint(leaf))
}

// Fingerprint formats a certificate's SHA-256 like PVE does ("AB:CD:…").
func Fingerprint(c *x509.Certificate) string {
	sum := sha256.Sum256(c.Raw)
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = fmt.Sprintf("%02X", b)
	}
	return strings.Join(parts, ":")
}

// retryable reports whether trying the next endpoint could help.
func retryable(err error, status int) bool {
	if err != nil {
		var ae *APIError
		if errors.As(err, &ae) {
			return false
		}
		return true // network/TLS error
	}
	// 595/596: pveproxy cannot reach the target; 502-504 gateway errors.
	return status == 595 || status == 596 || status == 502 || status == 503 || status == 504
}

// Do performs a request and decodes the "data" member into out (may be nil).
// params are sent as query (GET/DELETE) or form body (POST/PUT), as PVE expects.
func (c *Client) Do(ctx context.Context, method, path string, params url.Values, out any) error {
	c.mu.Lock()
	start := c.active
	c.mu.Unlock()
	var lastErr error
	for i := 0; i < len(c.endpoints); i++ {
		idx := (start + i) % len(c.endpoints)
		status, err := c.doOnce(ctx, c.endpoints[idx], method, path, params, out)
		if err == nil {
			c.mu.Lock()
			c.active = idx
			c.mu.Unlock()
			return nil
		}
		lastErr = err
		if ctx.Err() != nil || !retryable(err, status) {
			return err
		}
	}
	return lastErr
}

func (c *Client) doOnce(ctx context.Context, ep Endpoint, method, path string, params url.Values, out any) (int, error) {
	u := ep.baseURL() + path
	var body io.Reader
	if params != nil && (method == http.MethodGet || method == http.MethodDelete) {
		u += "?" + params.Encode()
	} else if params != nil {
		body = strings.NewReader(params.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if c.auth != nil {
		c.auth.apply(req)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return resp.StatusCode, err
	}
	if resp.StatusCode/100 != 2 {
		msg := strings.TrimSpace(resp.Status)
		var e struct {
			Message string            `json:"message"`
			Errors  map[string]string `json:"errors"`
		}
		if json.Unmarshal(raw, &e) == nil {
			if e.Message != "" {
				msg = strings.TrimSpace(e.Message)
			}
			for k, v := range e.Errors {
				msg += fmt.Sprintf("; %s: %s", k, strings.TrimSpace(v))
			}
		}
		if retryable(nil, resp.StatusCode) {
			return resp.StatusCode, fmt.Errorf("pve: %s via %s", msg, ep.Host)
		}
		return resp.StatusCode, &APIError{Status: resp.StatusCode, Message: msg}
	}
	if out == nil {
		return resp.StatusCode, nil
	}
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return resp.StatusCode, fmt.Errorf("pve: decode %s: %w", path, err)
	}
	if len(env.Data) == 0 || string(env.Data) == "null" {
		return resp.StatusCode, nil
	}
	return resp.StatusCode, json.Unmarshal(env.Data, out)
}

// Get is shorthand for Do(GET).
func (c *Client) Get(ctx context.Context, path string, out any) error {
	return c.Do(ctx, http.MethodGet, path, nil, out)
}

// Login obtains a ticket. otp is required when the user has TOTP configured.
func (c *Client) Login(ctx context.Context, userAtRealm, password, otp string) (*Ticket, error) {
	var r struct {
		Ticket   string `json:"ticket"`
		CSRF     string `json:"CSRFPreventionToken"`
		Username string `json:"username"`
		NeedTFA  int    `json:"NeedTFA"`
	}
	form := url.Values{"username": {userAtRealm}, "password": {password}}
	if err := c.Do(ctx, http.MethodPost, "/access/ticket", form, &r); err != nil {
		return nil, err
	}
	if r.NeedTFA == 1 || strings.Contains(r.Ticket, "!tfa!") {
		if otp == "" {
			return nil, &APIError{Status: 401, Message: "second factor required"}
		}
		form = url.Values{"username": {userAtRealm}, "tfa-challenge": {r.Ticket}, "password": {"totp:" + otp}}
		if err := c.Do(ctx, http.MethodPost, "/access/ticket", form, &r); err != nil {
			return nil, err
		}
	}
	if r.Ticket == "" {
		return nil, &APIError{Status: 401, Message: "authentication failed"}
	}
	return &Ticket{User: r.Username, Ticket: r.Ticket, CSRF: r.CSRF, Expires: time.Now().Add(110 * time.Minute)}, nil
}

// Probe reports reachability and the leaf fingerprint of one endpoint without trusting it.
type Probe struct {
	Host            string `json:"host"`
	Reachable       bool   `json:"reachable"`
	Fingerprint     string `json:"fingerprint,omitempty"`
	TrustedBySystem bool   `json:"trustedBySystem"`
	Error           string `json:"error,omitempty"`
}

// ProbeEndpoint connects with verification disabled and reports what it saw.
func ProbeEndpoint(ctx context.Context, host string) Probe {
	p := Probe{Host: host}
	u, _ := url.Parse(Endpoint{Host: host}.baseURL())
	d := &tls.Dialer{NetDialer: &net.Dialer{Timeout: 5 * time.Second}, Config: &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}} //nolint:gosec // probing only, never used for API calls
	conn, err := d.DialContext(ctx, "tcp", u.Host)
	if err != nil {
		p.Error = err.Error()
		return p
	}
	defer conn.Close()
	cs := conn.(*tls.Conn).ConnectionState()
	p.Reachable = true
	if len(cs.PeerCertificates) > 0 {
		p.Fingerprint = Fingerprint(cs.PeerCertificates[0])
		h, _, _ := net.SplitHostPort(u.Host)
		p.TrustedBySystem = verifyEndpoint(cs, h, "") == nil
	}
	return p
}
