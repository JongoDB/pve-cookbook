// Package schema loads Proxmox VE's own API schema (the api-viewer's
// apidoc.js, served by every PVE node) and uses it to describe, validate and
// render any API call. Because the schema comes from the cluster itself, it
// always matches that cluster's PVE version, and galley can offer create,
// read, update and delete for everything the PVE API exposes.
package schema

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Param describes one parameter (JSON-schema subset used by PVE).
type Param struct {
	Type        string            `json:"type,omitempty"`
	Description string            `json:"description,omitempty"`
	Optional    Int               `json:"optional,omitempty"`
	Default     any               `json:"default,omitempty"`
	Enum        []string          `json:"enum,omitempty"`
	Minimum     *Float            `json:"minimum,omitempty"`
	Maximum     *Float            `json:"maximum,omitempty"`
	MaxLength   Int               `json:"maxLength,omitempty"`
	Pattern     string            `json:"pattern,omitempty"`
	Format      any               `json:"format,omitempty"`
	TypeText    string            `json:"typetext,omitempty"`
	Renderer    string            `json:"renderer,omitempty"`
	Items       *Param            `json:"items,omitempty"`
	Properties  map[string]*Param `json:"properties,omitempty"`
	VerboseDesc string            `json:"verbose_description,omitempty"`
}

// Method is one HTTP method on a path.
type Method struct {
	Method      string         `json:"method"`
	Name        string         `json:"name,omitempty"`
	Description string         `json:"description,omitempty"`
	Protected   Int            `json:"protected,omitempty"`
	Proxyto     string         `json:"proxyto,omitempty"`
	Permissions map[string]any `json:"permissions,omitempty"`
	Parameters  *Param         `json:"parameters,omitempty"`
	Returns     *Param         `json:"returns,omitempty"`
}

// Int and Float accept JSON numbers, numeric strings ("1") and booleans:
// PVE's apidoc writes some numeric fields as strings (e.g. "optional": "1",
// "minimum": "0"), and one strict field would make the whole schema unusable.
type Int int

func (i *Int) UnmarshalJSON(b []byte) error {
	f, err := flexNumber(b)
	*i = Int(f)
	return err
}

type Float float64

func (f *Float) UnmarshalJSON(b []byte) error {
	v, err := flexNumber(b)
	*f = Float(v)
	return err
}

func flexNumber(b []byte) (float64, error) {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return 0, err
	}
	switch t := v.(type) {
	case float64:
		return t, nil
	case bool:
		if t {
			return 1, nil
		}
		return 0, nil
	case string:
		if t == "" {
			return 0, nil
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0, nil // not a number: treat as unset rather than reject the schema
		}
		return f, nil
	}
	return 0, nil
}

// Node is one path in the API tree.
type Node struct {
	Path     string             `json:"path"`
	Text     string             `json:"text"`
	Leaf     int                `json:"leaf"`
	Info     map[string]*Method `json:"info"`
	Children []*Node            `json:"children,omitempty"`
}

// Schema is a parsed API tree with a flat index.
type Schema struct {
	Version string
	Roots   []*Node
	index   []*indexed
}

type indexed struct {
	node *Node
	segs []string
}

// Parse reads apidoc.js ("const apiSchema = [...];") or a bare JSON array.
func Parse(b []byte) (*Schema, error) {
	if i := bytes.Index(b, []byte("apiSchema")); i >= 0 {
		j := bytes.IndexByte(b[i:], '[')
		if j < 0 {
			return nil, errors.New("schema: no array after apiSchema")
		}
		b = b[i+j:]
	}
	dec := json.NewDecoder(bytes.NewReader(b)) // decodes the first JSON value and ignores the rest of the script
	var roots []*Node
	if err := dec.Decode(&roots); err != nil {
		return nil, fmt.Errorf("schema: %w", err)
	}
	s := &Schema{Roots: roots}
	var walk func(n *Node)
	walk = func(n *Node) {
		s.index = append(s.index, &indexed{node: n, segs: strings.Split(strings.Trim(n.Path, "/"), "/")})
		for _, c := range n.Children {
			walk(c)
		}
	}
	for _, r := range roots {
		walk(r)
	}
	if len(s.index) == 0 {
		return nil, errors.New("schema: empty")
	}
	return s, nil
}

// Paths is a compact listing for search: every path with its methods.
type PathInfo struct {
	Path    string            `json:"path"`
	Text    string            `json:"text"`
	Methods map[string]string `json:"methods"` // method -> description (first line)
}

// Paths lists every path (templated, e.g. /nodes/{node}/qemu/{vmid}/config).
func (s *Schema) Paths() []PathInfo {
	out := make([]PathInfo, 0, len(s.index))
	for _, ix := range s.index {
		pi := PathInfo{Path: ix.node.Path, Text: ix.node.Text, Methods: map[string]string{}}
		for m, info := range ix.node.Info {
			d, _, _ := strings.Cut(info.Description, "\n")
			pi.Methods[m] = d
		}
		out = append(out, pi)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// Match finds the schema node for a concrete path and returns the values of
// its template segments ({node} → "pve1").
func (s *Schema) Match(path string) (*Node, map[string]string, error) {
	segs := strings.Split(strings.Trim(path, "/"), "/")
	var best *indexed
	var bestVars map[string]string
	bestLiterals := -1
	for _, ix := range s.index {
		if len(ix.segs) != len(segs) {
			continue
		}
		vars := map[string]string{}
		lit, ok := 0, true
		for i, sg := range ix.segs {
			if strings.HasPrefix(sg, "{") && strings.HasSuffix(sg, "}") {
				if segs[i] == "" {
					ok = false
					break
				}
				vars[strings.Trim(sg, "{}")] = segs[i]
				continue
			}
			if sg != segs[i] {
				ok = false
				break
			}
			lit++
		}
		if ok && lit > bestLiterals { // prefer literal matches over templates
			best, bestVars, bestLiterals = ix, vars, lit
		}
	}
	if best == nil {
		return nil, nil, fmt.Errorf("no such API path %s", path)
	}
	return best.node, bestVars, nil
}

// Errors from validation.
var (
	ErrNoMethod = errors.New("method not allowed on this path")
	ErrInvalid  = errors.New("invalid parameters")
)

var indexedKey = regexp.MustCompile(`^([a-z_-]+?)(\d+)$`)

// property finds the schema for a body key, handling indexed families such
// as net0…netN, documented by PVE as "net[n]".
func property(props map[string]*Param, key string) *Param {
	if p := props[key]; p != nil {
		return p
	}
	if m := indexedKey.FindStringSubmatch(key); m != nil {
		if p := props[m[1]+"[n]"]; p != nil {
			return p
		}
	}
	return nil
}

// Validate checks a call against the schema: the method exists, every body
// key is a known parameter (path parameters excluded), values have the right
// type and range, and required parameters are present.
func (s *Schema) Validate(method, path string, body map[string]string) (*Method, error) {
	n, vars, err := s.Match(path)
	if err != nil {
		return nil, err
	}
	m := n.Info[strings.ToUpper(method)]
	if m == nil {
		return nil, fmt.Errorf("%w: %s %s", ErrNoMethod, method, n.Path)
	}
	props := map[string]*Param{}
	if m.Parameters != nil && m.Parameters.Properties != nil {
		props = m.Parameters.Properties
	}
	var problems []string
	for k, v := range vars {
		if p := props[k]; p != nil {
			if msg := checkValue(p, v); msg != "" {
				problems = append(problems, k+": "+msg)
			}
		}
	}
	for k, v := range body {
		if _, isPathVar := vars[k]; isPathVar {
			problems = append(problems, k+": set in the path, not the body")
			continue
		}
		p := property(props, k)
		if p == nil {
			problems = append(problems, k+": not a parameter of "+strings.ToUpper(method)+" "+n.Path)
			continue
		}
		if msg := checkValue(p, v); msg != "" {
			problems = append(problems, k+": "+msg)
		}
	}
	for k, p := range props {
		if p.Optional == 1 || strings.HasSuffix(k, "[n]") {
			continue
		}
		if _, ok := vars[k]; ok {
			continue
		}
		if _, ok := body[k]; !ok {
			problems = append(problems, k+": required")
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return m, fmt.Errorf("%w: %s", ErrInvalid, strings.Join(problems, "; "))
	}
	return m, nil
}

func checkValue(p *Param, v string) string {
	switch p.Type {
	case "integer":
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return "must be an integer"
		}
		if p.Minimum != nil && float64(n) < float64(*p.Minimum) {
			return fmt.Sprintf("must be at least %v", *p.Minimum)
		}
		if p.Maximum != nil && float64(n) > float64(*p.Maximum) {
			return fmt.Sprintf("must be at most %v", *p.Maximum)
		}
	case "number":
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return "must be a number"
		}
		if p.Minimum != nil && f < float64(*p.Minimum) {
			return fmt.Sprintf("must be at least %v", *p.Minimum)
		}
		if p.Maximum != nil && f > float64(*p.Maximum) {
			return fmt.Sprintf("must be at most %v", *p.Maximum)
		}
	case "boolean":
		switch strings.ToLower(v) {
		case "0", "1", "true", "false", "yes", "no", "on", "off":
		default:
			return "must be 0 or 1"
		}
	}
	if len(p.Enum) > 0 {
		ok := false
		for _, e := range p.Enum {
			if e == v {
				ok = true
				break
			}
		}
		if !ok {
			return "must be one of " + strings.Join(p.Enum, ", ")
		}
	}
	if p.MaxLength > 0 && len(v) > int(p.MaxLength) {
		return fmt.Sprintf("longer than %d characters", p.MaxLength)
	}
	if p.Pattern != "" {
		// PVE patterns are Perl regexes; check only those RE2 understands.
		if re := compiled(p.Pattern); re != nil && !re.MatchString(v) {
			return "does not match the expected format"
		}
	}
	if strings.ContainsAny(v, "\x00\n\r") && p.Type != "string" {
		return "contains control characters"
	}
	return ""
}

var patterns sync.Map // pattern -> *regexp.Regexp (nil if not RE2-compatible)

func compiled(p string) *regexp.Regexp {
	if v, ok := patterns.Load(p); ok {
		re, _ := v.(*regexp.Regexp)
		return re
	}
	re, err := regexp.Compile("^(?:" + p + ")$")
	if err != nil {
		re = nil
	}
	patterns.Store(p, re)
	return re
}

// CLI renders the equivalent pvesh command for a call.
func CLI(method, path string, body map[string]string) string {
	verb := map[string]string{"GET": "get", "POST": "create", "PUT": "set", "DELETE": "delete"}[strings.ToUpper(method)]
	var b strings.Builder
	b.WriteString("pvesh ")
	b.WriteString(verb)
	b.WriteString(" ")
	b.WriteString(path)
	keys := make([]string, 0, len(body))
	for k := range body {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		b.WriteString(" --")
		b.WriteString(k)
		b.WriteString(" ")
		if Sensitive(k) {
			b.WriteString("'<redacted>'")
			continue
		}
		b.WriteString(Quote(body[k]))
	}
	return b.String()
}

var sensitiveKey = regexp.MustCompile(`(?i)(pass(word)?|secret|token|privkey|private-?key|api-?key|psk)$|^(value|key|keyring)$`)

// Sensitive reports whether a parameter carries a secret (passwords, tokens,
// keys); such values are kept out of CLI text and the audit log.
func Sensitive(key string) bool { return sensitiveKey.MatchString(key) }

var safeArg = regexp.MustCompile(`^[A-Za-z0-9_./:=,@%+-]+$`)

// Quote shell-quotes a value when needed.
func Quote(v string) string {
	if v != "" && safeArg.MatchString(v) {
		return v
	}
	return "'" + strings.ReplaceAll(v, "'", `'\''`) + "'"
}
