import { useMemo, useState } from 'react';
import type { SchemaParam } from '../api/types';
import { useApp } from '../state/app';
import { useAsync } from '../lib/hooks';
import {
  checkValue, diffBody, isRequired, joinProps, keyOrder, methodParams, nextFreeIndex, paramFor, propFormat,
  pveshCli, splitProps, toFormValue, type Body, type MethodParams, type PropFormat,
} from '../lib/schemaForm';
import { ApiErrorView } from './ClusterLogin';

export interface ResourceEditorProps {
  clusterId: string;
  /** a concrete API path, e.g. /nodes/pve1/qemu/300/config */
  path: string;
  method: 'POST' | 'PUT' | 'DELETE';
  /** title of the change (defaults to the method's description) */
  title?: string;
  /** keys shown at first; others can be added. Default: every key the resource has set (PUT) or the required ones (POST). */
  keys?: string[];
  /** open with a new member of this indexed family added (e.g. "net" → net2) */
  addFamily?: string;
  /** starting values (create forms, e.g. a PCI mapping prefilled from a device) */
  initial?: Record<string, string>;
  /** heading shown above the fields */
  heading?: string;
  onCancel?: () => void;
  onSubmitted?: () => void;
}

/**
 * Edits any PVE API resource from its schema. PUT on a path with a GET is prefilled from the
 * current values and sends only what changed (removals go into `delete`, `digest` guards against
 * concurrent edits). Submitting opens an api.call change in Changes; nothing runs until it is applied.
 */
export function ResourceEditor(p: ResourceEditorProps) {
  const { api } = useApp();
  const schema = useAsync(() => api.schema(p.clusterId, p.path), `schema|${p.clusterId}|${p.path}`);
  const info = schema.data?.info[p.method];
  const hasGet = !!schema.data?.info.GET;
  const update = p.method === 'PUT' && hasGet;
  const current = useAsync<Record<string, unknown> | null>(
    schema.data && update ? async () => {
      const d = await api.pve<unknown>(p.clusterId, p.path);
      return d && typeof d === 'object' && !Array.isArray(d) ? d as Record<string, unknown> : null;
    } : null,
    `cur|${p.clusterId}|${p.path}|${update}`,
  );

  if (schema.error) return <ApiErrorView error={schema.error} clusterId={p.clusterId} onRetry={schema.reload} what="the API schema" />;
  if (current.error) return <ApiErrorView error={current.error} clusterId={p.clusterId} onRetry={current.reload} what="the current values" />;
  if (!schema.data || (update && current.data === null && current.loading)) return <div className="muted" role="status">Loading the form</div>;
  if (!info) return <div className="notice notice-error"><div className="grow">{p.method} is not available on {schema.data.path}.</div></div>;

  const initial: Record<string, string> = {};
  for (const [k, v] of Object.entries(current.data ?? {})) initial[k] = toFormValue(v);
  return (
    <EditorForm {...p} mp={methodParams(info, schema.data.vars)} initial={initial} mode={update ? 'update' : 'create'}
      prefill={p.initial ?? {}} description={info.description ?? ''} template={schema.data.path} />
  );
}

interface FormProps extends ResourceEditorProps {
  mp: MethodParams;
  initial: Record<string, string>;
  prefill: Record<string, string>;
  mode: 'create' | 'update';
  description: string;
  template: string;
}

function EditorForm(p: FormProps) {
  const { openPlan } = useApp();
  const { mp, initial, mode } = p;
  const known = (k: string) => !!paramFor(mp, k);

  const [edits, setEdits] = useState<Record<string, string>>(() => ({ ...p.prefill }));
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [visible, setVisible] = useState<string[]>(() => {
    let v: string[];
    if (p.keys) v = p.keys.filter(known);
    else if (mode === 'update') v = Object.keys(initial).filter(known);
    else v = Object.keys(mp.plain).filter((k) => isRequired(mp.plain[k]));
    for (const k of Object.keys(p.prefill)) if (!v.includes(k) && known(k)) v.push(k);
    for (const k of Object.keys(mp.plain)) if (isRequired(mp.plain[k]) && !v.includes(k)) v.push(k);
    if (p.addFamily && mp.families[p.addFamily]) {
      const i = nextFreeIndex(p.addFamily, [...Object.keys(initial), ...v]);
      if (i !== null) v.push(`${p.addFamily}${i}`);
    }
    return v;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formErr, setFormErr] = useState<string | null>(null);
  const [adding, setAdding] = useState('');

  const value = (k: string) => edits[k] ?? initial[k] ?? '';
  const set = (k: string, v: string) => { setEdits((e) => ({ ...e, [k]: v })); setErrors((x) => { const n = { ...x }; delete n[k]; return n; }); };
  const isNew = (k: string) => initial[k] === undefined;

  const body: Body = useMemo(
    () => diffBody({ initial, edits: Object.fromEntries(Object.entries(edits).filter(([k]) => visible.includes(k))), removed, mode, hasDigest: mp.hasDigest, hasDelete: mp.hasDelete }),
    [initial, edits, removed, mode, mp, visible],
  );
  const path = p.path;

  const addable = Object.keys(mp.plain).filter((k) => !visible.includes(k)).sort();
  // A focused edit (keys given) offers only the families it is about; the full editor offers all.
  const focus = p.keys ? new Set([...p.keys, ...(p.addFamily ? [`${p.addFamily}0`] : [])].map((k) => /^([a-z_-]+?)\d+$/.exec(k)?.[1]).filter(Boolean)) : null;
  const families = Object.keys(mp.families).filter((f) => f !== 'unused' && (!focus || focus.has(f)));
  const allKeys = [...Object.keys(initial), ...visible];

  const addKey = (k: string) => { if (k && !visible.includes(k)) setVisible((v) => [...v, k]); setRemoved((r) => { const n = new Set(r); n.delete(k); return n; }); };
  const addFamily = (f: string) => { const i = nextFreeIndex(f, allKeys); if (i !== null) addKey(`${f}${i}`); };
  const remove = (k: string) => {
    if (mode === 'update' && !isNew(k)) setRemoved((r) => new Set(r).add(k));
    else { setVisible((v) => v.filter((x) => x !== k)); setEdits((e) => { const n = { ...e }; delete n[k]; return n; }); }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    for (const k of visible) {
      if (removed.has(k)) continue;
      const prm = paramFor(mp, k);
      if (!prm) continue;
      const v = value(k);
      if (v === '' && isRequired(prm)) { errs[k] = 'required'; continue; }
      if (edits[k] !== undefined) { const msg = checkValue(prm, v); if (msg) errs[k] = msg; }
    }
    setErrors(errs);
    if (Object.keys(errs).length) { setFormErr(`Fix ${Object.keys(errs).length === 1 ? 'the field' : `${Object.keys(errs).length} fields`} marked below.`); return; }
    if (mode === 'update' && !Object.keys(body).filter((k) => k !== 'digest').length) { setFormErr('Nothing changed yet.'); return; }
    if (body.delete && !mp.hasDelete) { setFormErr('This API method cannot remove settings.'); return; }
    setFormErr(null);
    const title = p.title ?? `${p.method === 'POST' ? 'Create' : p.method === 'DELETE' ? 'Delete' : 'Change'} ${path}`;
    void openPlan({ action: 'api.call', clusterId: p.clusterId, params: { title, calls: [{ method: p.method, path, body }] } });
    p.onSubmitted?.();
  };

  const shown = visible.slice().sort((a, b) => Number(isRequired(paramFor(mp, b))) - Number(isRequired(paramFor(mp, a))) || keyOrder(a, b));

  return (
    <form className="editor" onSubmit={submit} noValidate>
      {p.heading && <h3 className="editor-heading">{p.heading}</h3>}
      <p className="explain">{p.description.split('\n')[0]} <span className="mono">{p.method} {path}</span></p>
      {shown.length === 0 && <p className="muted small">No fields yet. Add a setting below.</p>}
      {shown.map((k) => {
        const prm = paramFor(mp, k)!;
        const indexed = prm !== mp.plain[k];
        const canRemove = indexed || (!isRequired(prm) && (mode === 'create' || isNew(k)));
        const canReset = !indexed && mode === 'update' && !isNew(k) && mp.hasDelete && !isRequired(prm);
        return (
          <Field key={k} name={k} param={prm} value={value(k)} onChange={(v) => set(k, v)} error={errors[k]}
            removed={removed.has(k)} isNew={isNew(k)} mode={mode}
            onRemove={canRemove ? () => remove(k) : undefined} onReset={canReset ? () => set(k, '') : undefined}
            onRestore={() => setRemoved((r) => { const n = new Set(r); n.delete(k); return n; })} />
        );
      })}

      <div className="editor-add">
        {families.map((f) => (
          <button key={f} type="button" className="btn btn-sm" onClick={() => addFamily(f)} disabled={nextFreeIndex(f, allKeys) === null}>
            Add {f} {familyNoun(f)}
          </button>
        ))}
        {addable.length > 0 && (
          <span className="editor-add-setting">
            <label className="sr-only" htmlFor={`add-${path}`}>Add a setting</label>
            <select id={`add-${path}`} value={adding} onChange={(e) => { addKey(e.target.value); setAdding(''); }}>
              <option value="">Add a setting</option>
              {addable.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </span>
        )}
      </div>

      <div>
        <div className="section-label">Preview</div>
        <pre className="cli">{pveshCli(p.method, path, body)}</pre>
      </div>
      {formErr && <div className="notice notice-error" role="alert"><div className="grow">{formErr}</div></div>}
      <div className="row-actions">
        <button type="submit" className="btn btn-primary">Review change</button>
        {p.onCancel && <button type="button" className="btn" onClick={p.onCancel}>Cancel</button>}
        <span className="muted small">Opens in Changes. Nothing runs until you apply it.</span>
      </div>
    </form>
  );
}

const familyNoun = (f: string) => ({ net: 'device', scsi: 'disk', virtio: 'disk', sata: 'disk', ide: 'drive', hostpci: 'device', mp: 'mount point', ipconfig: 'config', usb: 'device', serial: 'port', dev: 'device' } as Record<string, string>)[f] ?? 'entry';

interface FieldProps {
  name: string; param: SchemaParam; value: string; onChange: (v: string) => void; error?: string;
  removed: boolean; isNew: boolean; mode: 'create' | 'update';
  onRemove?: () => void; onReset?: () => void; onRestore: () => void;
}

function Field({ name, param, value, onChange, error, removed, isNew, mode, onRemove, onReset, onRestore }: FieldProps) {
  const id = `f-${name}`;
  const req = isRequired(param);
  const help = (param.description ?? '').split('\n')[0];
  const fmt = propFormat(param);
  const [raw, setRaw] = useState(false);
  const parts = fmt ? splitProps(value, fmt) : null;
  return (
    <div className={`efield${removed ? ' removed' : ''}${error ? ' invalid' : ''}`}>
      <div className="efield-head">
        <label htmlFor={id} className="mono">{name}</label>
        {req ? <span className="muted small">required</span> : null}
        {mode === 'update' && isNew && <span className="badge badge-info">New</span>}
        {removed && <span className="badge badge-crit">Removed</span>}
        <span className="spacer" />
        {fmt && parts && !removed && <button type="button" className="link-btn small" onClick={() => setRaw((r) => !r)}>{raw ? 'Edit as fields' : 'Edit as text'}</button>}
        {removed ? <button type="button" className="link-btn small" onClick={onRestore}>Keep</button>
          : onRemove ? <button type="button" className="link-btn small" onClick={onRemove}>Remove</button>
            : onReset && value !== '' ? <button type="button" className="link-btn small" onClick={onReset} title="Removes the setting so PVE uses its default">Use default</button> : null}
      </div>
      {!removed && (fmt && parts && !raw
        ? <PropFields id={id} fmt={fmt} parts={parts} onChange={(v) => onChange(joinProps(v, fmt))} />
        : <Control id={id} param={param} value={value} onChange={onChange} />)}
      {help && <div className="hint">{help}{param.typetext && fmt && (!parts || raw) ? <div className="mono">{param.typetext}</div> : null}</div>}
      {error && <div className="tone-crit small" role="alert">{name}: {error}</div>}
    </div>
  );
}

function Control({ id, param, value, onChange }: { id: string; param: SchemaParam; value: string; onChange: (v: string) => void }) {
  const dflt = param.default !== undefined ? toFormValue(param.default) : '';
  if (param.type === 'boolean') {
    const on = (value || dflt) === '1';
    return (
      <label className="check" htmlFor={id}>
        <input id={id} type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? '1' : '0')} />
        {on ? 'Yes' : 'No'}{value === '' && dflt !== '' ? <span className="muted small"> (default)</span> : null}
      </label>
    );
  }
  if (param.enum) {
    return (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{dflt ? `Default (${dflt})` : 'Not set'}</option>
        {param.enum.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    );
  }
  if (param.type === 'integer' || param.type === 'number') {
    return (
      <input id={id} type="number" inputMode={param.type === 'integer' ? 'numeric' : 'decimal'} value={value} min={param.minimum} max={param.maximum}
        step={param.type === 'integer' ? 1 : 'any'} placeholder={dflt ? `default ${dflt}` : ''} onChange={(e) => onChange(e.target.value)} />
    );
  }
  const long = (param.maxLength ?? 0) > 512 || /description|sshkeys|public-keys/.test(id);
  return long
    ? <textarea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
    : <input id={id} value={value} placeholder={dflt ? `default ${dflt}` : param.typetext ?? ''} onChange={(e) => onChange(e.target.value)} spellCheck={false} autoComplete="off" />;
}

/** A property string ("virtio,bridge=vmbr0,tag=20") as one small field per sub-key. */
function PropFields({ id, fmt, parts, onChange }: { id: string; fmt: PropFormat; parts: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  return (
    <div className="prop-grid" id={id}>
      {Object.entries(fmt).map(([k, prm]) => (
        <div key={k} className="field">
          <label className="label mono" htmlFor={`${id}-${k}`} title={(prm.description ?? '').split('\n')[0]}>{k}</label>
          <Control id={`${id}-${k}`} param={prm} value={parts[k] ?? ''} onChange={(v) => onChange({ ...parts, [k]: v })} />
        </div>
      ))}
    </div>
  );
}
