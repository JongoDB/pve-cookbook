import { useEffect, useState } from 'react';
import { ApiError } from '../api/http';
import type { AgentApproval, FeedbackConfig, AssistantConfig, AssistantProvider, AssistantSettingsUpdate, Effort } from '../api/types';
import { errMsg, useApp, useCrumbs } from '../state/app';
import { useAsync } from '../lib/hooks';
import { ApiErrorView } from '../components/ClusterLogin';
import { Empty } from '../components/ui';
import { HelpLink } from '../components/HelpLink';
import { ASSISTANT_SETTINGS_EVENT } from '../components/Assistant';

const BASE_URL_EXAMPLES: { url: string; what: string }[] = [
  { url: 'https://api.openai.com/v1', what: 'OpenAI' },
  { url: 'https://api.x.ai/v1', what: 'xAI' },
  { url: 'https://openrouter.ai/api/v1', what: 'OpenRouter' },
  { url: 'http://<gpu-host>:8000/v1', what: 'vLLM on your own GPU host' },
  { url: 'http://<host>:11434/v1', what: 'Ollama' },
];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_MODEL = 'claude-opus-5-5';

const hostOf = (u?: string) => { try { return u ? new URL(u).host : ''; } catch { return ''; } };

export function Settings() {
  useCrumbs([{ label: 'Settings' }]);
  const { me } = useApp();
  if (!me.galleyAdmin) {
    return (
      <div className="page">
        <h1>Settings</h1>
        <Empty title="Settings need a galley admin">
          Galley admins are users with Sys.Modify on / in every registered cluster who are logged in to all of them in this session,
          or users listed with <code>galley --admin cluster:user@realm</code>. Ask one to change galley-wide settings.
        </Empty>
      </div>
    );
  }
  return (
    <div className="page">
      <div className="page-head">
        <h1>Settings</h1><HelpLink />
        <div className="sub">Galley-wide settings. Every change here is recorded in the audit log.</div>
      </div>
      <AssistantSettingsForm />
      <AgentApprovalForm />
      <FeedbackSettingsForm />
    </div>
  );
}

function AssistantSettingsForm() {
  const { api } = useApp();
  const [rev, setRev] = useState(0);
  const saved = useAsync(() => api.assistantSettings(), `assistant-settings|${rev}`);
  const [cfg, setCfg] = useState<AssistantConfig | null>(null);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => { if (saved.data) { setCfg(saved.data.config); setKey(''); setClearKey(false); } }, [saved.data]);

  if (saved.error) {
    return saved.error instanceof ApiError && saved.error.status === 403
      ? <Empty title="Only a galley admin can change the assistant">{saved.error.message}</Empty>
      : <ApiErrorView error={saved.error} what="the assistant settings" onRetry={saved.reload} />;
  }
  if (!saved.data || !cfg) return <div className="panel"><div className="muted panel-body" role="status">Loading the assistant settings</div></div>;

  const orig = saved.data.config;
  const anthropic = cfg.provider === 'anthropic';
  const destChanged = cfg.provider !== orig.provider || hostOf(cfg.baseUrl) !== hostOf(orig.baseUrl);
  const keyDropped = saved.data.hasApiKey && destChanged && !key;
  const dest = anthropic ? (cfg.baseUrl ? hostOf(cfg.baseUrl) || 'the configured endpoint' : 'Anthropic (api.anthropic.com)') : hostOf(cfg.baseUrl) || 'the endpoint you enter';
  const set = (p: Partial<AssistantConfig>) => { setCfg((c) => ({ ...c!, ...p })); setOk(null); };

  const setProvider = (provider: AssistantProvider) => {
    if (provider === cfg.provider) return;
    set(provider === 'anthropic'
      ? { provider, baseUrl: '', model: DEFAULT_MODEL, effort: cfg.effort || 'medium', fallback: true }
      : { provider, baseUrl: cfg.baseUrl || '', model: cfg.model === DEFAULT_MODEL ? '' : cfg.model, effort: '', fallback: false });
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setOk(null);
    if (!anthropic && !cfg.baseUrl?.trim()) { setErr('An OpenAI-compatible provider needs a base URL.'); return; }
    if (!cfg.model.trim()) { setErr('Enter a model name.'); return; }
    if (cfg.enabled && anthropic && !key && (!saved.data!.hasApiKey || clearKey || destChanged)) { setErr('Anthropic needs an API key. Paste one, or turn the assistant off.'); return; }
    const body: AssistantSettingsUpdate = {
      ...cfg, model: cfg.model.trim(), baseUrl: cfg.baseUrl?.trim() || undefined,
      effort: anthropic ? cfg.effort || 'medium' : '', fallback: anthropic ? cfg.fallback : false,
      ...(key ? { apiKey: key } : clearKey ? { clearApiKey: true } : {}),
    };
    setBusy(true);
    try {
      await api.putAssistantSettings(body);
      setOk(cfg.enabled ? 'Saved. The assistant uses these settings for new conversations.' : 'Saved. The assistant is off.');
      setRev((r) => r + 1);
      window.dispatchEvent(new Event(ASSISTANT_SETTINGS_EVENT));
    } catch (e2) {
      setErr(`Could not save: ${errMsg(e2)}`);
    } finally { setBusy(false); }
  };

  return (
    <form className="panel" onSubmit={save} aria-labelledby="as-h">
      <div className="panel-head"><h2 id="as-h">Assistant</h2><span className="muted">{orig.enabled ? `On, ${orig.provider === 'anthropic' ? 'Anthropic' : hostOf(orig.baseUrl)} ${orig.model}` : 'Off'}</span></div>
      <div className="panel-body form-stack settings-form">
        <label className="check">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Turn on the assistant for every galley user
        </label>
        {!cfg.enabled && (saved.data.hasApiKey || key) && (
          <p className="notice notice-warn" role="note">A key is {key ? 'entered' : 'saved'}, but the assistant is off. Tick the box above to turn it on.</p>
        )}

        <fieldset className="field fieldset">
          <legend className="label">Provider</legend>
          <div className="seg" role="radiogroup" aria-label="Provider">
            {(['anthropic', 'openai'] as AssistantProvider[]).map((p) => (
              <button key={p} type="button" role="radio" aria-checked={cfg.provider === p} aria-pressed={cfg.provider === p} onClick={() => setProvider(p)}>
                {p === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'}
              </button>
            ))}
          </div>
        </fieldset>

        {!anthropic && (
          <label className="field">
            <span className="label">Base URL</span>
            <input value={cfg.baseUrl ?? ''} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" spellCheck={false} autoComplete="off" required />
            <span className="hint">The /v1 endpoint of any OpenAI-compatible API:</span>
            <ul className="examples">
              {BASE_URL_EXAMPLES.map((x) => (
                <li key={x.url}><button type="button" className="link-btn mono" onClick={() => set({ baseUrl: x.url })}>{x.url}</button> <span className="muted">{x.what}</span></li>
              ))}
            </ul>
          </label>
        )}

        <div className="form-row">
          <label className="field">
            <span className="label">Model</span>
            <input value={cfg.model} onChange={(e) => set({ model: e.target.value })} placeholder={anthropic ? DEFAULT_MODEL : 'gpt-5.1, grok-4, Qwen/Qwen3-32B…'} spellCheck={false} autoComplete="off" />
          </label>
          {anthropic && (
            <label className="field">
              <span className="label">Effort</span>
              <select value={cfg.effort || 'medium'} onChange={(e) => set({ effort: e.target.value as Effort })}>
                {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </label>
          )}
        </div>
        {anthropic && <span className="hint">Higher effort answers harder questions better and takes longer. Medium suits most clusters.</span>}

        {anthropic && (
          <label className="check">
            <input type="checkbox" checked={cfg.fallback} onChange={(e) => set({ fallback: e.target.checked })} />
            Refusal fallback: when the model declines a request, Anthropic retries it on a fallback model instead of returning the refusal.
          </label>
        )}

        <fieldset className="field fieldset">
          <legend className="label">API key</legend>
          {saved.data.hasApiKey && !clearKey && !keyDropped && (
            <div className="row-actions"><span className="badge badge-ok">A key is saved</span><span className="muted small">Write-only: galley never shows it again.</span>
              <button type="button" className="link-btn" onClick={() => { setClearKey(true); setKey(''); }}>Remove key</button></div>
          )}
          {clearKey && <div className="row-actions"><span className="badge badge-neutral">The key will be removed when you save</span><button type="button" className="link-btn" onClick={() => setClearKey(false)}>Keep it</button></div>}
          {keyDropped && <div className="notice notice-warn"><div className="grow">You changed where requests go, so the saved key will not be sent there. Paste the key for {dest}.</div></div>}
          <input type="password" value={key} onChange={(e) => { setKey(e.target.value); if (e.target.value) setClearKey(false); }} autoComplete="off" spellCheck={false}
            placeholder={saved.data.hasApiKey ? 'Paste a new key to replace the saved one' : anthropic ? 'sk-ant-…' : 'Leave empty if the endpoint needs no key (vLLM, Ollama)'} aria-label="API key" />
          <span className="hint">Stored encrypted on the galley server.</span>
        </fieldset>

        <div className="notice notice-info">
          <div className="grow">
            <strong>What leaves galley</strong>
            <p className="small" style={{ marginTop: 4 }}>
              Each question, and the cluster data the assistant reads to answer it, is sent to <strong>{dest}</strong>: guest and node names, configurations,
              health findings, task logs and metrics, read with the asking user&apos;s PVE permissions. PVE tickets and galley&apos;s own credentials stay on the galley server.
              {!anthropic && /^http:\/\//.test(cfg.baseUrl ?? '') ? ' This endpoint uses plain HTTP: anyone on the network path can read the traffic.' : ''}
            </p>
          </div>
        </div>

        {err && <div className="notice notice-error" role="alert"><div className="grow">{err}</div></div>}
        {ok && <div className="notice notice-ok" role="status"><div className="grow">{ok}</div></div>}
        <div className="row-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving' : 'Save assistant settings'}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => { setCfg(orig); setKey(''); setClearKey(false); setErr(null); setOk(null); }}>Undo changes</button>
        </div>
      </div>
    </form>
  );
}

const APPROVALS: { id: AgentApproval; label: string; short: string; text: string }[] = [
  { id: 'hosts', label: 'Host commands and access changes', short: 'For host commands and access changes', text: 'a person applies root commands on nodes and changes to users, roles, tokens, node shells, package sources and cluster membership. Agents apply everything else. This is the default.' },
  { id: 'all', label: 'Every change', short: 'For every change', text: 'apply tokens work like draft tokens.' },
  { id: 'always', label: 'Nothing, always allow', short: 'Off, always allow', text: 'agents apply every change themselves, limited only by their user\u2019s PVE permissions.' },
];

function AgentApprovalForm() {
  const { api } = useApp();
  const [rev, setRev] = useState(0);
  const saved = useAsync(() => api.agentPolicy(), `agent-policy|${rev}`);
  const [pick, setPick] = useState<AgentApproval | null>(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => { if (saved.data) { setPick(saved.data.approval); setSure(false); } }, [saved.data]);

  if (saved.error) return <ApiErrorView error={saved.error} what="the agent approval setting" onRetry={saved.reload} />;
  if (!saved.data || !pick) return <div className="panel"><div className="muted panel-body" role="status">Loading the agent approval setting</div></div>;

  const orig = saved.data.approval;
  const loosening = pick === 'always' && orig !== 'always';
  const choose = (v: AgentApproval) => { setPick(v); setSure(false); setOk(null); setErr(null); };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loosening && !sure) return;
    setBusy(true); setErr(null); setOk(null);
    try {
      await api.putAgentPolicy({ approval: pick });
      setOk('Saved. It applies to every agent token from now on.');
      setRev((r) => r + 1);
    } catch (e2) {
      setErr(`Could not save: ${errMsg(e2)}`);
    } finally { setBusy(false); }
  };

  return (
    <form className="panel" onSubmit={save} aria-labelledby="aa-h">
      <div className="panel-head"><h2 id="aa-h">Agent approval</h2><span className="muted">{APPROVALS.find((a) => a.id === orig)?.short}</span></div>
      <div className="panel-body form-stack settings-form">
        <fieldset className="field fieldset">
          <legend className="label">What agent tokens with the apply scope need a person for</legend>
          {APPROVALS.map((a) => (
            <label key={a.id} className="check choice-line">
              <input type="radio" name="agent-approval" checked={pick === a.id} onChange={() => choose(a.id)} />
              <span><strong>{a.label}:</strong><span className="ws"> {a.text}</span></span>
            </label>
          ))}
          <span className="hint">What an agent may not apply waits in Changes for its user, for 24 hours. Agents can never change this setting.</span>
        </fieldset>
        {loosening && (
          <div className="notice notice-warn" role="note">
            <div className="grow">
              Agents would run root commands on nodes and change who has access, with nobody reviewing them. An agent misled by text in a VM note could do the same.
              <label className="check" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
                I understand, let agents apply everything
              </label>
            </div>
          </div>
        )}
        {err && <div className="notice notice-error" role="alert"><div className="grow">{err}</div></div>}
        {ok && <div className="notice notice-ok" role="status"><div className="grow">{ok}</div></div>}
        <div className="row-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || pick === orig || (loosening && !sure)}>{busy ? 'Saving' : 'Save agent approval'}</button>
          <button type="button" className="btn" disabled={busy || pick === orig} onClick={() => choose(orig)}>Undo changes</button>
        </div>
      </div>
    </form>
  );
}

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

function FeedbackSettingsForm() {
  const { api, reloadFeedback } = useApp();
  const [rev, setRev] = useState(0);
  const saved = useAsync(() => api.feedback(), `feedback-settings|${rev}`);
  const [cfg, setCfg] = useState<FeedbackConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => { if (saved.data) setCfg(saved.data); }, [saved.data]);

  if (saved.error) return <ApiErrorView error={saved.error} what="the feedback settings" onRetry={saved.reload} />;
  if (!saved.data || !cfg) return <div className="panel"><div className="muted panel-body" role="status">Loading the feedback settings</div></div>;

  const orig = saved.data;
  const set = (p: Partial<FeedbackConfig>) => { setCfg((c) => ({ ...c!, ...p })); setOk(null); };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setOk(null);
    const repo = cfg.repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '');
    if (!REPO_RE.test(repo)) { setErr('Enter the repository as owner/name, for example JongoDB/pve-cookbook.'); return; }
    setBusy(true);
    try {
      await api.putFeedback({ enabled: cfg.enabled, repo });
      setOk(cfg.enabled ? `Saved. Send feedback opens new issues on ${repo}.` : 'Saved. Send feedback is hidden.');
      setRev((r) => r + 1);
      reloadFeedback();
    } catch (e2) {
      setErr(`Could not save: ${errMsg(e2)}`);
    } finally { setBusy(false); }
  };

  return (
    <form className="panel" onSubmit={save} aria-labelledby="fb-h">
      <div className="panel-head"><h2 id="fb-h">Feedback</h2><span className="muted">{orig.enabled ? `On, ${orig.repo}` : 'Off'}</span></div>
      <div className="panel-body form-stack settings-form">
        <label className="check">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Let users send feedback
        </label>
        <label className="field">
          <span className="label">GitHub repository</span>
          <input value={cfg.repo} onChange={(e) => set({ repo: e.target.value })} placeholder="owner/name" spellCheck={false} autoComplete="off" />
          <span className="hint">
            Send feedback opens a pre-filled new issue in this repository. Users review it and submit it from their own GitHub account; galley holds no GitHub credential and sends nothing itself.
          </span>
        </label>
        {err && <div className="notice notice-error" role="alert"><div className="grow">{err}</div></div>}
        {ok && <div className="notice notice-ok" role="status"><div className="grow">{ok}</div></div>}
        <div className="row-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving' : 'Save feedback settings'}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => { setCfg(orig); setErr(null); setOk(null); }}>Undo changes</button>
        </div>
      </div>
    </form>
  );
}
