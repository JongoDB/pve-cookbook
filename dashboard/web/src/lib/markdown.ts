// A deliberately small Markdown subset for assistant answers and the help pages: paragraphs,
// headings, bullet and numbered lists, fenced code blocks, simple pipe tables, blockquotes,
// inline code, bold and links. It produces a plain data tree; components/Markdown.tsx turns it
// into React elements, so text is never parsed as HTML (no dangerouslySetInnerHTML anywhere).
//
// Links never carry a raw href to the DOM. resolveHref() classifies every target: app routes
// (a same-origin path starting with one "/"), "#anchors" and help-doc files ("x.md#y") become
// SPA links; http(s) URLs are shown as text with the URL beside it; anything else is plain text.

export type LinkTarget =
  | { kind: 'route'; to: string }
  | { kind: 'anchor'; id: string }
  | { kind: 'external'; url: string }
  | { kind: 'none' };

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; c: Inline[] }
  | { t: 'link'; c: Inline[]; target: LinkTarget };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[]; id: string }
  | { t: 'list'; ordered: boolean; start: number; items: Inline[][]; /** nested blocks (sub-lists) by item index */ nested?: Record<number, Block[]> }
  | { t: 'code'; lang: string; v: string; open: boolean }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'quote'; c: Block[] };

const ANCHOR_ID = /^[A-Za-z0-9_-]{1,120}$/;
const DOC_FILE = /^(?:\.\/)?([a-z0-9][a-z0-9_-]{0,63})\.md(?:#([A-Za-z0-9_-]{1,120}))?$/i;
// path characters an app route may use (no backslash, quotes, angle brackets, whitespace or controls)
const ROUTE = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*(?:\?[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*)?(?:#[A-Za-z0-9_-]*)?$/;

/** Classify a Markdown link target. Only same-origin app paths, anchors and help docs navigate. */
export function resolveHref(raw: string): LinkTarget {
  const href = raw.trim();
  if (!href || href.length > 2000) return { kind: 'none' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s\\]/.test(href)) return { kind: 'none' };
  if (href.startsWith('#')) {
    const id = href.slice(1);
    return ANCHOR_ID.test(id) ? { kind: 'anchor', id } : { kind: 'none' };
  }
  const doc = DOC_FILE.exec(href);
  if (doc) return { kind: 'route', to: `/help/${doc[1].toLowerCase()}${doc[2] ? `#${doc[2]}` : ''}` };
  if (/^https?:\/\//i.test(href)) {
    try {
      const u = new URL(href);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) return { kind: 'external', url: u.href };
    } catch { /* not a URL */ }
    return { kind: 'none' };
  }
  if (!ROUTE.test(href)) return { kind: 'none' };
  // Decode to catch encoded tricks (/%2F%2Fevil, /%5Cevil, %00) before trusting the path.
  let decoded: string;
  try { decoded = decodeURIComponent(href); } catch { return { kind: 'none' }; }
  // eslint-disable-next-line no-control-regex
  if (/^\/[/\\]|[\u0000-\u001f\u007f\\]/.test(decoded)) return { kind: 'none' };
  if (decoded.split(/[?#]/)[0].split('/').some((s) => s === '..' || s === '.')) return { kind: 'none' };
  if (/^\/api(\/|$)/i.test(decoded)) return { kind: 'none' };
  return { kind: 'route', to: href };
}

/** GitHub-style heading slug: lower case, punctuation dropped, spaces to hyphens. */
export function slugify(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

export const inlineText = (nodes: Inline[]): string =>
  nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : inlineText(n.c))).join('');

/** Index of the "]" closing the "[" at `open`, allowing nested brackets; -1 if none. */
function closingBracket(s: string, open: number): number {
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === '`') { const e = s.indexOf('`', k + 1); if (e > k) { k = e; continue; } }
    if (s[k] === '[') depth++;
    else if (s[k] === ']' && --depth === 0) return k;
  }
  return -1;
}

/** Inline spans: `code` first (its content is literal), then [links](href) and **bold**. Unclosed markers stay text. */
export function parseInline(s: string, allowBold = true, allowLinks = true): Inline[] {
  const out: Inline[] = [];
  const text = (v: string) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last?.t === 'text') last.v += v; else out.push({ t: 'text', v });
  };
  const isMarker = (j: number) => s[j] === '`' || (allowBold && s.startsWith('**', j)) || (allowLinks && s[j] === '[');
  let i = 0;
  while (i < s.length) {
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) { out.push({ t: 'code', v: s.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if (allowLinks && s[i] === '[') {
      const close = closingBracket(s, i);
      if (close > i + 1 && s[close + 1] === '(') {
        // the target ends at the ")" that balances its "(" (URLs may contain parentheses)
        let end = -1;
        for (let k = close + 2, depth = 1; k < s.length && s[k] !== '\n'; k++) {
          if (s[k] === '(') depth++;
          else if (s[k] === ')' && --depth === 0) { end = k; break; }
        }
        if (end > close + 1) {
          // an optional "title" after the target is ignored
          const target = s.slice(close + 2, end).trim().replace(/\s+"[^"]*"$/, '');
          out.push({ t: 'link', c: parseInline(s.slice(i + 1, close), allowBold, false), target: resolveHref(target) });
          i = end + 1;
          continue;
        }
      }
    }
    if (allowBold && s.startsWith('**', i)) {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) { out.push({ t: 'bold', c: parseInline(s.slice(i + 2, end), false, allowLinks) }); i = end + 2; continue; }
    }
    // plain run up to the next marker
    let j = i + 1;
    while (j < s.length && !isMarker(j)) j++;
    text(s.slice(i, j));
    i = j;
  }
  return out;
}

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Cells of a pipe-table row; "\|" stays a literal pipe. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const isTableStart = (lines: string[], i: number) =>
  lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')
  && cells(lines[i]).length === cells(lines[i + 1]).length;

/** Parse Markdown into blocks. Heading ids are unique within one call (later duplicates get -1, -2...). */
export function parseMarkdown(src: string, seen: Map<string, number> = new Map()): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; start: number; items: string[]; nested: Record<number, string[]> } | null = null;

  const flushPara = () => { if (para.length) { blocks.push({ t: 'p', c: parseInline(para.join('\n')) }); para = []; } };
  const flushList = () => {
    if (!list) return;
    const l = list;
    const nested: Record<number, Block[]> = {};
    for (const [k, raw] of Object.entries(l.nested)) {
      const indent = Math.min(...raw.filter((x) => x.trim()).map((x) => /^\s*/.exec(x)![0].length));
      nested[Number(k)] = parseMarkdown(raw.map((x) => x.slice(indent)).join('\n'), seen);
    }
    blocks.push({ t: 'list', ordered: l.ordered, start: l.start, items: l.items.map((x) => parseInline(x)), ...(Object.keys(nested).length ? { nested } : {}) });
    list = null;
  };
  const uniqueId = (text: string) => {
    const base = slugify(text) || 'section';
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flushPara(); flushList();
      const marker = fence[1];
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !(lines[j].trim().startsWith(marker[0].repeat(marker.length)) && lines[j].trim().replace(/[`~]/g, '') === '')) body.push(lines[j++]);
      // while streaming, the closing fence may not have arrived yet
      blocks.push({ t: 'code', lang: fence[2], v: body.join('\n'), open: j >= lines.length });
      i = j;
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const h = HEADING.exec(line);
    if (h) {
      flushPara(); flushList();
      const c = parseInline(h[2]);
      blocks.push({ t: 'h', level: h[1].length, c, id: uniqueId(inlineText(c)) });
      continue;
    }
    if (QUOTE.test(line)) {
      flushPara(); flushList();
      const body: string[] = [];
      let j = i;
      while (j < lines.length && QUOTE.test(lines[j])) { body.push(QUOTE.exec(lines[j])![1]); j++; }
      blocks.push({ t: 'quote', c: parseMarkdown(body.join('\n'), seen) });
      i = j - 1;
      continue;
    }
    if (!para.length && isTableStart(lines, i)) {
      flushList();
      const head = cells(line);
      const align: Align[] = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      const rows: Inline[][][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
        const r = cells(lines[j]);
        rows.push(head.map((_, k) => parseInline(r[k] ?? '')));
        j++;
      }
      blocks.push({ t: 'table', align, head: head.map((c) => parseInline(c)), rows });
      i = j - 1;
      continue;
    }
    // an indented bullet or number under a list item starts (or continues) a nested list
    if (list && /^\s{2,}([-*+]|\d{1,9}[.)])\s+\S/.test(line)) {
      const k = list.items.length - 1;
      (list.nested[k] ??= []).push(line);
      continue;
    }
    if (list && list.nested[list.items.length - 1] && /^\s{4,}\S/.test(line)) { list.nested[list.items.length - 1].push(line); continue; }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      flushPara();
      const ordered = !!n;
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, start: n ? Number(n[1]) : 1, items: [], nested: {} }; }
      list.items.push(b ? b[1] : n![2]);
      continue;
    }
    // an indented line right after a list item continues it
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return blocks;
}

export interface TocEntry { id: string; level: number; text: string }

/** Headings of level 2 and 3 for a table of contents (including those inside blockquotes is not useful; they are skipped). */
export function tableOfContents(blocks: Block[]): TocEntry[] {
  return blocks.flatMap((b) => (b.t === 'h' && b.level >= 2 && b.level <= 3 ? [{ id: b.id, level: b.level, text: inlineText(b.c) }] : []));
}
