import type { Guest, GuestTarget } from '../api/types';
import { guestStep, type GuestAction, type GuestParams } from './actions';

/**
 * Command-palette grammar (case-insensitive):
 *   start|shutdown|stop|reboot <guest>
 *   migrate <guest> <node>
 *   snapshot <guest> [name]
 *   destroy <guest>
 * <guest> is a VMID or a guest name. Names are matched exactly first, then by unique prefix.
 */
export type ParseResult =
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | {
      kind: 'command';
      action: GuestAction;
      guest: Guest;
      params: GuestParams;
      /** CLI preview shown in the palette before a server plan exists */
      preview: string;
    };

const VERBS: Record<string, GuestAction> = {
  start: 'guest.start',
  shutdown: 'guest.shutdown',
  stop: 'guest.stop',
  reboot: 'guest.reboot',
  migrate: 'guest.migrate',
  snapshot: 'guest.snapshot',
  snap: 'guest.snapshot',
  destroy: 'guest.destroy',
};

export function resolveGuest(ref: string, guests: Guest[]): Guest | { error: string } {
  const live = guests.filter((g) => !g.template);
  if (/^\d+$/.test(ref)) {
    const id = Number(ref);
    const m = live.filter((g) => g.vmid === id);
    if (m.length === 1) return m[0];
    if (m.length > 1) return { error: `VMID ${id} exists in ${m.length} clusters — use its name` };
    return { error: `no guest with VMID ${id}` };
  }
  const r = ref.toLowerCase();
  const exact = live.filter((g) => g.name.toLowerCase() === r);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return { error: `"${ref}" matches ${exact.length} guests — use the VMID` };
  const pre = live.filter((g) => g.name.toLowerCase().startsWith(r));
  if (pre.length === 1) return pre[0];
  if (pre.length > 1) return { error: `"${ref}" is ambiguous: ${pre.slice(0, 4).map((g) => g.name).join(', ')}…` };
  return { error: `no guest named "${ref}"` };
}

/** nodesByCluster: clusterId → node names (used to validate migrate targets). */
export function parseCommand(input: string, guests: Guest[], nodesByCluster: Record<string, string[]> = {}): ParseResult {
  const words = input.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { kind: 'none' };
  const action = VERBS[words[0].toLowerCase()];
  if (!action) return { kind: 'none' };
  if (words.length < 2) return { kind: 'error', message: `${words[0]} what? e.g. "${words[0]} 120"` };

  const g = resolveGuest(words[1], guests);
  if ('error' in g) return { kind: 'error', message: g.error };
  const t: GuestTarget = { vmid: g.vmid, node: g.node, type: g.type };
  const params: GuestParams = {};

  if (action === 'guest.migrate') {
    const target = words[2];
    if (!target) return { kind: 'error', message: `migrate ${words[1]} to which node?` };
    const nodes = nodesByCluster[g.clusterId];
    if (nodes && !nodes.includes(target)) return { kind: 'error', message: `no node "${target}" in this cluster` };
    if (target === g.node) return { kind: 'error', message: `${g.name} is already on ${target}` };
    params.target = target;
    params.online = g.type === 'qemu' && g.status === 'running';
  } else if (action === 'guest.snapshot') {
    const name = words[2] ?? `galley-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    if (!/^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(name)) {
      return { kind: 'error', message: 'snapshot names: letter first, then letters, digits, - or _' };
    }
    params.name = name;
  } else if (words.length > 2) {
    return { kind: 'error', message: `unexpected "${words.slice(2).join(' ')}"` };
  }

  return { kind: 'command', action, guest: g, params, preview: guestStep(action, t, params).cli };
}
