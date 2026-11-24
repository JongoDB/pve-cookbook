package pve

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
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

// WSConn is a minimal RFC 6455 client connection, enough to drive PVE's
// termproxy (vncwebsocket) without a browser. It is not safe for concurrent
// readers; writes are serialised.
type WSConn struct {
	conn net.Conn
	br   *bufio.Reader
	wmu  sync.Mutex
}

// MaxWSMessage bounds one received websocket message.
const MaxWSMessage = 4 << 20

// DialWebsocket opens a websocket to path (below /api2/json) on the active
// endpoint, over the pinned TLS connection, authenticated with this client's
// credentials. It asks for PVE's "binary" subprotocol.
func (c *Client) DialWebsocket(ctx context.Context, path string, q url.Values) (*WSConn, error) {
	c.mu.Lock()
	ep := c.endpoints[*c.active]
	c.mu.Unlock()
	hp := HostPort(ep.Host)
	raw, err := c.dialTLS(ctx, "tcp", hp)
	if err != nil {
		return nil, err
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = raw.SetDeadline(dl)
	} else {
		_ = raw.SetDeadline(time.Now().Add(30 * time.Second))
	}
	u := &url.URL{Scheme: "https", Host: hp, Path: "/api2/json" + path, RawQuery: q.Encode()}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		raw.Close()
		return nil, err
	}
	kb := make([]byte, 16)
	_, _ = rand.Read(kb)
	key := base64.StdEncoding.EncodeToString(kb)
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", key)
	req.Header.Set("Sec-WebSocket-Protocol", "binary")
	if c.auth != nil {
		c.auth.apply(req)
	}
	if err := req.Write(raw); err != nil {
		raw.Close()
		return nil, err
	}
	br := bufio.NewReader(raw)
	resp, err := http.ReadResponse(br, req)
	if err != nil {
		raw.Close()
		return nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		raw.Close()
		return nil, &APIError{Status: resp.StatusCode, Message: strings.TrimSpace(resp.Status + " " + string(b))}
	}
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	if resp.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(sum[:]) {
		raw.Close()
		return nil, errors.New("pve: bad websocket handshake")
	}
	_ = raw.SetDeadline(time.Time{}) // the caller bounds the session
	return &WSConn{conn: raw, br: br}, nil
}

const (
	opText  = 0x1
	opBin   = 0x2
	opClose = 0x8
	opPing  = 0x9
	opPong  = 0xA
)

func (w *WSConn) writeFrame(op byte, p []byte) error {
	w.wmu.Lock()
	defer w.wmu.Unlock()
	hdr := []byte{0x80 | op}
	switch n := len(p); {
	case n < 126:
		hdr = append(hdr, 0x80|byte(n))
	case n <= 0xFFFF:
		hdr = append(hdr, 0x80|126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 0x80|127)
		hdr = binary.BigEndian.AppendUint64(hdr, uint64(n))
	}
	mask := make([]byte, 4)
	_, _ = rand.Read(mask)
	hdr = append(hdr, mask...)
	buf := make([]byte, len(hdr)+len(p))
	copy(buf, hdr)
	for i, b := range p {
		buf[len(hdr)+i] = b ^ mask[i%4]
	}
	_, err := w.conn.Write(buf)
	return err
}

// WriteText sends one text message (PVE's termproxy reads text frames).
func (w *WSConn) WriteText(p []byte) error { return w.writeFrame(opText, p) }

// ReadMessage returns the next data message, answering pings on the way.
// io.EOF means the server closed the connection.
func (w *WSConn) ReadMessage() ([]byte, error) {
	var msg []byte
	for {
		h := make([]byte, 2)
		if _, err := io.ReadFull(w.br, h); err != nil {
			return nil, err
		}
		fin, op := h[0]&0x80 != 0, h[0]&0x0F
		masked := h[1]&0x80 != 0
		n := uint64(h[1] & 0x7F)
		switch n {
		case 126:
			b := make([]byte, 2)
			if _, err := io.ReadFull(w.br, b); err != nil {
				return nil, err
			}
			n = uint64(binary.BigEndian.Uint16(b))
		case 127:
			b := make([]byte, 8)
			if _, err := io.ReadFull(w.br, b); err != nil {
				return nil, err
			}
			n = binary.BigEndian.Uint64(b)
		}
		if n > MaxWSMessage || uint64(len(msg))+n > MaxWSMessage {
			return nil, fmt.Errorf("pve: websocket message too large")
		}
		var mask []byte
		if masked {
			mask = make([]byte, 4)
			if _, err := io.ReadFull(w.br, mask); err != nil {
				return nil, err
			}
		}
		p := make([]byte, n)
		if _, err := io.ReadFull(w.br, p); err != nil {
			return nil, err
		}
		if masked {
			for i := range p {
				p[i] ^= mask[i%4]
			}
		}
		switch op {
		case opPing:
			_ = w.writeFrame(opPong, p)
			continue
		case opPong:
			continue
		case opClose:
			_ = w.writeFrame(opClose, nil)
			return nil, io.EOF
		}
		msg = append(msg, p...)
		if fin {
			return msg, nil
		}
	}
}

// Close closes the connection.
func (w *WSConn) Close() error {
	_ = w.writeFrame(opClose, nil)
	return w.conn.Close()
}

// SetDeadline bounds reads and writes.
func (w *WSConn) SetDeadline(t time.Time) error { return w.conn.SetDeadline(t) }
