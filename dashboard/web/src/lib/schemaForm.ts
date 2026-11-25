// Pure logic behind the schema-driven resource editor: which fields a PVE API method takes,
// how indexed families (net[n], scsi[n], hostpci[n]) expand, how property strings split into
// sub-fields, and which body an edit produces (changed keys only, removals in `delete`).
import type { SchemaMethod, SchemaParam } from '../api/types';

/** galley's api.call body is map[string]string; every value goes over the wire as a string. */
export type Body = Record<string, string>;

/** Parameters handled by the editor itself rather than shown as fields. */
export const CONTROL_KEYS = new Set(['digest', 'delete', 'revert']);

export const familyOf = (name: string): string | null => /^(.+)\[n\]$/.exec(name)?.[1] ?? null;

/** Highest index + 1 PVE accepts per family; unknown families get 32. */
const FAMILY_MAX: Record<string, number> = {
  net: 32, scsi: 31, virtio: 16, sata: 6, ide: 4, hostpci: 16, usb: 14, serial: 4, parallel: 3, ipconfig: 32,
  numa: 8, unused: 256, mp: 256, dev: 256, virtiofs: 10, link: 8, ring: 8,
};
export const familyMax = (prefix: string) => FAMILY_MAX[prefix] ?? 32;

export interface MethodParams {
  /** plain parameters, path variables and control keys removed */
  plain: Record<string, SchemaParam>;
  /** indexed families by prefix ("net" for "net[n]") */
  families: Record<string, SchemaParam>;
  hasDigest: boolean;
  hasDelete: boolean;
}

export function methodParams(m: SchemaMethod | undefined, vars: Record<string, string>): MethodParams {
  const props = m?.parameters?.properties ?? {};
  const plain: Record<string, SchemaParam> = {};
  const families: Record<string, SchemaParam> = {};
  for (const [k, p] of Object.entries(props)) {
    if (k in vars || CONTROL_KEYS.has(k)) continue;
    const f = familyOf(k);
    if (f) families[f] = p; else plain[k] = p;
  }
  return { plain, families, hasDigest: 'digest' in props, hasDelete: 'delete' in props };
}

/** The schema for a concrete body key: "net3" → the "net[n]" parameter. */
export function paramFor(mp: MethodParams, key: string): SchemaParam | undefined {
  if (mp.plain[key]) return mp.plain[key];
  const m = /^([a-z_-]+?)(\d+)$/.exec(key);
  return m ? mp.families[m[1]] : undefined;
}

export const isRequired = (p: SchemaParam | undefined) => !!p && !p.optional;

/** Keys of a family present in a config, in index order: ["net0","net1"]. */
export function familyKeys(prefix: string, keys: Iterable<string>): string[] {
  const re = new RegExp(`^${prefix.replace(/[-]/g, '\\-')}(\\d+)$`);
  return [...keys].filter((k) => re.test(k)).sort((a, b) => Number(re.exec(a)![1]) - Number(re.exec(b)![1]));
}

/** Lowest free index of a family, or null when every slot is taken. */
export function nextFreeIndex(prefix: string, used: Iterable<string>, max = familyMax(prefix)): number | null {
  const taken = new Set(familyKeys(prefix, used).map((k) => Number(k.slice(prefix.length))));
  for (let i = 0; i < max; i++) if (!taken.has(i)) return i;
  return null;
}

/** A config value as the form shows it. Booleans become "1"/"0". */
export function toFormValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v);
}

/** Error text for one value, or null when it fits the parameter. Empty means unset. */
export function checkValue(p: SchemaParam, v: string): string | null {
  if (v === '') return null;
  switch (p.type) {
    case 'boolean':
      return v === '0' || v === '1' ? null : 'must be yes or no';
    case 'integer':
    case 'number': {
      if (p.type === 'integer' ? !/^-?\d+$/.test(v) : !Number.isFinite(Number(v))) return p.type === 'integer' ? 'must be a whole number' : 'must be a number';
      const n = Number(v);
      if (p.minimum !== undefined && n < p.minimum) return `must be at least ${p.minimum}`;
      if (p.maximum !== undefined && n > p.maximum) return `must be at most ${p.maximum}`;
      return null;
    }
    default:
      if (p.enum && !p.enum.includes(v)) return `must be one of ${p.enum.join(', ')}`;
      if (p.maxLength && v.length > p.maxLength) return `at most ${p.maxLength} characters`;
      if (p.pattern) {
        try { if (!new RegExp(`^(?:${p.pattern})$`).test(v)) return `must match ${p.pattern}`; } catch { /* PVE pattern JS cannot compile */ }
      }
      return null;
  }
}

export interface DiffInput {
  /** the current configuration (GET), as form strings */
  initial: Record<string, string>;
  /** values the admin changed (only touched keys) */
  edits: Record<string, string>;
  /** keys the admin removed (indexed devices, or options set back to default) */
  removed: Iterable<string>;
  mode: 'create' | 'update';
  /** schema of the method: digest and delete are sent only when it has them */
  hasDigest?: boolean;
  hasDelete?: boolean;
}

/**
 * The body for the change. Update: only keys whose value differs from the current one; keys
 * removed or cleared go into `delete` (comma separated); `digest` from the current config guards
 * against concurrent edits. Create: every non-empty value.
 */
export function diffBody(d: DiffInput): Body {
  const body: Body = {};
  const del: string[] = [];
  const removed = new Set(d.removed);
  for (const [k, v] of Object.entries(d.edits)) {
    if (removed.has(k)) continue;
    if (d.mode === 'create') { if (v !== '') body[k] = v; continue; }
    const before = d.initial[k];
    if (v === '') { if (before !== undefined && before !== '') del.push(k); continue; }
    if (v !== before) body[k] = v;
  }
  if (d.mode === 'update') {
    for (const k of removed) if (d.initial[k] !== undefined && !del.includes(k)) del.push(k);
    if (del.length) body.delete = del.sort(keyOrder).join(',');
    if (d.hasDigest !== false && d.initial.digest && Object.keys(body).length) body.digest = d.initial.digest;
  }
  return body;
}

/** "net2" < "net10"; plain keys alphabetically. */
export function keyOrder(a: string, b: string): number {
  const ma = /^(.*?)(\d+)$/.exec(a);
  const mb = /^(.*?)(\d+)$/.exec(b);
  if (ma && mb && ma[1] === mb[1]) return Number(ma[2]) - Number(mb[2]);
  return a.localeCompare(b);
}

// ---- property strings ("virtio,bridge=vmbr0,tag=20") ----

export type PropFormat = Record<string, SchemaParam & { default_key?: number; alias?: string }>;

/** A parameter's property-string format, when PVE describes one (format is an object of sub-parameters). */
export function propFormat(p: SchemaParam | undefined): PropFormat | null {
  const f = p?.format;
  return f && typeof f === 'object' && !Array.isArray(f) ? (f as PropFormat) : null;
}

const defaultKey = (f: PropFormat) => Object.keys(f).find((k) => f[k].default_key);

/**
 * Split a property string into sub-values by the format. Returns null when the value uses keys
 * the format does not know (the editor then falls back to raw text). The legacy qemu NIC form
 * "virtio=BC:24:…" (model as key, MAC as value) is understood.
 */
export function splitProps(value: string, f: PropFormat): Record<string, string> | null {
  const out: Record<string, string> = {};
  const dk = defaultKey(f);
  for (const part of value.split(',')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i < 0) {
      if (!dk || dk in out) return null;
      out[dk] = part;
      continue;
    }
    const k = part.slice(0, i);
    const v = part.slice(i + 1);
    if (k in f) { out[k] = v; continue; }
    if (dk && f[dk].enum?.includes(k) && 'macaddr' in f) { out[dk] = k; out.macaddr = v; continue; }
    return null;
  }
  return out;
}

/** Compose sub-values back: the default key first without a name, the rest in format order. */
export function joinProps(values: Record<string, string>, f: PropFormat): string {
  const dk = defaultKey(f);
  const parts: string[] = [];
  if (dk && values[dk]) parts.push(values[dk]);
  for (const k of Object.keys(f)) if (k !== dk && values[k] !== undefined && values[k] !== '') parts.push(`${k}=${values[k]}`);
  for (const k of Object.keys(values)) if (!(k in f) && values[k] !== '') parts.push(`${k}=${values[k]}`);
  return parts.join(',');
}

// ---- pvesh preview ----

const SAFE_ARG = /^[A-Za-z0-9_./:=,@%+-]+$/;
const SENSITIVE = /(pass(word)?|secret|token|privkey|private-?key|api-?key|psk)$|^(value|key|keyring)$/i;
export const shellQuote = (v: string) => (v !== '' && SAFE_ARG.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);

/** The same text galley's backend shows for a call (internal/schema.CLI). */
export function pveshCli(method: string, path: string, body: Body = {}): string {
  const verb = ({ GET: 'get', POST: 'create', PUT: 'set', DELETE: 'delete' } as Record<string, string>)[method.toUpperCase()] ?? method.toLowerCase();
  const args = Object.keys(body).sort().map((k) => ` --${k} ${SENSITIVE.test(k) ? "'<redacted>'" : shellQuote(body[k])}`);
  return `pvesh ${verb} ${path}${args.join('')}`;
}

/** Fill a template path with values: /nodes/{node}/qemu → /nodes/pve1/qemu. Null while any is missing. */
export function fillPath(template: string, vars: Record<string, string>): string | null {
  let missing = false;
  const p = template.replace(/\{([^}]+)\}/g, (_, k: string) => {
    const v = (vars[k] ?? '').trim();
    if (!v || /[/?#%\s]/.test(v)) missing = true;
    return v;
  });
  return missing ? null : p;
}

export const pathVars = (template: string) => [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);

/**
 * PVE's method descriptions are written for API developers ("Set virtual
 * machine options (synchronous API) - You should consider using the POST
 * method instead…"). Keep the first plain sentence for people.
 */
export function plainDescription(d: string | undefined): string {
  let s = (d ?? '').split('\n')[0].trim();
  s = s.replace(/\s*\((a)?synchronous API\)/i, '');
  s = s.split(/\s+-\s+|\.\s+/)[0].trim();
  return s.replace(/\.$/, '');
}
