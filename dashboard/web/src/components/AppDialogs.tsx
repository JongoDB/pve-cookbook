import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ApiError } from '../api/http';
import type { WhatsNew } from '../api/types';
import { useApp } from '../state/app';
import { FEEDBACK_KINDS, issueUrl, type FeedbackKind } from '../lib/feedback';
import { Dialog } from './Dialog';
import { Markdown } from './Markdown';

/** The preference that remembers the last release whose notes the user saw. */
export const WHATSNEW_PREF = 'whatsnew';

/**
 * The What's new and Send feedback dialogs. Shows What's new once after login when the newest
 * release differs from the user's `whatsnew` preference; closing it in any way saves that.
 */
export function AppDialogs() {
  const { api, dialog, setDialog } = useApp();
  const [notes, setNotes] = useState<WhatsNew | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const wn = await api.whatsNew();
      if (!live) return;
      setNotes(wn);
      const newest = wn.releases[0]?.version;
      if (!newest) return;
      let seen: string | null = null;
      try { seen = await api.getPref<string>(WHATSNEW_PREF); } catch (e) { if (!(e instanceof ApiError && e.status === 404)) return; }
      if (live && seen !== newest) setDialog('whats-new');
    })().catch(() => { /* no notes: nothing to show */ });
    return () => { live = false; };
  }, [api, setDialog]);

  if (dialog === 'whats-new') {
    return (
      <WhatsNewDialog notes={notes} onClose={(v) => {
        if (v) api.putPref(WHATSNEW_PREF, v).catch(() => { /* shows again next time */ });
        setDialog(null);
      }} />
    );
  }
  if (dialog === 'feedback') return <FeedbackDialog onClose={() => setDialog(null)} />;
  return null;
}

function WhatsNewDialog({ notes, onClose: done }: { notes: WhatsNew | null; onClose: (seen?: string) => void }) {
  const { api } = useApp();
  const [loaded, setLoaded] = useState<WhatsNew | null>(notes);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (loaded) return;
    api.whatsNew().then(setLoaded, () => setFailed(true));
  }, [api, loaded]);
  const [newest, ...earlier] = loaded?.releases ?? [];
  const version = newest?.version ?? loaded?.version ?? '';
  const onClose = () => done(newest?.version);
  return (
    <Dialog wide title={`What's new in galley${version ? ` ${version}` : ''}`} onClose={onClose}
      footer={<button type="button" className="btn btn-primary" onClick={onClose}>Got it</button>}>
      {!loaded ? (failed ? <p className="text-2">Could not load the release notes. Try again later.</p> : <div className="muted" role="status">Loading the release notes</div>)
        : !newest ? <p className="text-2">No release notes yet.</p> : (
          <>
            {newest.date && <p className="release-date">Released {newest.date}</p>}
            {/* following a help link closes the dialog */}
            <div onClick={(e) => { if ((e.target as HTMLElement).closest('a')) onClose(); }}>
              <Markdown text={newest.markdown} variant="doc" />
            </div>
            {earlier.length > 0 && (
              <details className="earlier-releases">
                <summary>Earlier releases</summary>
                {earlier.map((r) => (
                  <section key={r.version} className="earlier-release" aria-label={`galley ${r.version}`}>
                    <h3>galley {r.version}{r.date ? <span className="muted small">, {r.date}</span> : null}</h3>
                    <Markdown text={r.markdown} variant="doc" />
                  </section>
                ))}
              </details>
            )}
          </>
        )}
    </Dialog>
  );
}

function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const { me, feedback } = useApp();
  const loc = useLocation();
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [include, setInclude] = useState(true);
  const [tried, setTried] = useState(false);
  const repo = feedback?.repo ?? '';
  const details = useMemo(() => ({ version: me.version ?? 'unknown', path: loc.pathname, userAgent: navigator.userAgent }), [me.version, loc.pathname]);
  const k = FEEDBACK_KINDS.find((x) => x.id === kind)!;
  const link = useMemo(() => issueUrl(repo, { kind, title, text, ...(include ? { details } : {}) }), [repo, kind, title, text, include, details]);

  const go = () => {
    setTried(true);
    if (!title.trim() || !repo) return;
    window.open(link.url, '_blank', 'noopener,noreferrer');
    onClose();
  };

  return (
    <Dialog title="Send feedback" onClose={onClose} initialFocus="#fb-title"
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={go}>Continue on GitHub</button>
      </>}>
      <div className="notice notice-warn" role="note">
        <div className="grow">Issues on <strong>{repo}</strong> are public. Don&apos;t include passwords, IPs or other private details.</div>
      </div>
      <form className="form-stack" onSubmit={(e) => { e.preventDefault(); go(); }}>
        <fieldset className="field fieldset">
          <legend className="label">Kind</legend>
          <div className="seg" role="radiogroup" aria-label="Kind">
            {FEEDBACK_KINDS.map((x) => (
              <button key={x.id} type="button" role="radio" aria-checked={kind === x.id} aria-pressed={kind === x.id} onClick={() => setKind(x.id)}>{x.label}</button>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span className="label">Title</span>
          <input id="fb-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoComplete="off"
            aria-invalid={tried && !title.trim()} aria-describedby={tried && !title.trim() ? 'fb-title-err' : undefined} />
          {tried && !title.trim() && <span className="hint" id="fb-title-err" role="alert">Enter a title.</span>}
        </label>
        <label className="field">
          <span className="label">{k.heading}</span>
          <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <div>
          <label className="check">
            <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} />
            Include galley version and this page&apos;s address
          </label>
          <ul className={`feedback-details${include ? '' : ' off'}`} aria-label="Details that will be included">
            <li><span className="k">galley:</span> {details.version}</li>
            <li><span className="k">Page:</span> <span className="mono">{details.path}</span></li>
            <li><span className="k">Browser:</span> {details.userAgent}</li>
          </ul>
        </div>
        {link.truncated && <p className="explain" role="status">Your description is too long for a link, so its end is cut. Add the rest on GitHub.</p>}
        <p className="explain">
          Continue on GitHub opens a new issue in a new tab with this text filled in. You review it there and submit it from your own GitHub account; galley sends nothing itself.
        </p>
      </form>
    </Dialog>
  );
}
