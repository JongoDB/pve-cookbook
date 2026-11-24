import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/http';
import type { SchemaMethod, SchemaParam } from '../api/types';
import { errMsg, useApp, useCrumbs } from '../state/app';
import { useAsync } from '../lib/hooks';
import { score } from '../lib/fuzzy';
import { fillPath, pathVars, pveshCli } from '../lib/schemaForm';
import { ApiErrorView } from '../components/ClusterLogin';
import { ClusterPicker, useClusterParam } from '../components/ClusterPicker';
import { ResourceEditor } from '../components/ResourceEditor';
import { CopyButton, Empty } from '../components/ui';

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'DELETE'];

/** PVE permission objects ({check:[…], description, user}) as one readable line. */
function describePermissions(p?: Record<string, unknown>): { text: string; check?: string } {
  if (!p) return { text: 'Not documented.' };
  const desc = typeof p.description === 'string' ? p.description : '';
  const user = p.user === 'all' ? 'Any authenticated user.' : p.user === 'world' ? 'Anyone, without logging in.' : '';
  const check = Array.isArray(p.check) && p.check.length ? JSON.stringify(p.check) : undefined;
  return { text: desc || user || (check ? 'PVE checks:' : 'Accessible by all authenticated users.'), check };
}

export function ApiExplorer() {
  useCrumbs([{ label: 'API' }]);
  const { api, me, fleet } = useApp();
  const [cluster, setCluster] = useClusterParam();
  const [params, setParams] = useSearchParams();
  const selected = params.get('path') ?? '';
  const method = (params.get('method') ?? '').toUpperCase();
  const [q, setQ] = useState(params.get('q') ?? '');
  const authed = !!me.clusters.find((c) => c.id === cluster)?.authed;
  const paths = useAsync(authed ? () => api.schemaPaths(cluster) : null, `paths|${cluster}|${authed}`);

  const results = useMemo(() => {
    const all = paths.data ?? [];
    if (!q.trim()) return all.slice(0, 200);
    return all
      .map((p) => ({ p, s: Math.max(score(q, p.path), score(q, Object.values(p.methods).join(' ')) - 100) }))
      .filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 200).map((x) => x.p);
  }, [paths.data, q]);

  const choose = (path: string, m?: string) => {
    const p = new URLSearchParams(params);
    p.set('path', path);
    const methods = paths.data?.find((x) => x.path === path)?.methods ?? {};
    p.set('method', m ?? METHOD_ORDER.find((x) => x in methods) ?? 'GET');
    setParams(p, { replace: true });
  };

  const nodes = fleet?.clusters.find((c) => c.id === cluster)?.nodes.map((n) => n.name) ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <h1>API</h1>
        <ClusterPicker value={cluster} onChange={(id) => { setCluster(id); }} />
        <div className="sub">Every path of this cluster&apos;s PVE API, from its own schema. Reads run as you; changes open in Changes for review.</div>
      </div>
      {!authed ? <ApiErrorView error={new ApiError(409, 'cluster_login_required', '')} clusterId={cluster} /> : (
        <div className="explorer">
          <section className="panel explorer-list" aria-label="API paths">
            <div className="panel-body">
              <label className="sr-only" htmlFor="api-q">Search API paths</label>
              <input id="api-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search paths and descriptions, e.g. qemu config" style={{ width: '100%' }} autoComplete="off" />
            </div>
            {paths.error ? <div className="panel-body"><ApiErrorView error={paths.error} clusterId={cluster} onRetry={paths.reload} what="the API schema" /></div>
              : !paths.data ? <div className="muted panel-body" role="status">Loading the API schema</div>
                : results.length === 0 ? <Empty title="No matching path">Try a resource name such as storage, firewall or ha.</Empty> : (
                  <ul className="path-list">
                    {results.map((p) => (
                      <li key={p.path}>
                        <button type="button" className={`path-item${p.path === selected ? ' sel' : ''}`} aria-current={p.path === selected ? 'true' : undefined} onClick={() => choose(p.path)}>
                          <span className="mono path">{p.path}</span>
                          <span className="methods">{METHOD_ORDER.filter((m) => m in p.methods).map((m) => <span key={m} className={`meth meth-${m.toLowerCase()}`}>{m}</span>)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
            {paths.data && <div className="panel-body muted small">{q ? `${results.length} of ${paths.data.length} paths` : `${paths.data.length} paths`}</div>}
          </section>
          <section className="explorer-detail" aria-label="Selected path">
            {selected
              ? <PathDetail key={`${cluster}|${selected}`} cluster={cluster} template={selected} method={method} nodes={nodes} onMethod={(m) => choose(selected, m)} />
              : <div className="panel"><Empty title="Pick a path">Search on the left, then choose a method. GET shows the live answer; POST, PUT and DELETE build a change you review before it runs.</Empty></div>}
          </section>
        </div>
      )}
    </div>
  );
}

function PathDetail({ cluster, template, method, nodes, onMethod }: { cluster: string; template: string; method: string; nodes: string[]; onMethod: (m: string) => void }) {
  const { api } = useApp();
  const info = useAsync(() => api.schema(cluster, template), `schema|${cluster}|${template}`);
  const vars = pathVars(template);
  const [values, setValues] = useState<Record<string, string>>(() => (vars.includes('node') && nodes[0] ? { node: nodes[0] } : {}) as Record<string, string>);
  const concrete = fillPath(template, values);

  if (info.error) return <ApiErrorView error={info.error} clusterId={cluster} onRetry={info.reload} what="this path" />;
  if (!info.data) return <div className="panel"><div className="muted panel-body" role="status">Loading the path</div></div>;
  const methods = METHOD_ORDER.filter((m) => m in info.data!.info);
  const m: SchemaMethod | undefined = info.data.info[method] ?? info.data.info[methods[0]];
  const cur = m?.method ?? methods[0];
  const perms = describePermissions(m?.permissions);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="mono" style={{ fontSize: 14 }}>{template}</h2>
        <div className="seg" role="group" aria-label="Method">
          {methods.map((x) => <button key={x} type="button" aria-pressed={x === cur} onClick={() => onMethod(x)}>{x}</button>)}
        </div>
      </div>
      <div className="panel-body form-stack">
        {m?.description && <p className="text-2" style={{ whiteSpace: 'pre-line' }}>{m.description}</p>}
        <div>
          <div className="section-label">Permissions</div>
          <p className="small">{perms.text}</p>
          {perms.check && <code className="perm-check">{perms.check}</code>}
        </div>
        {vars.length > 0 && (
          <div className="form-row">
            {vars.map((v) => (
              <label key={v} className="field">
                <span className="label mono">{`{${v}}`}</span>
                {v === 'node' && nodes.length
                  ? <select value={values[v] ?? ''} onChange={(e) => setValues((x) => ({ ...x, [v]: e.target.value }))}>{nodes.map((n) => <option key={n} value={n}>{n}</option>)}</select>
                  : <input value={values[v] ?? ''} onChange={(e) => setValues((x) => ({ ...x, [v]: e.target.value.trim() }))} placeholder={v} spellCheck={false} autoComplete="off" />}
              </label>
            ))}
          </div>
        )}
        {!concrete ? <p className="muted small">Fill in {vars.filter((v) => !values[v]).map((v) => `{${v}}`).join(', ')} to continue.</p>
          : cur === 'GET' ? <GetRunner key={concrete} cluster={cluster} path={concrete} params={m?.parameters?.properties ?? {}} vars={vars} />
            : <ResourceEditor key={`${concrete}|${cur}`} clusterId={cluster} path={concrete} method={cur as 'POST' | 'PUT' | 'DELETE'} />}
        {m?.returns?.type && <p className="muted small">Returns: <span className="mono">{m.returns.type}</span></p>}
      </div>
    </div>
  );
}

function GetRunner({ cluster, path, params, vars }: { cluster: string; path: string; params: Record<string, SchemaParam>; vars: string[] }) {
  const { api } = useApp();
  const queryKeys = Object.keys(params).filter((k) => !vars.includes(k));
  const [query, setQuery] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: true; text: string } | { ok: false; error: unknown } | null>(null);
  useEffect(() => { setResult(null); }, [path]);
  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const q = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''));
      const d = await api.pve<unknown>(cluster, path, q);
      setResult({ ok: true, text: JSON.stringify(d, null, 2) ?? 'null' });
    } catch (err) {
      setResult({ ok: false, error: err });
    } finally { setBusy(false); }
  };
  const cli = pveshCli('GET', path, Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '')));
  return (
    <form className="form-stack" onSubmit={run}>
      {queryKeys.length > 0 && (
        <details>
          <summary className="small">Query parameters ({queryKeys.length})</summary>
          <div className="form-row" style={{ marginTop: 10 }}>
            {queryKeys.map((k) => (
              <label key={k} className="field" title={params[k].description}>
                <span className="label mono">{k}</span>
                {params[k].type === 'boolean'
                  ? <select value={query[k] ?? ''} onChange={(e) => setQuery((x) => ({ ...x, [k]: e.target.value }))}><option value="">Not set</option><option value="1">1</option><option value="0">0</option></select>
                  : params[k].enum
                    ? <select value={query[k] ?? ''} onChange={(e) => setQuery((x) => ({ ...x, [k]: e.target.value }))}><option value="">Not set</option>{params[k].enum!.map((v) => <option key={v} value={v}>{v}</option>)}</select>
                    : <input value={query[k] ?? ''} onChange={(e) => setQuery((x) => ({ ...x, [k]: e.target.value }))} spellCheck={false} autoComplete="off" />}
              </label>
            ))}
          </div>
        </details>
      )}
      <pre className="cli">{cli}</pre>
      <div className="row-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Reading' : 'Read it now'}</button>
        <span className="muted small">A read through your PVE session. It changes nothing.</span>
      </div>
      {result && (result.ok ? (
        <div className="form-stack" style={{ gap: 8 }}>
          <pre className="cli json-out" tabIndex={0} aria-label="Result">{result.text}</pre>
          <div><CopyButton text={result.text} label="Copy JSON" /></div>
        </div>
      ) : <div className="notice notice-error" role="alert"><div className="grow">PVE answered with an error: {errMsg(result.error)}</div></div>)}
    </form>
  );
}
