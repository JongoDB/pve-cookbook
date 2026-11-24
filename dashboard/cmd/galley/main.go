// Command galley serves the galley cockpit for one or more Proxmox VE clusters.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/fakepve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/fleet"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/pve"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/server"
	"github.com/JongoDB/pve-cookbook/dashboard/internal/store"
	"github.com/JongoDB/pve-cookbook/dashboard/web"
)

func main() {
	listen := flag.String("listen", ":8443", "listen address")
	data := flag.String("data", "/var/lib/galley", "data directory (database, keys, TLS)")
	certFile := flag.String("tls-cert", "", "TLS certificate (default: self-signed in data dir)")
	keyFile := flag.String("tls-key", "", "TLS key")
	plainHTTP := flag.Bool("insecure-http", false, "serve plain HTTP (development only)")
	interval := flag.Duration("poll", 5*time.Second, "cluster poll interval")
	version := flag.Bool("version", false, "print version")
	demo := flag.Bool("demo", false, "register an in-process fake cluster (log in as root / secret) — for trying galley without PVE")
	var admins stringList
	flag.Var(&admins, "admin", "galley admin as cluster:user@realm (logged in to that cluster as that user); repeatable. Default: users with Sys.Modify on / in every registered cluster")
	publicURL := flag.String("public-url", "", "external base URL of galley, e.g. https://galley.example.com (used for single sign-on redirects)")
	sessionIdle := flag.Duration("session-idle", server.DefaultSessionIdle, "end a galley session after this long without requests")
	sessionMax := flag.Duration("session-max", server.DefaultSessionMax, "end a galley session this long after login, however active (per-session API tokens expire with it)")
	flag.Parse()
	if *sessionIdle <= 0 || *sessionMax <= 0 || *sessionIdle > *sessionMax || *sessionMax > 7*24*time.Hour {
		fmt.Fprintln(os.Stderr, "--session-idle and --session-max must be positive, idle ≤ max, and max ≤ 168h")
		os.Exit(2)
	}
	for _, a := range admins {
		if c, u, ok := strings.Cut(a, ":"); !ok || c == "" || !strings.Contains(u, "@") {
			fmt.Fprintf(os.Stderr, "--admin %q: use cluster:user@realm\n", a)
			os.Exit(2)
		}
	}
	if *version {
		fmt.Println(server.Version)
		return
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	var err error

	if *demo { // fresh state each run: the fake cluster gets a new port and certificate every start
		if *data, err = os.MkdirTemp("", "galley-demo-"); err != nil {
			log.Error("demo data dir", "err", err)
			os.Exit(1)
		}
	}
	st, err := store.Open(*data)
	if err != nil {
		log.Error("open store", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	if *demo {
		f := fakepve.New()
		defer f.Close()
		if cs, _ := st.Clusters(); len(cs) == 0 {
			if err := st.AddCluster(store.Cluster{ID: "demo-lab", Name: "demo-lab", Endpoints: []pve.Endpoint{f.Endpoint()}, TokenID: f.TokenID, TokenSecret: f.Secret, CreatedAt: time.Now().Unix()}); err != nil {
				log.Error("demo cluster", "err", err)
				os.Exit(1)
			}
		}
		log.Warn("DEMO MODE: fake cluster demo-lab registered; log in as root / secret (realm pam)")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	poller := fleet.NewPoller(st, *interval, log)
	go poller.Run(ctx)

	static, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		log.Error("embedded UI", "err", err)
		os.Exit(1)
	}
	api := server.New(st, poller, static, log, server.Options{DataDir: *data, SecureCookies: !*plainHTTP, Admins: admins, PublicURL: *publicURL,
		SessionIdle: *sessionIdle, SessionMax: *sessionMax})
	srv := &http.Server{
		Addr:              *listen,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	srv.RegisterOnShutdown(api.StopStreams)
	// Graceful stop: stop accepting requests, let running changes finish
	// (up to 60s; the rest are recorded as interrupted), then exit.
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		<-ctx.Done()
		log.Info("shutting down")
		sctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
		api.Shutdown(sctx)
	}()

	log.Info("galley starting", "version", server.Version, "listen", *listen, "data", *data)
	if *plainHTTP {
		err = srv.ListenAndServe()
	} else {
		if *certFile == "" {
			*certFile, *keyFile, err = ensureSelfSigned(*data)
			if err != nil {
				log.Error("tls", "err", err)
				os.Exit(1)
			}
		}
		srv.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
		err = srv.ListenAndServeTLS(*certFile, *keyFile)
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("serve", "err", err)
		os.Exit(1)
	}
	<-stopped
}

type stringList []string

func (l *stringList) String() string     { return strings.Join(*l, ",") }
func (l *stringList) Set(v string) error { *l = append(*l, v); return nil }

// ensureSelfSigned creates a 5-year ECDSA certificate on first start.
func ensureSelfSigned(dir string) (string, string, error) {
	cert, key := filepath.Join(dir, "tls.crt"), filepath.Join(dir, "tls.key")
	if _, err := os.Stat(cert); err == nil {
		return cert, key, nil
	}
	pk, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", err
	}
	host, _ := os.Hostname()
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	tmpl := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: host, Organization: []string{"galley self-signed"}},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(5, 0, 0),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames: []string{host, "localhost"},
	}
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok {
				tmpl.IPAddresses = append(tmpl.IPAddresses, ipn.IP)
			}
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &pk.PublicKey, pk)
	if err != nil {
		return "", "", err
	}
	kb, err := x509.MarshalECPrivateKey(pk)
	if err != nil {
		return "", "", err
	}
	if err := os.WriteFile(cert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return "", "", err
	}
	return cert, key, os.WriteFile(key, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600)
}
