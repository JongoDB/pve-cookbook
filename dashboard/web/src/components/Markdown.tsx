import { createElement, Fragment, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '../lib/markdown';
import { CopyButton } from './ui';

// Built with createElement so the renderer can be unit-tested from a .ts file.
const h = createElement;

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.t === 'code') return h('code', { key: i }, n.v);
    if (n.t === 'bold') return h('strong', { key: i }, ...inline(n.c));
    // newlines inside a paragraph are kept as line breaks
    const parts = n.v.split('\n');
    return h(Fragment, { key: i }, ...parts.flatMap((p, j) => (j ? [h('br', { key: `b${j}` }), p] : [p])));
  });
}

function block(b: Block, i: number): ReactNode {
  switch (b.t) {
    case 'p': return h('p', { key: i }, ...inline(b.c));
    case 'h': return h('p', { key: i, className: 'md-h' }, h('strong', null, ...inline(b.c)));
    case 'list':
      return h(b.ordered ? 'ol' : 'ul', { key: i, ...(b.ordered && b.start !== 1 ? { start: b.start } : {}) },
        ...b.items.map((it, j) => h('li', { key: j }, ...inline(it))));
    case 'code':
      return h('div', { key: i, className: 'md-code' },
        h('pre', { className: 'cli', ...(b.lang ? { 'data-lang': b.lang } : {}) }, b.v),
        b.open ? null : h('div', { className: 'md-code-actions' }, h(CopyButton, { text: b.v, label: 'Copy', className: 'btn btn-sm' })));
  }
}

/** Renders assistant Markdown as React elements; any HTML in the text shows as text. */
export function Markdown({ text }: { text: string }) {
  return h('div', { className: 'md' }, ...parseMarkdown(text).map(block));
}
