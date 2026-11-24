package hosts

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// TermConn is a websocket to PVE's termproxy (pve.WSConn).
type TermConn interface {
	WriteText(p []byte) error
	ReadMessage() ([]byte, error)
	Close() error
}

// Timeouts of a terminal session (variables so tests can shorten them).
var (
	// TermReadyTimeout bounds login and shell start-up.
	TermReadyTimeout = 30 * time.Second
	// TermQuiet is how long the terminal must be silent after login output
	// (motd, prompt) before galley starts typing.
	TermQuiet = 400 * time.Millisecond
	// TermPing is how often a keep-alive is sent while a command runs.
	TermPing = 30 * time.Second
)

// ErrNeedsRoot is returned when PVE's node terminal asks for a login, which is
// what it does for everyone except root@pam.
var ErrNeedsRoot = errors.New("PVE opened a login prompt instead of a shell: PVE gives a passwordless node shell only to root@pam. Log in to this cluster as root@pam to run host commands, or have a galley admin switch this cluster's host transport to SSH")

// a line ending in "login:" or "Password:" (not "Last login: <date>")
var loginPrompt = regexp.MustCompile(`(?m)(login|Password): *$`)

// termChunk is the length of one typed line of the encoded command. Terminals
// limit a line in canonical mode to 4095 bytes; stay far below.
const termChunk = 512

// RunTerm runs command through a PVE termproxy session already connected on
// ws: it authenticates with the termproxy ticket, waits for the shell, types
// the command (base64 encoded, so no character of it is interpreted by the
// terminal) wrapped in unique begin/end markers, and returns the output
// between the markers and the exit status. The command runs as
// `bash -c <command>` with stdin from /dev/null, like `ssh host <command>`,
// in a shell whose history is not saved. Output is capped at MaxOutput
// (carriage returns removed); the session ends when ctx does.
func RunTerm(ctx context.Context, ws TermConn, user, ticket, command string) (Result, error) {
	id := make([]byte, 8)
	_, _ = rand.Read(id)
	tag := "GLY" + strings.ToUpper(hex.EncodeToString(id))
	// Markers are typed split by '' so the terminal's echo of our input never
	// contains them; only the shell's output does.
	ready, begin, end := tag+"R", tag+"B\n", tag+"E "
	typed := func(m string) string { return "GLY''" + strings.TrimSpace(m)[3:] }

	done := make(chan struct{})
	msgs := make(chan []byte, 64)
	rerr := make(chan error, 1)
	go func() {
		defer close(msgs)
		for {
			m, err := ws.ReadMessage()
			if err != nil {
				rerr <- err
				return
			}
			select {
			case msgs <- m:
			case <-done:
				return
			}
		}
	}()
	stop := context.AfterFunc(ctx, func() {
		_ = ws.WriteText(frame("\x03")) // interrupt the command, then hang up
		_ = ws.Close()
	})
	defer func() {
		stop()
		close(done)
		_ = ws.Close()
	}()
	closed := func(msg string) error {
		var err error
		select {
		case err = <-rerr:
		default:
		}
		return termErr(ctx, err, msg)
	}

	send := func(line string) error { return ws.WriteText(frame(line + "\n")) }
	// 1. authenticate: "<user>:<ticket>\n" (raw, not framed); PVE answers "OK".
	if err := ws.WriteText([]byte(user + ":" + ticket + "\n")); err != nil {
		return Result{}, err
	}
	_ = ws.WriteText([]byte("1:500:50:")) // wide terminal: fewer wrapped lines

	// 2. let login finish (motd, prompt) before typing, so nothing is typed
	// into a login prompt; then start a quiet, history-free shell and wait for
	// the ready marker.
	var pre bytes.Buffer
	deadline := time.NewTimer(TermReadyTimeout)
	defer deadline.Stop()
	quiet := time.NewTimer(3 * time.Second) // no output at all: type anyway
	defer quiet.Stop()
	needsRoot := func() bool {
		return loginPrompt.Match(bytes.TrimRight(pre.Bytes(), " \r\n")) && !bytes.Contains(pre.Bytes(), []byte(ready))
	}
	settled := false
	for !bytes.Contains(pre.Bytes(), []byte(ready)) {
		select {
		case m, ok := <-msgs:
			if !ok {
				return Result{}, closed("the node terminal closed before the shell started")
			}
			if pre.Len() < 1<<20 {
				pre.Write(m)
			}
			if !settled {
				quiet.Reset(TermQuiet)
			}
		case <-quiet.C:
			// A prompt waits for input, so the terminal is quiet when one is
			// showing: judge only then, never on a partial line.
			if needsRoot() {
				return Result{}, ErrNeedsRoot
			}
			if !settled {
				settled = true
				if err := send(" unset HISTFILE; HISTSIZE=0; PS1=''; PS2=''; PROMPT_COMMAND=''; stty -echo -onlcr 2>/dev/null; echo " + typed(ready)); err != nil {
					return Result{}, err
				}
			}
		case <-deadline.C:
			if needsRoot() {
				return Result{}, ErrNeedsRoot
			}
			return Result{}, errors.New("the node terminal did not start a shell in time")
		case <-ctx.Done():
			return Result{}, ctx.Err()
		}
	}
	// Anything printed after the ready marker belongs to what follows.
	after := pre.Bytes()[bytes.Index(pre.Bytes(), []byte(ready))+len(ready):]

	// 3. the command, in short lines, then the run line.
	enc := base64.StdEncoding.EncodeToString([]byte(command))
	if err := send("G=''"); err != nil {
		return Result{}, err
	}
	for i := 0; i < len(enc); i += termChunk {
		if err := send(`G="$G"'` + enc[i:min(i+termChunk, len(enc))] + `'`); err != nil {
			return Result{}, err
		}
	}
	if err := send("echo " + typed(begin) + `; bash -c "$(printf %s "$G" | base64 -d)" </dev/null 2>&1; echo ` + typed(end) + ` $?; exit`); err != nil {
		return Result{}, err
	}

	// 4. collect the output between the markers.
	out := &capped{}
	var pending []byte
	started := false
	feed := func(p []byte) (bool, int) {
		pending = append(pending, bytes.ReplaceAll(p, []byte("\r"), nil)...)
		if !started {
			i := bytes.Index(pending, []byte(begin))
			if i < 0 {
				if len(pending) > 1<<20 { // bounded while waiting for the marker
					pending = pending[len(pending)-len(begin):]
				}
				return false, 0
			}
			started = true
			pending = pending[i+len(begin):]
		}
		if i := bytes.Index(pending, []byte(end)); i >= 0 {
			out.Write(pending[:i])
			pending = pending[i:]
			rest := pending[len(end):]
			nl := bytes.IndexByte(rest, '\n')
			if nl < 0 {
				return false, 0
			}
			code, err := strconv.Atoi(strings.TrimSpace(string(rest[:nl])))
			if err != nil {
				code = -1
			}
			return true, code
		}
		// keep a tail that could be the start of the end marker
		if keep := len(end) - 1; len(pending) > keep {
			out.Write(pending[:len(pending)-keep])
			pending = pending[len(pending)-keep:]
		}
		return false, 0
	}
	if ok, code := feed(after); ok {
		return Result{Output: out.String(), Exit: code}, nil
	}
	ping := time.NewTicker(TermPing)
	defer ping.Stop()
	for {
		select {
		case m, ok := <-msgs:
			if !ok {
				return Result{Output: out.String(), Exit: -1}, closed("the node terminal closed before the command finished")
			}
			if ok, code := feed(m); ok {
				return Result{Output: out.String(), Exit: code}, nil
			}
		case <-ping.C:
			_ = ws.WriteText([]byte("2"))
		case <-ctx.Done():
			return Result{Output: out.String(), Exit: -1}, ctx.Err()
		}
	}
}

// frame encodes terminal input in termproxy's "0:<len>:<data>" framing.
func frame(s string) []byte { return []byte(fmt.Sprintf("0:%d:%s", len(s), s)) }

func termErr(ctx context.Context, err error, msg string) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err == nil || errors.Is(err, io.EOF) {
		return errors.New(msg)
	}
	return fmt.Errorf("%s: %w", msg, err)
}
