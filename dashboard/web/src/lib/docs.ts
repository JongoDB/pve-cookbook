// The user guide (Help): front matter parsing (for the mock), page-to-doc matching, search,
// and a per-session cache so the index is fetched once.
import { useEffect, useState } from 'react';
import type { Api, Doc, DocSummary, Release } from '../api/types';

/** Split `---` front matter from a guide page, like docs/embed.go. */
export function parseDocFile(slug: string, raw: string): Doc & { order: number } {
  let s = raw.replace(/\r\n/g, '\n');
  const meta: Record<string, string> = {};
  if (s.startsWith('---\n')) {
    const end = s.indexOf('\n---', 4);
    if (end >= 0) {
      for (const line of s.slice(4, end).split('\n')) {
        const k = line.indexOf(':');
        if (k < 0) continue;
        meta[line.slice(0, k).trim()] = line.slice(k + 1).trim().replace(/^["']+|["']+$/g, '');
      }
      s = s.slice(end + 4).replace(/^\n+/, '');
    }
  }
  return {
    slug, title: meta.title || slug, summary: meta.summary ?? '', order: Number.parseInt(meta.order ?? '', 10) || 0,
    ...(meta.route ? { route: meta.route } : {}), markdown: s,
  };
}

const RELEASE_HEAD = /^## v?([0-9][0-9A-Za-z.+-]*)\s*(?:—|-|–)?\s*(\d{4}-\d{2}-\d{2})?\s*$/;

/** Release notes from docs/changelog.md, newest first, like docs/embed.go (used by the mock). */
export function parseChangelog(raw: string): Release[] {
  const out: Release[] = [];
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    const m = RELEASE_HEAD.exec(line);
    if (m) { out.push({ version: m[1], date: m[2] ?? '', markdown: '' }); continue; }
    if (out.length) out[out.length - 1].markdown += `${line}\n`;
  }
  return out.map((r) => ({ ...r, markdown: r.markdown.trim() }));
}

const segs = (p: string) => p.split('/').filter(Boolean);

/**
 * The guide page that explains `pathname`: an exact route first (":param" segments match
 * anything), then the longest route that is a prefix of the path ("/" only matches itself).
 */
export function docForPath(docs: DocSummary[], pathname: string): DocSummary | null {
  const path = segs(pathname);
  let best: DocSummary | null = null;
  let bestScore = -1;
  for (const d of docs) {
    if (!d.route) continue;
    const route = segs(d.route.split(/[?#]/)[0]);
    if (route.length > path.length || (!route.length && path.length)) continue;
    if (!route.every((r, i) => r.startsWith(':') || r === path[i])) continue;
    // exact beats prefix; more literal segments beat fewer
    const score = (route.length === path.length ? 1000 : 0) + route.length * 10 + route.filter((r) => !r.startsWith(':')).length;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

/** A route a link can open: no ":param" placeholders. */
export const openableRoute = (route?: string) => !!route && route.startsWith('/') && !route.includes(':');

export interface DocHit { doc: DocSummary; snippet: string; score: number }

const plain = (md: string) => md
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[#>*`|_]/g, ' ')
  .replace(/\s+/g, ' ');

/** Pages whose title, summary or body contain every word of `q`, best first, with a body snippet. */
export function searchDocs(docs: DocSummary[], bodies: Record<string, string>, q: string): DocHit[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return docs.map((doc) => ({ doc, snippet: '', score: 0 }));
  const hits: DocHit[] = [];
  for (const doc of docs) {
    const title = doc.title.toLowerCase();
    const summary = doc.summary.toLowerCase();
    const body = plain(bodies[doc.slug] ?? '');
    const lbody = body.toLowerCase();
    let score = 0;
    let ok = true;
    for (const t of terms) {
      const inTitle = title.includes(t);
      const inSummary = summary.includes(t);
      const n = lbody.split(t).length - 1;
      if (!inTitle && !inSummary && !n) { ok = false; break; }
      score += (inTitle ? 20 : 0) + (inSummary ? 6 : 0) + Math.min(n, 10);
    }
    if (!ok) continue;
    let snippet = '';
    const at = lbody.indexOf(terms[0]);
    if (at >= 0 && !title.includes(terms[0])) {
      const from = Math.max(0, at - 60);
      snippet = `${from ? '…' : ''}${body.slice(from, at + 120).trim()}${at + 120 < body.length ? '…' : ''}`;
    }
    hits.push({ doc, snippet, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.doc.order - b.doc.order);
}

/** Cached guide data for one Api (one session): the index once, pages on demand. */
export class DocsCache {
  private indexP: Promise<DocSummary[]> | null = null;
  private pages = new Map<string, Promise<Doc>>();
  index: DocSummary[] | null = null;

  constructor(private api: Pick<Api, 'docs' | 'doc'>) {}

  loadIndex(): Promise<DocSummary[]> {
    if (!this.indexP) {
      this.indexP = this.api.docs().then(
        (d) => { this.index = [...d].sort((a, b) => a.order - b.order); return this.index; },
        (e) => { this.indexP = null; throw e; },
      );
    }
    return this.indexP;
  }

  loadDoc(slug: string): Promise<Doc> {
    let p = this.pages.get(slug);
    if (!p) {
      p = this.api.doc(slug);
      this.pages.set(slug, p);
      p.catch(() => this.pages.delete(slug));
    }
    return p;
  }

  /** Every page's body, for full-text search. */
  async loadBodies(): Promise<Record<string, string>> {
    const idx = await this.loadIndex();
    const docs = await Promise.all(idx.map((d) => this.loadDoc(d.slug).catch(() => null)));
    return Object.fromEntries(docs.filter((d): d is Doc => !!d).map((d) => [d.slug, d.markdown]));
  }
}

const caches = new WeakMap<object, DocsCache>();
export function docsCache(api: Pick<Api, 'docs' | 'doc'>): DocsCache {
  let c = caches.get(api);
  if (!c) { c = new DocsCache(api); caches.set(api, c); }
  return c;
}

/** The guide index, fetched once per session. `null` while loading or when it failed (help links simply stay hidden). */
export function useDocsIndex(api: Pick<Api, 'docs' | 'doc'>): { docs: DocSummary[] | null; error: unknown } {
  const cache = docsCache(api);
  const [docs, setDocs] = useState<DocSummary[] | null>(cache.index);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    if (!cache.index) cache.loadIndex().then((d) => { if (live) setDocs(d); }, (e) => { if (live) setError(e); });
    return () => { live = false; };
  }, [cache]);
  return { docs, error };
}
