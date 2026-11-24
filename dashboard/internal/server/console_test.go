package server_test

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestConsoleWebsocketProxy(t *testing.T) {
	h := newHarness(t)
	h.setup()
	root := h.login("root@pam", "secret")
	var c struct{ Token, Protocol, Password string }
	if code := root.do("POST", "/api/clusters/pve-lab/console", map[string]any{"type": "qemu", "node": "pve1", "vmid": 120}, &c); code != 200 || c.Protocol != "vnc" || c.Token == "" {
		t.Fatalf("open: %d %+v", code, c)
	}
	dev := h.login("dev@pve", "devpass")
	if code := dev.do("POST", "/api/clusters/pve-lab/console", map[string]any{"type": "node", "node": "pve1"}, nil); code != 403 {
		t.Fatalf("PVE refusal not passed through: %d", code)
	}
	u, _ := url.Parse(h.ts.URL)
	dial := func(token, origin string) (string, net.Conn, *bufio.Reader) {
		conn, err := net.Dial("tcp", u.Host)
		if err != nil {
			t.Fatal(err)
		}
		cookie := ""
		for _, ck := range root.hc.Jar.Cookies(u) {
			cookie += ck.Name + "=" + ck.Value + "; "
		}
		req := "GET /api/console/" + token + " HTTP/1.1\r\nHost: " + u.Host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: " + cookie + "\r\n"
		if origin != "" {
			req += "Origin: " + origin + "\r\n"
		}
		_, _ = io.WriteString(conn, req+"\r\n")
		br := bufio.NewReader(conn)
		resp, err := http.ReadResponse(br, nil)
		if err != nil {
			t.Fatal(err)
		}
		return resp.Status, conn, br
	}
	if st, conn, _ := dial(c.Token, "https://evil.example"); !strings.HasPrefix(st, "403") {
		t.Fatalf("cross-origin console: %s", st)
	} else {
		conn.Close()
	}
	// the cross-origin attempt was refused before consuming the token
	st, conn, br := dial(c.Token, "http://"+u.Host)
	defer conn.Close()
	if !strings.HasPrefix(st, "101") {
		t.Fatalf("upgrade: %s", st)
	}
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	_, _ = io.WriteString(conn, "hello-console")
	buf := make([]byte, 13)
	if _, err := io.ReadFull(br, buf); err != nil || string(buf) != "hello-console" {
		t.Fatalf("echo: %q %v", buf, err)
	}
	if st2, c2, _ := dial(c.Token, ""); !strings.HasPrefix(st2, "404") {
		t.Fatalf("token reused: %s", st2)
	} else {
		c2.Close()
	}
}
