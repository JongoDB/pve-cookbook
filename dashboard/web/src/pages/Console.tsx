import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/http';
import type { ConsoleTicket, ConsoleType } from '../api/types';
import { errMsg, useApp, useCrumbs } from '../state/app';
import { guestPath, nodePath } from '../lib/links';
import { consoleSocketUrl, inputFrame, loginMessage, PING_FRAME, resizeFrame } from '../lib/termproxy';
import { ApiErrorView } from '../components/ClusterLogin';

type Phase = 'requesting' | 'connecting' | 'connected' | 'closed' | 'error';

/** What to say when the console could not be opened, in the admin's terms. */
function consoleError(e: unknown, type: ConsoleType): string {
  if (e instanceof ApiError && (e.status === 403 || e.code === 'console_denied')) {
    return `PVE refused the console: it needs ${type === 'node' ? 'Sys.Console on /nodes/<node>' : 'VM.Console on the guest'} for your account. ${e.message}`;
  }
  return `Could not open the console: ${errMsg(e).replace(/\.$/, '')}.`;
}

/**
 * Full-page console for a VM (noVNC), a container or a node shell (xterm.js over PVE termproxy).
 * The ticket comes from POST /api/clusters/{id}/console; galley proxies the websocket to PVE.
 */
export function Console() {
  const { cluster = '', type: rawType = '', node = '', vmid } = useParams();
  const type = (['qemu', 'lxc', 'node'].includes(rawType) ? rawType : 'node') as ConsoleType;
  const { api, guests, clusterName, me } = useApp();
  const g = vmid ? guests?.find((x) => x.clusterId === cluster && String(x.vmid) === vmid) : undefined;
  const label = type === 'node' ? `${node} shell` : `${g?.name ?? `Guest ${vmid}`} console`;
  const back = type === 'node' ? nodePath(cluster, node) : guestPath(cluster, vmid ?? '');
  useCrumbs(type === 'node'
    ? [{ label: 'Nodes', to: '/nodes' }, { label: clusterName(cluster) }, { label: node, to: back }, { label: 'Shell' }]
    : [{ label: 'Guests', to: '/guests' }, { label: clusterName(cluster) }, { label: g?.name ?? vmid ?? '', to: back }, { label: 'Console' }]);
  const authed = !!me.clusters.find((c) => c.id === cluster)?.authed;

  const screen = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('requesting');
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [protocol, setProtocol] = useState<ConsoleTicket['protocol'] | null>(null);
  const ctrlAltDel = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!authed) return;
    let alive = true;
    let cleanup: (() => void) | null = null;
    setPhase('requesting'); setMessage(null); ctrlAltDel.current = null;
    (async () => {
      let t: ConsoleTicket;
      try {
        t = await api.openConsole(cluster, { type, node, ...(vmid ? { vmid: Number(vmid) } : {}) });
      } catch (e) {
        if (!alive) return;
        setMessage(consoleError(e, type)); setPhase('error');
        return;
      }
      if (!alive || !screen.current) return;
      setProtocol(t.protocol);
      setPhase('connecting');
      const url = consoleSocketUrl(t.token);
      const events = {
        connected: () => alive && setPhase('connected'),
        closed: (why?: string) => { if (alive) { setPhase('closed'); setMessage(why ?? 'The console connection closed.'); } },
      };
      try {
        cleanup = t.protocol === 'vnc'
          ? await startVnc(screen.current, url, t.password, events, (fn) => { ctrlAltDel.current = fn; })
          : await startTerm(screen.current, url, t.user, t.password, events);
      } catch (e) {
        if (alive) { setMessage(`Could not start the console client: ${errMsg(e)}`); setPhase('error'); }
      }
      if (!alive) cleanup?.();
    })();
    return () => { alive = false; cleanup?.(); };
  }, [api, cluster, type, node, vmid, attempt, authed]);

  const reconnect = useCallback(() => setAttempt((a) => a + 1), []);
  const fullscreen = () => { void screen.current?.requestFullscreen?.().catch(() => undefined); };

  return (
    <div className="page console-page">
      <div className="page-head">
        <h1>{label}</h1>
        <div className="toolbar">
          {protocol === 'vnc' && <button type="button" className="btn btn-sm" disabled={phase !== 'connected'} onClick={() => ctrlAltDel.current?.()}>Send Ctrl+Alt+Del</button>}
          <button type="button" className="btn btn-sm" disabled={phase !== 'connected'} onClick={fullscreen}>Full screen</button>
          <button type="button" className="btn btn-sm" onClick={reconnect} disabled={phase === 'requesting' || phase === 'connecting'}>Reconnect</button>
          <Link className="btn btn-sm" to={back}>Back to {type === 'node' ? node : g?.name ?? `guest ${vmid}`}</Link>
        </div>
        <div className="sub">
          {type === 'node' ? `Root shell on ${node}, ${clusterName(cluster)}. Commands here run outside galley's changes and audit log; PVE logs the session.`
            : `${type === 'qemu' ? 'VM display' : 'Container terminal'} on ${node}, ${clusterName(cluster)}. Keyboard input goes to the guest while the console has focus.`}
        </div>
      </div>
      {!authed && <ApiErrorView error={new ApiError(409, 'cluster_login_required', '')} clusterId={cluster} />}
      {authed && (phase === 'error' || phase === 'closed') && message && (
        <div className={`notice ${phase === 'error' ? 'notice-error' : 'notice-info'}`} role={phase === 'error' ? 'alert' : 'status'}>
          <div className="grow">{message}</div>
          <button type="button" className="btn btn-sm" onClick={reconnect}>{phase === 'closed' ? 'Reconnect' : 'Try again'}</button>
        </div>
      )}
      {authed && (phase === 'requesting' || phase === 'connecting') && <div className="muted" role="status">{phase === 'requesting' ? 'Asking PVE for a console ticket' : 'Connecting'}</div>}
      <div ref={screen} className={`console-screen ${protocol === 'term' ? 'term' : 'vnc'}${phase === 'connected' ? '' : ' idle'}`} aria-label={label} />
    </div>
  );
}

interface ConsoleEvents { connected: () => void; closed: (why?: string) => void }

async function startVnc(el: HTMLElement, url: string, password: string, ev: ConsoleEvents, setCad: (fn: () => void) => void): Promise<() => void> {
  const { default: RFB } = await import('@novnc/novnc');
  el.replaceChildren();
  const rfb = new RFB(el, url, { credentials: { password }, wsProtocols: ['binary'] });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.background = 'var(--code-bg)';
  rfb.addEventListener('connect', () => { ev.connected(); rfb.focus(); });
  rfb.addEventListener('disconnect', (e) => {
    const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean;
    ev.closed(clean ? 'The VM console closed.' : 'The console connection dropped. The VM may have stopped, or the link expired.');
  });
  rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password }));
  rfb.addEventListener('securityfailure', (e) => ev.closed(`The VNC server refused the console: ${(e as CustomEvent<{ reason?: string }>).detail?.reason ?? 'authentication failed'}.`));
  setCad(() => rfb.sendCtrlAltDel());
  return () => { try { rfb.disconnect(); } catch { /* already closed */ } };
}

async function startTerm(el: HTMLElement, url: string, user: string, password: string, ev: ConsoleEvents): Promise<() => void> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')]);
  el.replaceChildren();
  const term = new Terminal({
    cursorBlink: true, fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace", fontSize: 13, scrollback: 5000,
    theme: { background: '#0B1119', foreground: '#D5DDE7', cursor: '#9CC3E6', selectionBackground: '#2B4766' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  fit.fit();
  const ws = new WebSocket(url, 'binary');
  ws.binaryType = 'arraybuffer';
  let authed = false;
  const decoder = new TextDecoder();
  const send = (s: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(s); };
  ws.onopen = () => send(loginMessage(user, password));
  ws.onmessage = (m) => {
    const bytes = typeof m.data === 'string' ? new TextEncoder().encode(m.data) : new Uint8Array(m.data as ArrayBuffer);
    if (!authed) {
      // termproxy answers "OK" once the ticket is accepted
      if (decoder.decode(bytes.slice(0, 2)) !== 'OK') { ev.closed('PVE did not accept the terminal ticket.'); ws.close(); return; }
      authed = true;
      ev.connected();
      send(resizeFrame(term.cols, term.rows));
      term.focus();
      if (bytes.length > 2) term.write(bytes.slice(2));
      return;
    }
    term.write(bytes);
  };
  ws.onclose = () => ev.closed(authed ? 'The shell session ended.' : 'The terminal connection closed before it was ready.');
  const onData = term.onData((d) => send(inputFrame(d)));
  const onResize = term.onResize(({ cols, rows }) => { if (authed) send(resizeFrame(cols, rows)); });
  const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* not visible */ } });
  ro.observe(el);
  const ping = setInterval(() => send(PING_FRAME), 30_000);
  return () => {
    clearInterval(ping); ro.disconnect(); onData.dispose(); onResize.dispose();
    ws.onclose = null; ws.close(); term.dispose();
  };
}
