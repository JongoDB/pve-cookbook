import { useState } from 'react';
import type { AgentApproval, AgentScope, AgentToken, CreatedAgentToken } from '../api/types';
import { errMsg, useApp, useCrumbs } from '../state/app';
import { useAsync } from '../lib/hooks';
import { ago } from '../lib/format';
import { ApiErrorView } from '../components/ClusterLogin';
import { HelpLink } from '../components/HelpLink';
import { CopyButton, Empty, ErrorBox } from '../components/ui';

const SCOPES: { id: AgentScope; label: string; text: string }[] = [
  { id: 'read', label: 'read', text: 'query only: lists, findings, tasks, metrics, PVE API reads and this user guide.' },
  { id: 'draft', label: 'draft', text: 'also drafts changes, which wait for you to review and apply in Changes.' },
  { id: 'apply', label: 'apply', text: 'also applies changes itself. Use with care: it acts as you.' },
];
const APPLY_NOTE: Record<AgentApproval, string> = {
  risky: 'An apply token applies routine guest work without anyone reviewing it, such as reboots and migrations. You still apply the rest yourself, in Changes.',
  hosts: 'An apply token can change your clusters without anyone reviewing the change. You still apply its host commands and access changes yourself, in Changes.',
  all: 'This galley requires a person to apply every agent change, so an apply token works like a draft token.',
  always: 'An apply token can change your clusters without anyone reviewing the change, including root commands on nodes: a galley admin turned approval off.',
};
const SCOPE_LABEL: Record<string, string> = { read: 'read', draft: 'draft', apply: 'apply' };

const date = (ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** Setup snippets for MCP clients; `token` is a placeholder until a token was just created. */
export function agentSnippets(origin: string, token: string) {
  return [
    { id: 'claude', label: 'Claude Code', text: `claude mcp add --transport http galley ${origin}/mcp --header "Authorization: Bearer ${token}"` },
    {
      id: 'json', label: 'Other MCP clients (JSON configuration)',
      text: JSON.stringify({ mcpServers: { galley: { type: 'http', url: `${origin}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    },
    {
      id: 'stdio', label: 'Clients that only run local (stdio) servers',
      text: `GALLEY_TOKEN=${token} galley mcp --url ${origin} --fingerprint <certificate SHA-256>`,
      note: 'Replace <certificate SHA-256> with the SHA-256 fingerprint of galley’s certificate, shown in your browser’s certificate viewer (the installer also printed it as TLS (sha256)). Leave --fingerprint out if the certificate is trusted by the system.',
    },
  ];
}

export function Agents() {
  const { api } = useApp();
  useCrumbs([{ label: 'Agents' }]);
  const list = useAsync(() => api.agentTokens(), 'agent-tokens');
  const [created, setCreated] = useState<CreatedAgentToken | null>(null);
  const origin = window.location.origin;

  return (
    <div className="page agents-page">
      <div className="page-head">
        <h1>Agents</h1><HelpLink slug="agents-and-mcp" />
        <div className="sub">Let AI agents and scripts use galley as you, over MCP or the REST API, with a token you can revoke at any time.</div>
      </div>

      {created
        ? <NewToken created={created} origin={origin} onDone={() => setCreated(null)} />
        : <CreateToken onCreated={(c) => { setCreated(c); list.reload(); }} />}

      <section className="panel" aria-labelledby="tokens-h">
        <div className="panel-head"><h2 id="tokens-h">Your agent tokens</h2></div>
        {list.error ? <div className="panel-body"><ApiErrorView error={list.error} what="your agent tokens" onRetry={list.reload} /></div>
          : !list.data ? <div className="muted panel-body" role="status">Loading agent tokens</div>
            : list.data.length === 0 ? <Empty title="No agent tokens">Create one above to connect an agent.</Empty>
              : <TokenTable tokens={list.data} onRevoked={list.reload} />}
      </section>

      {!created && (
        <section className="panel" aria-labelledby="setup-h">
          <div className="panel-head"><h2 id="setup-h">Connect an agent</h2><span className="muted">Replace &lt;token&gt; with the token you create</span></div>
          <div className="panel-body form-stack"><Snippets origin={origin} token="<token>" /></div>
        </section>
      )}
    </div>
  );
}

function CreateToken({ onCreated }: { onCreated: (c: CreatedAgentToken) => void }) {
  const { api, me } = useApp();
  const policy = useAsync(() => api.agentPolicy(), 'agent-policy');
  const loggedIn = me.clusters.filter((c) => c.authed).map((c) => c.name).join(', ');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<AgentScope>('read');
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOk = /^[A-Za-z0-9._-]{1,64}$/.test(name);
  const daysOk = Number.isInteger(days) && days >= 1 && days <= 90;

  const submit = async () => {
    setBusy(true); setError(null);
    try { onCreated(await api.createAgentToken({ name, scope, days })); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <section className="panel" aria-labelledby="create-h">
      <div className="panel-head"><h2 id="create-h">Create a token</h2></div>
      <form className="panel-body form-stack" onSubmit={(e) => { e.preventDefault(); if (nameOk && daysOk) void submit(); }}>
        <p className="explain">The token works on the clusters you are logged in to now ({loggedIn || 'none'}). Log in to every cluster the agent should reach first.</p>
        <div className="form-row">
          <label className="field">
            <span className="label">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ci-runner" autoComplete="off" spellCheck={false} maxLength={64}
              aria-invalid={!!name && !nameOk} aria-describedby="agent-name-hint" />
            <span className="hint" id="agent-name-hint">Letters, digits, dots, dashes and underscores. It shows in the audit log.</span>
          </label>
          <label className="field" style={{ flex: '0 0 140px' }}>
            <span className="label">Days valid</span>
            <input type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-invalid={!daysOk} />
            <span className="hint">1 to 90</span>
          </label>
        </div>
        <fieldset className="field fieldset">
          <legend className="label">What the agent may do</legend>
          {SCOPES.map((s) => (
            <label key={s.id} className="check choice-line">
              <input type="radio" name="agent-scope" checked={scope === s.id} onChange={() => setScope(s.id)} />
              <span><strong>{s.label}:</strong><span className="ws"> {s.text}</span></span>
            </label>
          ))}
          <span className="hint">Whatever the scope, the agent acts as you: PVE checks your permissions on every call, and the audit log shows the agent&apos;s name. Agents can never change clusters, galley settings or agent tokens.</span>
        </fieldset>
        {scope === 'apply' && (
          <div className="notice notice-warn" role="note"><div className="grow">{APPLY_NOTE[policy.data?.approval ?? 'risky']} Give it a short lifetime and keep it secret.</div></div>
        )}
        <ErrorBox message={error} />
        <div className="row-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !nameOk || !daysOk}>{busy ? 'Creating' : 'Create token'}</button>
        </div>
      </form>
    </section>
  );
}

function NewToken({ created, origin, onDone }: { created: CreatedAgentToken; origin: string; onDone: () => void }) {
  const warnings = created.warnings ?? [];
  return (
    <section className="panel agent-new" aria-labelledby="new-h">
      <div className="panel-head"><h2 id="new-h">Token for {created.name}</h2><span className="badge badge-neutral">{SCOPE_LABEL[created.scope] ?? created.scope}</span></div>
      <div className="panel-body form-stack">
        <div className="notice notice-warn" role="status">
          <div className="grow"><strong>Copy this token now. You won&apos;t see it again.</strong> If you lose it, revoke it and create a new one.</div>
        </div>
        <div className="token-box">
          <pre className="cli" aria-label="Agent token">{created.token}</pre>
          <div className="row-actions"><CopyButton text={created.token} label="Copy token" className="btn btn-sm btn-primary" /></div>
        </div>
        <p className="explain">
          Valid until {date(created.expires)}. Works on {created.clusters.length ? created.clusters.join(', ') : 'no cluster'}.
        </p>
        {warnings.length > 0 && (
          <div className="notice notice-warn" role="note">
            <div className="grow">
              The agent cannot use {warnings.length === 1 ? 'one cluster' : `${warnings.length} clusters`}:
              <ul className="plain-list">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
              Log in to those clusters, then create a new token.
            </div>
          </div>
        )}
        <h3 className="sub-h">Connect an agent</h3>
        <Snippets origin={origin} token={created.token} />
        <div className="row-actions"><button type="button" className="btn btn-primary" onClick={onDone}>Done, I copied it</button></div>
      </div>
    </section>
  );
}

function Snippets({ origin, token }: { origin: string; token: string }) {
  return (
    <>
      {agentSnippets(origin, token).map((s) => (
        <div key={s.id} className="snippet">
          <div className="snippet-head"><span className="label">{s.label}</span><CopyButton text={s.text} label="Copy" /></div>
          <pre className="cli snippet-cli">{s.text}</pre>
          {s.note && <p className="explain">{s.note}</p>}
        </div>
      ))}
    </>
  );
}

function TokenTable({ tokens, onRevoked }: { tokens: AgentToken[]; onRevoked: () => void }) {
  const { api } = useApp();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revoke = async (id: string) => {
    setBusy(true); setError(null);
    try { await api.deleteAgentToken(id); setConfirm(null); onRevoked(); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <div className="table-wrap">
      {error && <div className="panel-body"><ErrorBox message={`Could not revoke the token: ${error}`} /></div>}
      <table className="table">
        <thead><tr><th>Name</th><th>Scope</th><th>Created</th><th>Last used</th><th>Expires</th><th className="right"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id}>
              <td className="strong">{t.name}</td>
              <td><span className={`badge ${t.scope === 'apply' ? 'badge-warn' : 'badge-neutral'}`}>{SCOPE_LABEL[t.scope] ?? t.scope}</span></td>
              <td>{date(t.created)}</td>
              <td>{t.lastSeen ? ago(t.lastSeen) : <span className="muted">Never</span>}</td>
              <td>{date(t.expires)}</td>
              <td className="right">
                {confirm === t.id ? (
                  <span className="revoke-confirm" role="group" aria-label={`Revoke ${t.name}`}>
                    <span className="small">Revoke {t.name}? Agents using it stop working at once.</span>
                    <button type="button" className="btn btn-sm" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => void revoke(t.id)} disabled={busy} autoFocus>{busy ? 'Revoking' : 'Revoke'}</button>
                  </span>
                ) : (
                  <button type="button" className="btn btn-sm btn-danger-outline" onClick={() => setConfirm(t.id)}>Revoke</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
