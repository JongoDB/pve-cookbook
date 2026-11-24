import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useApp } from '../state/app';
import { CommandPalette } from './CommandPalette';
import { PlanPane } from './PlanPane';
import { Dot, Logo } from './ui';

export const PAGES: { to: string; label: string; mvp: boolean }[] = [
  { to: '/', label: 'Fleet', mvp: true },
  { to: '/guests', label: 'Guests', mvp: true },
  { to: '/create', label: 'Create', mvp: false },
  { to: '/catalog', label: 'App catalog', mvp: false },
  { to: '/hardware', label: 'Hardware & GPUs', mvp: false },
  { to: '/network', label: 'Network / SDN', mvp: false },
  { to: '/firewall', label: 'Firewall', mvp: false },
  { to: '/backups', label: 'Backups', mvp: false },
  { to: '/access', label: 'Access', mvp: false },
  { to: '/operations', label: 'Operations', mvp: true },
  { to: '/audit', label: 'Audit log', mvp: true },
  { to: '/clusters', label: 'Clusters', mvp: true },
];

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function UserMenu() {
  const { me, api, setMe } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="user-menu" ref={ref}>
      <button type="button" className="link-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{me.user} ▾</button>
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" onClick={async () => { try { await api.logout(); } finally { setMe(null); } }}>Log out</button>
        </div>
      )}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { fleet, me, live, setPaletteOpen, paletteOpen } = useApp();
  const loc = useLocation();
  const page = PAGES.find((p) => (p.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(p.to)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPaletteOpen]);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand"><Logo />galley</span>
        <nav aria-label="Breadcrumb" className="crumb mono">{(page?.label ?? 'fleet').toLowerCase()}</nav>
        <button type="button" className="palette-btn" onClick={() => setPaletteOpen(true)}>
          <span>Search or run a command…</span><kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <span className={`live live-${live}`} title={live === 'live' ? 'Live updates' : live === 'polling' ? 'Polling every 5 s' : 'Connecting'}>
          {live === 'live' ? '● live' : live === 'polling' ? '◐ polling' : '○ connecting'}
        </span>
        <UserMenu />
      </header>

      <div className="shell">
        <nav className="sidenav" aria-label="Primary">
          {PAGES.filter((p) => p.to !== '/clusters').map((p) => (p.mvp ? (
            <NavLink key={p.to} to={p.to} end={p.to === '/'} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <span>{p.label}</span>
              {p.to === '/guests' && fleet ? <span className="count">{fleet.totals.guests}</span> : null}
            </NavLink>
          ) : (
            <span key={p.to} className="nav-item disabled" aria-disabled="true" title="Planned for v1">
              <span>{p.label}</span><span className="pill">v1</span>
            </span>
          )))}

          <div className="nav-section">Clusters</div>
          {me.clusters.map((c) => {
            const s = fleet?.clusters.find((x) => x.id === c.id);
            const online = s ? s.nodes.filter((n) => n.online).length : 0;
            const tone = !s ? 'off' : !s.quorate ? 'crit' : online < s.nodes.length ? 'warn' : 'ok';
            return (
              <NavLink key={c.id} to={`/clusters#${c.id}`} className="nav-item cluster-item">
                <span>{c.name}</span>
                <span className={`tone-${tone}`}>
                  {!c.authed ? 'login' : <><Dot tone={tone} /> {s ? `${online}/${s.nodes.length}` : '…'}</>}
                </span>
              </NavLink>
            );
          })}
          <NavLink to="/clusters?add=1" className="nav-item muted">+ Add cluster</NavLink>
        </nav>

        <main className="content" id="main">{children}</main>
        <PlanPane />
      </div>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
