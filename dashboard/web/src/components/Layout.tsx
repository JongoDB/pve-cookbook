import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useApp } from '../state/app';
import { CommandPalette } from './CommandPalette';
import { Drawer } from './Drawer';
import { IconMenu } from './Icons';
import { Logo } from './ui';
import { ClusterLoginForm } from './ClusterLogin';
import { sessionEndWarning } from '../lib/auth';

export const PAGES: { to: string; label: string; group?: 'tools' | 'bottom' }[] = [
  { to: '/', label: 'Overview' },
  { to: '/guests', label: 'Guests' },
  { to: '/nodes', label: 'Nodes' },
  { to: '/storage', label: 'Storage' },
  { to: '/hardware', label: 'Hardware' },
  { to: '/protection', label: 'Protection' },
  { to: '/activity', label: 'Activity' },
  { to: '/audit', label: 'Audit log' },
  { to: '/create', label: 'Create', group: 'tools' },
  { to: '/hosts', label: 'Hosts', group: 'tools' },
  { to: '/api-explorer', label: 'API', group: 'tools' },
  { to: '/clusters', label: 'Clusters' },
  { to: '/agents', label: 'Agents', group: 'bottom' },
  { to: '/help', label: 'Help', group: 'bottom' },
  { to: '/settings', label: 'Settings', group: 'bottom' },
];

/** Pages a user can use: Hosts needs admin rights on some cluster, Settings a galley admin. */
export const visiblePage = (p: { to: string }, me: { galleyAdmin?: boolean; clusters: { admin?: boolean; hostAdmin?: boolean }[] }) =>
  p.to === '/hosts' ? me.clusters.some((c) => c.hostAdmin ?? c.admin) : p.to === '/settings' ? !!me.galleyAdmin : true;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function UserMenu() {
  const { me, api, setMe } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="user-menu" ref={ref}>
      <button ref={btn} type="button" className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{me.user}</button>
      {open && (
        <div className="menu" role="menu" aria-label="Account">
          <div className="menu-meta">
            {me.galleyAdmin ? 'galley admin' : 'Signed in with your PVE account'}
            {me.version ? <div>galley {me.version}</div> : null}
          </div>
          <button type="button" role="menuitem" onClick={async () => { try { await api.logout(); } finally { setMe(null); } }}>Log out</button>
        </div>
      )}
    </div>
  );
}

/**
 * Session-level notices above every page: cluster logins that lapsed (the galley session is
 * still valid, only that cluster needs its password again) and the approaching hard end of the session.
 */
function SessionNotices() {
  const { me } = useApp();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [open, setOpen] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);
  const lapsed = me.clusters.filter((c) => c.loginExpired && !c.authed && !dismissed.includes(c.id));
  const end = sessionEndWarning(me.maxExpires, now);
  if (!lapsed.length && !end) return null;
  return (
    <div className="session-notices">
      {end && (
        <div className="notice notice-warn" role="status">
          <div className="grow">Your galley session ends at {end.at}, in {end.minutes} minute{end.minutes === 1 ? '' : 's'}, however active you are. Finish what you are doing; changes already running keep going. Then log in again.</div>
        </div>
      )}
      {lapsed.map((c) => (
        <div key={c.id} className="notice notice-info" role="status">
          <div className="grow">
            {open === c.id
              ? <div style={{ maxWidth: 520 }}><ClusterLoginForm clusterId={c.id} compact onDone={() => setOpen(null)} /></div>
              : <>Your login to {c.name} lapsed while you were away. Pages for {c.name} stay empty until you log in again; everything else keeps working.</>}
          </div>
          {open !== c.id && <button type="button" className="btn btn-sm btn-primary" onClick={() => setOpen(c.id)}>Log in to {c.name}</button>}
          <button type="button" className="btn btn-sm" onClick={() => setDismissed((d) => [...d, c.id])}>Later</button>
        </div>
      ))}
    </div>
  );
}

function Breadcrumbs() {
  const { crumbs } = useApp();
  const loc = useLocation();
  const page = PAGES.find((p) => (p.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(p.to)));
  const items = crumbs.length ? crumbs : [{ label: page?.label ?? 'Overview' }];
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((c, i) => (
          <li key={`${i}-${c.label}`}>
            {c.to && i < items.length - 1 ? <Link to={c.to}>{c.label}</Link> : <span aria-current={i === items.length - 1 ? 'page' : undefined}>{c.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { fleet, me, live, setPaletteOpen, paletteOpen } = useApp();
  const loc = useLocation();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => { setNavOpen(false); }, [loc.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPaletteOpen]);

  const unprotected = fleet?.clusters.reduce((a, c) => a + (c.backups.known === false ? 0 : c.backups.unprotected.length), 0) ?? 0;
  const liveText = live === 'live' ? 'Live' : live === 'polling' ? 'Polling every 5 s' : 'Connecting';

  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="topbar">
        <button type="button" className="icon-btn nav-toggle" aria-label="Menu" aria-expanded={navOpen} aria-controls="primary-nav" onClick={() => setNavOpen((v) => !v)}><IconMenu /></button>
        <Link to="/" className="brand"><Logo />galley</Link>
        <Breadcrumbs />
        <button type="button" className="palette-btn" onClick={() => setPaletteOpen(true)} aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}>
          <span>Ask, search or run a command</span><kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <span className={`live live-${live}`} title={live === 'polling' ? 'The live stream is down; galley polls every 5 seconds and keeps retrying.' : undefined}>
          <span className="live-text">{liveText}</span><span className="sr-only">{live === 'live' ? ': updates stream as they happen' : ''}</span>
        </span>
        <UserMenu />
      </header>

      <div className="shell">
        <nav id="primary-nav" className={`sidenav${navOpen ? ' open' : ''}`} aria-label="Primary">
          {PAGES.filter((p) => p.to !== '/clusters' && !p.group).map((p) => (
            <NavLink key={p.to} to={p.to} end={p.to === '/'} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <span>{p.label}</span>
              {p.to === '/guests' && fleet ? <span className="count">{fleet.totals.guests}</span> : null}
              {p.to === '/protection' && unprotected > 0 ? <span className="count attn"><span className="sr-only">Unprotected guests: </span>{unprotected}</span> : null}
            </NavLink>
          ))}
          <div className="nav-gap" aria-hidden="true" />
          {PAGES.filter((p) => p.group === 'tools' && visiblePage(p, me)).map((p) => (
            <NavLink key={p.to} to={p.to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}><span>{p.label}</span></NavLink>
          ))}

          <div className="nav-section" id="nav-clusters">Clusters</div>
          {me.clusters.map((c) => {
            const s = fleet?.clusters.find((x) => x.id === c.id);
            const online = s ? s.nodes.filter((n) => n.online).length : 0;
            const tone = !c.authed ? 'warn' : !s ? 'muted' : s.stale || !s.quorate ? 'crit' : online < s.nodes.length ? 'warn' : 'ok';
            const text = !c.authed ? 'log in' : !s ? 'loading' : s.stale ? 'stale' : `${online} of ${s.nodes.length}`;
            return (
              <Link key={c.id} to={`/clusters#${c.id}`} className={`nav-item nav-cluster${loc.pathname === '/clusters' && loc.hash === `#${c.id}` ? ' active' : ''}`}
                aria-current={loc.pathname === '/clusters' && loc.hash === `#${c.id}` ? 'page' : undefined} aria-describedby="nav-clusters">
                <span>{c.name}</span>
                <span className={`state ${tone}`}>{text}{c.authed && s && !s.stale ? <span className="sr-only"> nodes online{s.quorate ? '' : ', not quorate'}</span> : null}</span>
              </Link>
            );
          })}
          {me.galleyAdmin && <Link to="/clusters?add=1" className={`nav-item nav-add${loc.search.includes('add=1') ? ' active' : ''}`}>Add cluster</Link>}
          {PAGES.filter((p) => p.group === 'bottom' && visiblePage(p, me)).map((p) => (
            <NavLink key={p.to} to={p.to} className={({ isActive }) => `nav-item nav-bottom${isActive ? ' active' : ''}`}><span>{p.label}</span></NavLink>
          ))}
        </nav>

        <main className="content" id="main" tabIndex={-1}><SessionNotices />{children}</main>
        <Drawer />
      </div>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
