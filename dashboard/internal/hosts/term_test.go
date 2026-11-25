package hosts

import (
	"context"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JongoDB/pve-cookbook/dashboard/internal/fakepve"
)

// termPipe connects RunTerm to a scripted fakepve.TermShell in memory,
// speaking termproxy's protocol (auth line, "0:<len>:<data>" frames).
type termPipe struct {
	sh     *fakepve.TermShell
	user   string
	ticket string
	in     chan []byte
	out    chan []byte
	once   sync.Once
	done   chan struct{}
}

func newPipe(sh *fakepve.TermShell, user, ticket string) *termPipe {
	p := &termPipe{sh: sh, user: user, ticket: ticket, in: make(chan []byte, 256), out: make(chan []byte, 4096), done: make(chan struct{})}
	go p.serve()
	return p
}

func (p *termPipe) emit(s string) {
	for len(s) > 0 { // tiny messages: markers arrive split
		n := min(len(s), 3)
		select {
		case p.out <- []byte(s[:n]):
		case <-p.done:
			return
		}
		s = s[n:]
	}
}

func (p *termPipe) serve() {
	defer close(p.out)
	first := true
	for {
		var m []byte
		select {
		case m = <-p.in:
		case <-p.done:
			return
		}
		s := string(m)
		if first {
			first = false
			if s != p.user+":"+p.ticket+"\n" {
				return
			}
			p.emit("OK")
			p.emit(p.sh.Start())
			continue
		}
		if !strings.HasPrefix(s, "0:") {
			continue
		}
		parts := strings.SplitN(s, ":", 3)
		if n, _ := strconv.Atoi(parts[1]); n != len(parts[2]) {
			return
		}
		o, exit := p.sh.Input(parts[2])
		p.emit(o)
		if exit {
			return
		}
	}
}

func (p *termPipe) WriteText(b []byte) error {
	select {
	case p.in <- append([]byte(nil), b...):
		return nil
	case <-p.done:
		return io.ErrClosedPipe
	}
}

func (p *termPipe) ReadMessage() ([]byte, error) {
	m, ok := <-p.out
	if !ok {
		return nil, io.EOF
	}
	return m, nil
}

func (p *termPipe) Close() error { p.once.Do(func() { close(p.done) }); return nil }

func init() { TermQuiet = 30 * time.Millisecond }

func TestRunTermOutputAndExit(t *testing.T) {
	var ran []string
	sh := &fakepve.TermShell{Node: "pve1", Root: true, Run: func(cmd string) (string, int) {
		ran = append(ran, cmd)
		if cmd == "false" {
			return "nope\n", 1
		}
		return "a\nb\r\nGLY not a marker\n" + cmd, 0
	}}
	cmd := "printf '%s' \"x\"; echo $HOME\n" + strings.Repeat("z", 3000)
	res, err := RunTerm(context.Background(), newPipe(sh, "root@pam", "PVETERM:1"), "root@pam", "PVETERM:1", cmd)
	if err != nil || res.Exit != 0 || res.Output != "a\nb\nGLY not a marker\n"+cmd {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if len(ran) != 1 || ran[0] != cmd {
		t.Fatalf("ran %q", ran)
	}
	sh2 := &fakepve.TermShell{Node: "pve1", Root: true, Run: sh.Run}
	res, err = RunTerm(context.Background(), newPipe(sh2, "root@pam", "t"), "root@pam", "t", "false")
	if err != nil || res.Exit != 1 || res.Output != "nope\n" {
		t.Fatalf("false: %+v %v", res, err)
	}
}

func TestRunTermRefusesLoginPrompt(t *testing.T) {
	called := false
	sh := &fakepve.TermShell{Node: "pve1", Root: false, Run: func(string) (string, int) { called = true; return "", 0 }}
	_, err := RunTerm(context.Background(), newPipe(sh, "ops@pam", "t"), "ops@pam", "t", "id")
	if !errors.Is(err, ErrNeedsRoot) || called {
		t.Fatalf("err=%v called=%v", err, called)
	}
}

func TestRunTermBadTicketAndTimeout(t *testing.T) {
	sh := &fakepve.TermShell{Node: "pve1", Root: true}
	if _, err := RunTerm(context.Background(), newPipe(sh, "root@pam", "right"), "root@pam", "wrong", "id"); err == nil {
		t.Fatal("bad ticket accepted")
	}
	block := make(chan struct{})
	defer close(block)
	sh = &fakepve.TermShell{Node: "pve1", Root: true, Run: func(string) (string, int) { <-block; return "", 0 }}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := RunTerm(ctx, newPipe(sh, "root@pam", "t"), "root@pam", "t", "sleep 1000")
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 5*time.Second {
		t.Fatalf("timeout: %v after %s", err, time.Since(start))
	}
}
