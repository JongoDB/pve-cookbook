import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, resolveHref, slugify, tableOfContents } from './markdown';
import { Markdown } from '../components/Markdown';

const html = (text: string, variant: 'chat' | 'doc' = 'chat') =>
  renderToStaticMarkup(createElement(StaticRouter, { location: '/help/changes' }, createElement(Markdown, { text, variant })));

describe('parseMarkdown', () => {
  it('splits paragraphs, lists, headings and fenced code', () => {
    const b = parseMarkdown('Intro **bold** and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n## Next\n\n```bash\nqm start 120\n```\nafter');
    expect(b.map((x) => x.t)).toEqual(['p', 'list', 'list', 'h', 'code', 'p']);
    expect(b[3]).toMatchObject({ t: 'h', level: 2, id: 'next' });
    expect(b[0]).toEqual({ t: 'p', c: [{ t: 'text', v: 'Intro ' }, { t: 'bold', c: [{ t: 'text', v: 'bold' }] }, { t: 'text', v: ' and ' }, { t: 'code', v: 'code' }, { t: 'text', v: '.' }] });
    expect(b[2]).toMatchObject({ ordered: true, start: 1 });
    expect(b[4]).toEqual({ t: 'code', lang: 'bash', v: 'qm start 120', open: false });
  });

  it('treats a fence that has not closed yet (streaming) as code to the end', () => {
    const b = parseMarkdown('Run:\n\n```\npvesm status\n');
    expect(b[1]).toMatchObject({ t: 'code', open: true });
    expect((b[1] as { v: string }).v.trim()).toBe('pvesm status');
  });

  it('keeps unclosed markers and code contents literal', () => {
    expect(parseInline('a **b')).toEqual([{ t: 'text', v: 'a **b' }]);
    expect(parseInline('`**not bold**`')).toEqual([{ t: 'code', v: '**not bold**' }]);
  });
});

describe('Markdown renderer', () => {
  it('renders structure as elements', () => {
    const out = html('**Two** things:\n\n- `nas-backup` is down\n- 131 has no backup\n\n```\nshowmount -e 192.0.2.40\n```');
    expect(out).toContain('<strong>Two</strong>');
    expect(out).toContain('<ul><li><code>nas-backup</code> is down</li><li>131 has no backup</li></ul>');
    expect(out).toContain('<pre class="cli">showmount -e 192.0.2.40</pre>');
    expect(out).toContain('Copy');
  });

  it('never turns model text into HTML', () => {
    const evil = '<img src=x onerror=alert(1)> **<script>alert(2)</script>** `<b>x</b>`\n\n```\n</pre><script>alert(3)</script>\n```\n\n- <a href="javascript:alert(4)">click</a>';
    const out = html(evil);
    expect(out).not.toMatch(/<img|<script|<a |<b>/);
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(out).toContain('&lt;/pre&gt;&lt;script&gt;alert(3)&lt;/script&gt;');
    expect(out).toContain('&lt;a href=&quot;javascript:alert(4)&quot;&gt;');
  });
});

describe('resolveHref', () => {
  it('keeps app routes, anchors and help docs', () => {
    expect(resolveHref('/guests/pve-lab/120')).toEqual({ kind: 'route', to: '/guests/pve-lab/120' });
    expect(resolveHref('/create')).toEqual({ kind: 'route', to: '/create' });
    expect(resolveHref('/help/changes#take-a-snapshot')).toEqual({ kind: 'route', to: '/help/changes#take-a-snapshot' });
    expect(resolveHref('/guests?q=web')).toEqual({ kind: 'route', to: '/guests?q=web' });
    expect(resolveHref('#apply-a-change')).toEqual({ kind: 'anchor', id: 'apply-a-change' });
    expect(resolveHref('changes.md')).toEqual({ kind: 'route', to: '/help/changes' });
    expect(resolveHref('./changes.md#take-a-snapshot')).toEqual({ kind: 'route', to: '/help/changes#take-a-snapshot' });
  });

  it('turns http(s) URLs into text, never a link', () => {
    expect(resolveHref('https://pve.proxmox.com/wiki/Backup')).toEqual({ kind: 'external', url: 'https://pve.proxmox.com/wiki/Backup' });
    expect(resolveHref('HTTP://example.com')).toEqual({ kind: 'external', url: 'http://example.com/' });
  });

  it.each([
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'mailto:a@b.c', 'file:///etc/passwd',
    '//evil.example', '///evil.example', '/\\evil.example', '\\\\evil.example', '/%2F%2Fevil.example', '/%2fevil.example', '/%5Cevil.example',
    '/%00x', '/x%0d%0aSet-Cookie:a', '/%E0%A4%A', '/../../etc/passwd', '/guests/%2e%2e/x', '/api/clusters', 'https:evil.example', 'https://',
    'guests/120', 'evil.example', '#"onmouseover=alert(1)', '#a b', '', '/a b', '/a"b', '/<script>', 'x.md#a"b', '../secret.md',
  ])('refuses %j', (href) => {
    const t = resolveHref(href);
    expect(t.kind === 'none' || (t.kind === 'external' && /^https?:\/\//.test(t.url))).toBe(true);
    expect(t.kind).not.toBe('route');
    expect(t.kind).not.toBe('anchor');
  });
});

describe('links, headings, tables and quotes', () => {
  it('parses links with inline content and keeps broken ones as text', () => {
    expect(parseInline('see [**grafana** (131)](/guests/pve-lab/131) now')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', c: [{ t: 'bold', c: [{ t: 'text', v: 'grafana' }] }, { t: 'text', v: ' (131)' }], target: { kind: 'route', to: '/guests/pve-lab/131' } },
      { t: 'text', v: ' now' },
    ]);
    expect(parseInline('[half](/guests')).toEqual([{ t: 'text', v: '[half](/guests' }]);
    expect(parseInline('`[not](/a)`')).toEqual([{ t: 'code', v: '[not](/a)' }]);
  });

  it('renders routes as SPA links and everything else without an href', () => {
    const out = html('[Guest 120](/guests/pve-lab/120), [docs](changes.md#take-a-snapshot), [top](#top), [wiki](https://pve.proxmox.com/wiki/Backup), [x](javascript:alert(1)), [y](data:text/html,hi), [z](//evil.example)');
    expect(out).toContain('<a class="md-link" href="/guests/pve-lab/120">Guest 120</a>');
    expect(out).toContain('<a class="md-link" href="/help/changes#take-a-snapshot">docs</a>');
    expect(out).toContain('<a class="md-link" href="/help/changes#top">top</a>');
    expect(out).toContain('wiki <span class="md-url">(https://pve.proxmox.com/wiki/Backup)</span>');
    expect(out.match(/<a /g)).toHaveLength(3);
    expect(out).not.toMatch(/href="(javascript|data|\/\/|https?:)/);
    expect(out).toContain(', x, y, z');
  });

  it('gives doc headings unique anchor ids and builds a table of contents', () => {
    const src = '# Changes\n\n## Take a snapshot\n\ntext\n\n### Why `confirm`?\n\n## Take a snapshot';
    const b = parseMarkdown(src);
    expect(tableOfContents(b)).toEqual([
      { id: 'take-a-snapshot', level: 2, text: 'Take a snapshot' },
      { id: 'why-confirm', level: 3, text: 'Why confirm?' },
      { id: 'take-a-snapshot-1', level: 2, text: 'Take a snapshot' },
    ]);
    const out = html(src, 'doc');
    expect(out).toContain('<h2 id="take-a-snapshot" class="md-heading" tabindex="-1">Take a snapshot</h2>');
    expect(out).toContain('<h3 id="why-confirm"');
    expect(slugify('Pin a host’s SSH key (ssh)')).toBe('pin-a-hosts-ssh-key-ssh');
  });

  it('parses pipe tables with alignment and escaped pipes', () => {
    const b = parseMarkdown('| Action | Needs |\n|:--|--:|\n| `start` | VM.PowerMgmt |\n| a \\| b | [x](/a) |\n\nafter');
    expect(b.map((x) => x.t)).toEqual(['table', 'p']);
    const t = b[0] as Extract<typeof b[0], { t: 'table' }>;
    expect(t.align).toEqual(['left', 'right']);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1][0]).toEqual([{ t: 'text', v: 'a | b' }]);
    const out = html('| A | B |\n|---|---|\n| <b>1</b> | 2 |');
    expect(out).toContain('<table><thead><tr><th scope="col">A</th>');
    expect(out).toContain('<td>&lt;b&gt;1&lt;/b&gt;</td>');
  });

  it('parses blockquotes as nested blocks', () => {
    const b = parseMarkdown('> **Note** this runs as root.\n> - one\n\nnext');
    expect(b[0]).toMatchObject({ t: 'quote' });
    expect((b[0] as { c: { t: string }[] }).c.map((x) => x.t)).toEqual(['p', 'list']);
    expect(html('> <script>x</script>')).toContain('<blockquote class="md-quote"><p>&lt;script&gt;x&lt;/script&gt;</p></blockquote>');
  });
});

describe('nested lists', () => {
  it('keeps indented bullets under their item', () => {
    const b = parseMarkdown('- **Generic** changes:\n  - one `DELETE` call\n  - several calls\n- **Next** item\n\nafter');
    expect(b.map((x) => x.t)).toEqual(['list', 'p']);
    const l = b[0] as Extract<typeof b[0], { t: 'list' }>;
    expect(l.items).toHaveLength(2);
    expect(l.nested?.[0]?.[0]).toMatchObject({ t: 'list', items: [[{ t: 'text', v: 'one ' }, { t: 'code', v: 'DELETE' }, { t: 'text', v: ' call' }], [{ t: 'text', v: 'several calls' }]] });
    expect(html('- a\n  1. b')).toContain('<ul><li>a<ol><li>b</li></ol></li></ul>');
  });
});
