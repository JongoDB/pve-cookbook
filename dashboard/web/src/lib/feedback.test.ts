import { describe, expect, it } from 'vitest';
import { MAX_URL, issueBody, issueUrl } from './feedback';

const details = { version: '0.2.0', path: '/guests/pve-lab/120', userAgent: 'TestBrowser/1.0' };

describe('feedback issue links', () => {
  it('builds the body from the template', () => {
    expect(issueBody({ kind: 'bug', title: 't', text: 'It broke.', details })).toBe(
      "### What happened\nIt broke.\n\n### Details\n- galley 0.2.0\n- page: /guests/pve-lab/120\n- browser: TestBrowser/1.0\n\n_Sent from galley's feedback dialog._",
    );
    expect(issueBody({ kind: 'idea', title: 't', text: 'More charts' })).toBe("### What you'd like\nMore charts\n\n_Sent from galley's feedback dialog._");
  });

  it('encodes title, body and label as query parameters', () => {
    const { url, truncated } = issueUrl('owner/repo', { kind: 'idea', title: 'Dark & light', text: 'a b', details });
    expect(truncated).toBe(false);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://github.com/owner/repo/issues/new');
    expect(u.searchParams.get('title')).toBe('Dark & light');
    expect(u.searchParams.get('labels')).toBe('enhancement');
    expect(u.searchParams.get('body')).toContain('- page: /guests/pve-lab/120');
    expect(new URL(issueUrl('o/r', { kind: 'question', title: 'q', text: '' }).url).searchParams.get('labels')).toBe('question');
  });

  it('shortens a long description to fit, with a note', () => {
    const { url, truncated } = issueUrl('owner/repo', { kind: 'bug', title: 'Long', text: 'ünïcødé '.repeat(3000), details });
    expect(truncated).toBe(true);
    expect(url.length).toBeLessThanOrEqual(MAX_URL);
    const body = new URL(url).searchParams.get('body')!;
    expect(body).toContain('Shortened to fit in a link');
    expect(body).toContain('- browser: TestBrowser/1.0');
  });
});
