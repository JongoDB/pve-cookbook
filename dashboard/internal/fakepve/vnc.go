package fakepve

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net/http"
)

// vncServer serves a VM console websocket like PVE's vncwebsocket: the
// "binary" subprotocol carrying RFB 3.8 with VNC authentication. It accepts
// any password, announces a 640x400 screen and then ignores client messages
// (no framebuffer updates), which is enough for noVNC to connect.
func (f *Server) vncServer(w http.ResponseWriter, r *http.Request) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		write(w, 500, nil)
		return
	}
	h := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	conn, rw, err := hj.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: binary\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(h[:]))
	_ = rw.Flush()
	in := &wsStream{r: rw.Reader}
	send := func(p []byte) bool { return wsWrite(rw.Writer, p) == nil && rw.Flush() == nil }

	if !send([]byte("RFB 003.008\n")) {
		return
	}
	if _, err := in.read(12); err != nil { // client version
		return
	}
	if !send([]byte{1, 2}) { // one security type: VNC authentication
		return
	}
	if _, err := in.read(1); err != nil {
		return
	}
	challenge := make([]byte, 16)
	_, _ = rand.Read(challenge)
	if !send(challenge) {
		return
	}
	if _, err := in.read(16); err != nil { // the encrypted password: not checked
		return
	}
	if !send([]byte{0, 0, 0, 0}) { // SecurityResult OK
		return
	}
	if _, err := in.read(1); err != nil { // ClientInit
		return
	}
	name := "fakepve VM"
	init := binary.BigEndian.AppendUint16(nil, 640)
	init = binary.BigEndian.AppendUint16(init, 400)
	// pixel format: 32 bpp, depth 24, little endian, true colour, 8 bits per channel
	init = append(init, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0)
	init = binary.BigEndian.AppendUint32(init, uint32(len(name)))
	init = append(init, name...)
	if !send(init) {
		return
	}
	for { // SetPixelFormat, SetEncodings, update requests, key and pointer events
		if _, err := wsRead(rw.Reader); err != nil {
			return
		}
	}
}

// wsStream reads a byte stream carried in websocket messages.
type wsStream struct {
	r   *bufio.Reader
	buf []byte
}

func (s *wsStream) read(n int) ([]byte, error) {
	for len(s.buf) < n {
		m, err := wsRead(s.r)
		if err != nil {
			return nil, err
		}
		s.buf = append(s.buf, m...)
	}
	p := s.buf[:n]
	s.buf = s.buf[n:]
	return p, nil
}
