import { describe, expect, it } from 'vitest';
import { docForPath, openableRoute, parseDocFile, searchDocs } from './docs';
import type { DocSummary } from '../api/types';

const d = (slug: string, route?: string, order = 0, title = slug, summary = ''): DocSummary => ({ slug, title, summary, order, ...(route ? { route } : {}) });

describe('guide helpers', () => {
  it('parses front matter like docs/embed.go', () => {
    const doc = parseDocFile('changes', '---\ntitle: "Changes"\nsummary: How changes work: review, apply.\norder: 40\nroute: /audit\n---\n\n## Apply\ntext');
    expect(doc).toEqual({ slug: 'changes', title: 'Changes', summary: 'How changes work: review, apply.', order: 40, route: '/audit', markdown: '## Apply\ntext' });
    expect(parseDocFile('x', 'no front matter')).toMatchObject({ title: 'x', order: 0, markdown: 'no front matter' });
  });

  it('matches the current page to a guide page', () => {
    const docs = [d('overview', '/'), d('guests', '/guests'), d('guest', '/guests/:cluster/:vmid'), d('create', '/create'), d('none')];
    expect(docForPath(docs, '/')?.slug).toBe('overview');
    expect(docForPath(docs, '/guests')?.slug).toBe('guests');
    expect(docForPath(docs, '/guests/pve-lab/120')?.slug).toBe('guest');
    expect(docForPath([d('guests', '/guests')], '/guests/pve-lab/120')?.slug).toBe('guests');
    expect(docForPath(docs, '/hosts')).toBeNull();
    expect(openableRoute('/guests/:cluster/:vmid')).toBe(false);
    expect(openableRoute('/create')).toBe(true);
  });

  it('searches titles, summaries and bodies with every word', () => {
    const docs = [d('a', undefined, 1, 'Snapshots', 'Take and roll back snapshots'), d('b', undefined, 2, 'Backups', 'Jobs and coverage')];
    expect(searchDocs(docs, {}, 'snap').map((h) => h.doc.slug)).toEqual(['a']);
    const hits = searchDocs(docs, { b: 'Run `vzdump` before a snapshot of the guest.' }, 'snapshot guest');
    expect(hits.map((h) => h.doc.slug)).toEqual(['b']);
    expect(hits[0].snippet).toContain('snapshot of the guest');
    expect(searchDocs(docs, {}, '').length).toBe(2);
  });
});
