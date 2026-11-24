import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';
import { Markdown } from '../components/Markdown';

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('parseMarkdown', () => {
  it('splits paragraphs, lists, headings and fenced code', () => {
    const b = parseMarkdown('Intro **bold** and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n## Next\n\n```bash\nqm start 120\n```\nafter');
    expect(b.map((x) => x.t)).toEqual(['p', 'list', 'list', 'h', 'code', 'p']);
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
