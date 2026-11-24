package fakepve

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// TermShell imitates a node's shell behind PVE's termproxy closely enough to
// exercise galley's host-command driver: a login banner and coloured prompt,
// terminal echo until `stty -echo`, CRLF output until `stty -onlcr`, and a few
// shell statements (echo, variable concatenation, bash -c of a base64 payload,
// exit). Like PVE, only root@pam gets a shell; everyone else gets "login:".
type TermShell struct {
	Node string
	Root bool
	// Run executes a decoded command (default: "ran: <cmd>", exit 3 for "false").
	Run func(cmd string) (string, int)

	echo, crlf bool
	prompt     string
	g          string
	last       int
	line       strings.Builder
	login      bool
}

// Start returns what the terminal shows after authentication.
func (t *TermShell) Start() string {
	t.echo, t.crlf = true, true
	if !t.Root {
		t.login = true
		return "\r\n" + t.Node + " login: "
	}
	t.prompt = "\x1b[01;32mroot@" + t.Node + "\x1b[00m:\x1b[01;34m~\x1b[00m# "
	return "Linux " + t.Node + " 7.0.14-30-pve #1 SMP PREEMPT_DYNAMIC x86_64\r\n\r\nLast login: Tue Nov 24 09:12:44 2026 from 192.0.2.50\r\n" + t.prompt
}

var (
	echoMarker = regexp.MustCompile(`^echo ([A-Z]+)''([A-Z0-9]+)( \$\?)?$`)
	gAppend    = regexp.MustCompile(`^G="\$G"'([A-Za-z0-9+/=]*)'$`)
)

// Input feeds typed characters; it returns the terminal output and whether
// the shell exited.
func (t *TermShell) Input(p string) (string, bool) {
	var out strings.Builder
	for _, r := range p {
		if t.echo {
			if r == '\n' {
				out.WriteString("\r\n")
			} else {
				out.WriteRune(r)
			}
		}
		if r != '\n' && r != '\r' {
			t.line.WriteRune(r)
			continue
		}
		line := t.line.String()
		t.line.Reset()
		if t.login {
			out.WriteString("\r\nPassword: ")
			continue
		}
		o, exit := t.exec(line)
		if !t.crlf {
			out.WriteString(o)
		} else {
			out.WriteString(strings.ReplaceAll(o, "\n", "\r\n"))
		}
		if exit {
			return out.String(), true
		}
		out.WriteString(t.prompt)
	}
	return out.String(), false
}

func (t *TermShell) exec(line string) (string, bool) {
	var out strings.Builder
	for _, st := range strings.Split(strings.TrimSpace(line), "; ") {
		st = strings.TrimSpace(st)
		switch {
		case st == "" || st == "unset HISTFILE" || st == "HISTSIZE=0" || st == "PS2=''" || st == "PROMPT_COMMAND=''":
		case st == "PS1=''":
			t.prompt = ""
		case strings.HasPrefix(st, "stty "):
			if strings.Contains(st, "-echo") {
				t.echo = false
			}
			if strings.Contains(st, "-onlcr") {
				t.crlf = false
			}
		case st == "G=''":
			t.g = ""
		case gAppend.MatchString(st):
			t.g += gAppend.FindStringSubmatch(st)[1]
		case echoMarker.MatchString(st):
			m := echoMarker.FindStringSubmatch(st)
			out.WriteString(m[1] + m[2])
			if m[3] != "" {
				out.WriteString(" " + strconv.Itoa(t.last))
			}
			out.WriteString("\n")
		case st == `bash -c "$(printf %s "$G" | base64 -d)" </dev/null 2>&1`:
			cmd, err := base64.StdEncoding.DecodeString(t.g)
			if err != nil {
				out.WriteString("base64: invalid input\n")
				t.last = 1
				continue
			}
			run := t.Run
			if run == nil {
				run = defaultRun
			}
			o, code := run(string(cmd))
			out.WriteString(o)
			t.last = code
		case st == "exit":
			return out.String(), true
		default:
			out.WriteString("-bash: " + st + ": command not found\n")
			t.last = 127
		}
	}
	return out.String(), false
}

func defaultRun(cmd string) (string, int) {
	if cmd == "false" {
		return "ran: false\n", 3
	}
	return "ran: " + cmd + "\n", 0
}

// HostCommands returns the commands run through node terminals.
func (f *Server) HostCommands() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.hostCmds...)
}

// termSocket serves /nodes/{node}/vncwebsocket for a termproxy ticket: a real
// websocket (RFC 6455 framing) speaking PVE's termproxy protocol.
func (f *Server) termSocket(w http.ResponseWriter, r *http.Request, node, authUser string) {
	ticket := r.URL.Query().Get("vncticket")
	f.mu.Lock()
	tt, ok := f.termTickets[ticket]
	f.mu.Unlock()
	if !ok || tt.node != node || tt.user != authUser {
		write(w, 401, nil)
		return
	}
	hj, okh := w.(http.Hijacker)
	if !okh {
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
	send := func(s string) {
		// small frames, so markers arrive split across messages
		for len(s) > 0 {
			n := min(len(s), 7)
			_ = wsWrite(rw.Writer, []byte(s[:n]))
			s = s[n:]
		}
		_ = rw.Flush()
	}
	first, err := wsRead(rw.Reader)
	if err != nil {
		return
	}
	if string(first) != tt.user+":"+ticket+"\n" {
		return // PVE closes the connection on a bad ticket
	}
	f.mu.Lock()
	delete(f.termTickets, ticket) // single use
	run := f.HostRun
	f.mu.Unlock()
	sh := &TermShell{Node: node, Root: tt.user == "root@pam", Run: func(cmd string) (string, int) {
		f.mu.Lock()
		f.hostCmds = append(f.hostCmds, node+": "+cmd)
		f.mu.Unlock()
		if run != nil {
			return run(cmd)
		}
		return defaultRun(cmd)
	}}
	send("OK")
	send(sh.Start())
	for {
		m, err := wsRead(rw.Reader)
		if err != nil {
			return
		}
		s := string(m)
		if !strings.HasPrefix(s, "0:") {
			continue // resize "1:…", ping "2"
		}
		parts := strings.SplitN(s, ":", 3)
		n, err := strconv.Atoi(parts[1])
		if len(parts) < 3 || err != nil || n != len(parts[2]) {
			return
		}
		out, exit := sh.Input(parts[2])
		send(out)
		if exit {
			_ = wsWriteOp(rw.Writer, 0x8, nil)
			_ = rw.Flush()
			return
		}
	}
}

func wsWrite(w *bufio.Writer, p []byte) error { return wsWriteOp(w, 0x2, p) }

func wsWriteOp(w *bufio.Writer, op byte, p []byte) error {
	hdr := []byte{0x80 | op}
	switch n := len(p); {
	case n < 126:
		hdr = append(hdr, byte(n))
	case n <= 0xFFFF:
		hdr = append(hdr, 126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 127)
		hdr = binary.BigEndian.AppendUint64(hdr, uint64(n))
	}
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	_, err := w.Write(p)
	return err
}

// wsRead reads one (masked, client) message.
func wsRead(r *bufio.Reader) ([]byte, error) {
	var msg []byte
	for {
		h := make([]byte, 2)
		if _, err := io.ReadFull(r, h); err != nil {
			return nil, err
		}
		fin, op := h[0]&0x80 != 0, h[0]&0x0F
		n := uint64(h[1] & 0x7F)
		if n == 126 {
			b := make([]byte, 2)
			if _, err := io.ReadFull(r, b); err != nil {
				return nil, err
			}
			n = uint64(binary.BigEndian.Uint16(b))
		} else if n == 127 {
			b := make([]byte, 8)
			if _, err := io.ReadFull(r, b); err != nil {
				return nil, err
			}
			n = binary.BigEndian.Uint64(b)
		}
		if n > 1<<20 || h[1]&0x80 == 0 {
			return nil, fmt.Errorf("bad frame")
		}
		mask := make([]byte, 4)
		if _, err := io.ReadFull(r, mask); err != nil {
			return nil, err
		}
		p := make([]byte, n)
		if _, err := io.ReadFull(r, p); err != nil {
			return nil, err
		}
		for i := range p {
			p[i] ^= mask[i%4]
		}
		if op == 0x8 {
			return nil, io.EOF
		}
		if op == 0x9 || op == 0xA {
			continue
		}
		msg = append(msg, p...)
		if fin {
			return msg, nil
		}
	}
}
