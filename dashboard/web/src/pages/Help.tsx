import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/http';
import { useApp, useCrumbs } from '../state/app';
import { useAsync } from '../lib/hooks';
import { docsCache, openableRoute, searchDocs } from '../lib/docs';
import { parseMarkdown, tableOfContents } from '../lib/markdown';
import { Markdown } from '../components/Markdown';
import { ApiErrorView } from '../components/ClusterLogin';
import { Empty } from '../components/ui';

/** /help: every guide page, with a search over titles, summaries and page text. */
export function HelpIndex() {
  const { api, setDialog, feedback } = useApp();
  useCrumbs([{ label: 'Help' }]);
  const cache = docsCache(api);
  const index = useAsync(() => cache.loadIndex(), 'docs-index');
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [bodies, setBodies] = useState<Record<string, string> | null>(null);

  // Page text is fetched only once someone searches.
  const searching = !!q.trim();
  useEffect(() => {
    if (!searching || bodies) return;
    let live = true;
    cache.loadBodies().then((b) => { if (live) setBodies(b); }, () => { if (live) setBodies({}); });
    return () => { live = false; };
  }, [searching, bodies, cache]);

  const hits = useMemo(() => (index.data ? searchDocs(index.data, bodies ?? {}, q) : []), [index.data, bodies, q]);

  return (
    <div className="page help-page">
      <div className="page-head">
        <h1>Help</h1>
        <div className="sub">How galley works, and how to do common tasks with it.</div>
      </div>
      <div className="help-extras">
        <button type="button" className="btn btn-sm" onClick={() => setDialog('whats-new')}>What&apos;s new</button>
        {feedback?.enabled && <button type="button" className="btn btn-sm" onClick={() => setDialog('feedback')}>Send feedback</button>}
      </div>
      <div className="filters">
        <label className="field grow"><span className="sr-only">Search help</span>
          <input type="search" placeholder="Search help, for example snapshot or share login" value={q}
            onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })} />
        </label>
      </div>
      {index.error ? <ApiErrorView error={index.error} what="the help pages" onRetry={index.reload} />
        : !index.data ? <div className="muted" role="status">Loading help</div>
          : (
            <>
              <div className="sr-only" role="status" aria-live="polite">
                {searching ? `${hits.length} page${hits.length === 1 ? '' : 's'} match${hits.length === 1 ? 'es' : ''}${bodies ? '' : ' by title or summary; searching page text'}` : ''}
              </div>
              {searching && !bodies && <p className="muted small">Searching page text as well</p>}
              {hits.length === 0 ? (
                <Empty title={`No help page matches “${q.trim()}”`}>Try fewer or different words, or ask the assistant.</Empty>
              ) : (
                <ul className="help-cards">
                  {hits.map(({ doc, snippet }) => (
                    <li key={doc.slug}>
                      <Link className="help-card" to={`/help/${doc.slug}`}>
                        <span className="help-card-title">{doc.title}</span>
                        <span className="help-card-sum">{doc.summary}</span>
                        {snippet && <span className="help-card-snip">{snippet}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
    </div>
  );
}

/** /help/:slug: one guide page with its table of contents and the pages before and after it. */
export function HelpDoc() {
  const { api } = useApp();
  const { slug = '' } = useParams();
  const loc = useLocation();
  const cache = docsCache(api);
  const index = useAsync(() => cache.loadIndex(), 'docs-index');
  const doc = useAsync(() => cache.loadDoc(slug), `doc:${slug}`);
  const summary = index.data?.find((d) => d.slug === slug);
  const title = doc.data?.title ?? summary?.title ?? slug;
  useCrumbs([{ label: 'Help', to: '/help' }, { label: title }]);

  const blocks = useMemo(() => {
    if (!doc.data) return [];
    const b = parseMarkdown(doc.data.markdown);
    // the title is the page's h1; drop a leading "# Title" that repeats it
    return b[0]?.t === 'h' && b[0].level === 1 ? b.slice(1) : b;
  }, [doc.data]);
  const toc = useMemo(() => tableOfContents(blocks), [blocks]);

  // Follow #anchors (from the table of contents, other pages and the assistant); otherwise start at the top.
  const hash = loc.hash.slice(1);
  useEffect(() => {
    if (!doc.data) return;
    let id = hash;
    try { id = decodeURIComponent(hash); } catch { /* keep as is */ }
    const el = id ? document.getElementById(id) : null;
    if (el) { el.scrollIntoView({ block: 'start' }); el.focus({ preventScroll: true }); } else window.scrollTo(0, 0);
  }, [hash, doc.data]);

  const order = index.data ?? [];
  const at = order.findIndex((d) => d.slug === slug);
  const prev = at > 0 ? order[at - 1] : null;
  const next = at >= 0 && at < order.length - 1 ? order[at + 1] : null;
  const route = doc.data?.route ?? summary?.route;

  if (doc.error) {
    if (doc.error instanceof ApiError && doc.error.status === 404) {
      return <div className="page"><h1>Help</h1><Empty title={`No help page called ${slug}`}>It may have been renamed. <Link to="/help">All help pages</Link></Empty></div>;
    }
    return <div className="page"><h1>{title}</h1><ApiErrorView error={doc.error} what="this help page" onRetry={doc.reload} /></div>;
  }
  if (!doc.data) return <div className="page"><h1>{title}</h1><div className="muted" role="status">Loading help</div></div>;

  return (
    <div className="page help-page">
      <div className="page-head">
        <h1>{doc.data.title}</h1>
        {openableRoute(route) && <Link className="btn btn-sm" to={route!}>Open this page in galley</Link>}
        {doc.data.summary && <div className="sub">{doc.data.summary}</div>}
      </div>
      <div className={`help-layout${toc.length ? '' : ' no-toc'}`}>
        {toc.length > 0 && (
          <nav className="help-toc" aria-label="On this page">
            <div className="help-toc-title">On this page</div>
            <ul>
              {toc.map((t) => (
                <li key={t.id} className={t.level === 3 ? 'sub' : undefined}>
                  <Link to={{ hash: `#${t.id}` }} aria-current={hash === t.id ? 'location' : undefined}>{t.text}</Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <article className="help-article" aria-label={doc.data.title}>
          <Markdown text={doc.data.markdown} variant="doc" blocks={blocks} />
          {(prev || next) && (
            <nav className="help-pager" aria-label="Other help pages">
              {prev ? <Link to={`/help/${prev.slug}`} className="help-pager-prev"><span className="muted small">Previous</span>{prev.title}</Link> : <span />}
              {next ? <Link to={`/help/${next.slug}`} className="help-pager-next"><span className="muted small">Next</span>{next.title}</Link> : <span />}
            </nav>
          )}
        </article>
      </div>
    </div>
  );
}
