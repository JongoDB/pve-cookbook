import { useSearchParams } from 'react-router-dom';
import { useApp } from '../state/app';

/**
 * The cluster a page works on, kept in the URL (?cluster=) so links and reloads keep it.
 * Defaults to the first cluster this session is logged in to (or, with `prefer`, the first matching one).
 */
export function useClusterParam(prefer?: (c: { id: string; authed: boolean; admin?: boolean }) => boolean): [string, (id: string) => void] {
  const { me } = useApp();
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get('cluster') ?? '';
  const fallback = (prefer && me.clusters.find((c) => c.authed && prefer(c))) ?? me.clusters.find((c) => c.authed) ?? me.clusters[0];
  const id = me.clusters.some((c) => c.id === fromUrl) ? fromUrl : fallback?.id ?? '';
  const set = (v: string) => { const p = new URLSearchParams(params); p.set('cluster', v); setParams(p, { replace: true }); };
  return [id, set];
}

export function ClusterPicker({ value, onChange, label = 'Cluster', filter }: {
  value: string; onChange: (id: string) => void; label?: string; filter?: (c: { id: string; authed: boolean; admin?: boolean }) => boolean;
}) {
  const { me } = useApp();
  const list = filter ? me.clusters.filter(filter) : me.clusters;
  if (list.length <= 1) return null;
  return (
    <label className="field inline">
      <span className="label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {list.map((c) => <option key={c.id} value={c.id}>{c.name}{c.authed ? '' : ' (log in first)'}</option>)}
      </select>
    </label>
  );
}
