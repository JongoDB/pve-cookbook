import { createElement, Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { inlineText, parseMarkdown, type Block, type Inline } from '../lib/markdown';
import { CopyButton } from './ui';

// Built with createElement so the renderer can be unit-tested from a .ts file.
const h = createElement;

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.t === 'code') return h('code', { key: i }, n.v);
    if (n.t === 'bold') return h('strong', { key: i }, ...inline(n.c));
    if (n.t === 'link') {
      const kids = inline(n.c);
      const tg = n.target;
      switch (tg.kind) {
        case 'route': return h(Link, { key: i, to: tg.to, className: 'md-link' }, ...kids);
        case 'anchor': return h(Link, { key: i, to: { hash: `#${tg.id}` }, className: 'md-link' }, ...kids);
        case 'external': {
          // Never a clickable link: the text, then the address to copy if the reader wants it.
          const same = inlineText(n.c).trim() === tg.url || `${inlineText(n.c).trim()}/` === tg.url;
          return h('span', { key: i, className: 'md-ext' }, ...(same ? [] : [...kids, ' ']), h('span', { className: 'md-url' }, same ? tg.url : `(${tg.url})`));
        }
        default: return h(Fragment, { key: i }, ...kids);
      }
    }
    // newlines inside a paragraph are kept as line breaks
    const parts = n.v.split('\n');
    return h(Fragment, { key: i }, ...parts.flatMap((p, j) => (j ? [h('br', { key: `b${j}` }), p] : [p])));
  });
}

type Variant = 'chat' | 'doc';

function block(b: Block, i: number, variant: Variant): ReactNode {
  switch (b.t) {
    case 'p': return h('p', { key: i }, ...inline(b.c));
    case 'h':
      if (variant === 'chat') return h('p', { key: i, className: 'md-h' }, h('strong', null, ...inline(b.c)));
      // the page title is the h1; body headings start at h2
      return h(`h${Math.min(6, Math.max(2, b.level))}`, { key: i, id: b.id, className: 'md-heading', tabIndex: -1 }, ...inline(b.c));
    case 'list':
      return h(b.ordered ? 'ol' : 'ul', { key: i, ...(b.ordered && b.start !== 1 ? { start: b.start } : {}) },
        ...b.items.map((it, j) => h('li', { key: j }, ...inline(it), ...(b.nested?.[j] ?? []).map((x, k) => h(Fragment, { key: `n${k}` }, block(x, k, variant))))));
    case 'code':
      return h('div', { key: i, className: 'md-code' },
        h('pre', { className: 'cli', ...(b.lang ? { 'data-lang': b.lang } : {}) }, b.v),
        b.open ? null : h('div', { className: 'md-code-actions' }, h(CopyButton, { text: b.v, label: 'Copy', className: 'btn btn-sm' })));
    case 'table': {
      const style = (k: number) => (b.align[k] ? { textAlign: b.align[k]! } : undefined);
      return h('div', { key: i, className: 'md-table' },
        h('table', null,
          h('thead', null, h('tr', null, ...b.head.map((c, k) => h('th', { key: k, scope: 'col', style: style(k) }, ...inline(c))))),
          h('tbody', null, ...b.rows.map((r, j) => h('tr', { key: j }, ...r.map((c, k) => h('td', { key: k, style: style(k) }, ...inline(c))))))));
    }
    case 'quote':
      return h('blockquote', { key: i, className: 'md-quote' }, ...b.c.map((x, j) => block(x, j, variant)));
  }
}

/**
 * Renders Markdown as React elements; any HTML in the text shows as text. `chat` (assistant
 * answers) keeps headings compact; `doc` (help pages) renders real headings with anchor ids.
 * Pass `blocks` when they were already parsed (for a table of contents).
 */
export function Markdown({ text, variant = 'chat', blocks }: { text: string; variant?: Variant; blocks?: Block[] }) {
  return h('div', { className: variant === 'doc' ? 'md md-doc' : 'md' }, ...(blocks ?? parseMarkdown(text)).map((b, i) => block(b, i, variant)));
}
