// A deliberately small Markdown subset for assistant answers: paragraphs, headings (shown as
// bold lines), bullet and numbered lists, fenced code blocks, inline code and bold.
// It produces a plain data tree; components/Markdown.tsx turns it into React elements, so model
// text is never parsed as HTML (no dangerouslySetInnerHTML anywhere).

export type Inline = { t: 'text'; v: string } | { t: 'code'; v: string } | { t: 'bold'; c: Inline[] };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; c: Inline[] }
  | { t: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { t: 'code'; lang: string; v: string; open: boolean };

/** Inline spans: `code` first (its content is literal), then **bold**. Unclosed markers stay text. */
export function parseInline(s: string, allowBold = true): Inline[] {
  const out: Inline[] = [];
  const text = (v: string) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last?.t === 'text') last.v += v; else out.push({ t: 'text', v });
  };
  let i = 0;
  while (i < s.length) {
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) { out.push({ t: 'code', v: s.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if (allowBold && s.startsWith('**', i)) {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) { out.push({ t: 'bold', c: parseInline(s.slice(i + 2, end), false) }); i = end + 2; continue; }
    }
    // plain run up to the next marker
    let j = i + 1;
    while (j < s.length && s[j] !== '`' && !(allowBold && s.startsWith('**', j))) j++;
    text(s.slice(i, j));
    i = j;
  }
  return out;
}

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;

  const flushPara = () => { if (para.length) { blocks.push({ t: 'p', c: parseInline(para.join('\n')) }); para = []; } };
  const flushList = () => {
    if (list) { blocks.push({ t: 'list', ordered: list.ordered, start: list.start, items: list.items.map((x) => parseInline(x)) }); list = null; }
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
    if (h) { flushPara(); flushList(); blocks.push({ t: 'h', c: parseInline(h[1]) }); continue; }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      flushPara();
      const ordered = !!n;
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, start: n ? Number(n[1]) : 1, items: [] }; }
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
