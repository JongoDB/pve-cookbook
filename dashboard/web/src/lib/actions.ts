import type { GuestTarget, Step } from '../api/types';

/** Guest actions galley can plan in the MVP (see api.md "MVP actions"). */
export const GUEST_ACTIONS = ['guest.start', 'guest.shutdown', 'guest.stop', 'guest.reboot', 'guest.migrate', 'guest.snapshot', 'guest.destroy'] as const;
export type GuestAction = (typeof GUEST_ACTIONS)[number];

export const ACTION_LABEL: Record<string, string> = {
  'guest.start': 'Start',
  'guest.shutdown': 'Shut down',
  'guest.stop': 'Stop (hard)',
  'guest.reboot': 'Reboot',
  'guest.migrate': 'Migrate',
  'guest.snapshot': 'Snapshot',
  'guest.destroy': 'Destroy',
  'backup.protect': 'Protect with backups',
};

const tool = (t: GuestTarget) => (t.type === 'qemu' ? 'qm' : 'pct');
const base = (t: GuestTarget) => `/nodes/${t.node}/${t.type}/${t.vmid}`;

export interface GuestParams { target?: string; online?: boolean; name?: string; description?: string }

/**
 * PREVIEW ONLY: the API steps (with CLI equivalents) galley's backend planner produces for one
 * guest, used by the command palette before a server plan exists (and by the mock API). The
 * server's plan is authoritative and is what runs. `running` is the guest's current state:
 * - destroy of a running guest: stop, then destroy --purge 1 --destroy-unreferenced-disks 1
 * - migrate: a running VM migrates --online, a running CT with --restart
 */
export function guestSteps(action: GuestAction, t: GuestTarget, p: GuestParams = {}, running?: boolean): Step[] {
  if (action === 'guest.destroy' && running) return [guestStep('guest.stop', t), guestStep(action, t, p, running)];
  return [guestStep(action, t, p, running)];
}

/** The CLI preview line for the palette: every step, in order. */
export const previewCli = (action: GuestAction, t: GuestTarget, p: GuestParams = {}, running?: boolean) =>
  guestSteps(action, t, p, running).map((s) => s.cli).join(' && ');

/** One API step (with its CLI equivalent) for one guest. See guestSteps: preview only. */
export function guestStep(action: GuestAction, t: GuestTarget, p: GuestParams = {}, running?: boolean): Step {
  const verb = action.slice('guest.'.length);
  switch (action) {
    case 'guest.start':
    case 'guest.shutdown':
    case 'guest.stop':
    case 'guest.reboot':
      return {
        description: `${ACTION_LABEL[action]} ${t.type === 'qemu' ? 'VM' : 'CT'} ${t.vmid} on ${t.node}`,
        method: 'POST', path: `${base(t)}/status/${verb}`, body: {},
        cli: `${tool(t)} ${verb} ${t.vmid}`,
      };
    case 'guest.migrate': {
      const target = p.target ?? '?';
      if (t.type === 'qemu') {
        const online = running ?? p.online !== false;
        return {
          description: `Migrate VM ${t.vmid} ${t.node} → ${target}${online ? ' (live)' : ''}`,
          method: 'POST', path: `${base(t)}/migrate`, body: { target, online: online ? 1 : 0 },
          cli: `qm migrate ${t.vmid} ${target}${online ? ' --online' : ''}`,
        };
      }
      const restart = running ?? true;
      return {
        description: `Migrate CT ${t.vmid} ${t.node} → ${target}${restart ? ' (restart)' : ''}`,
        method: 'POST', path: `${base(t)}/migrate`, body: { target, ...(restart ? { restart: 1 } : {}) },
        cli: `pct migrate ${t.vmid} ${target}${restart ? ' --restart' : ''}`,
      };
    }
    case 'guest.snapshot': {
      const name = p.name || 'snap';
      const desc = p.description ? ` --description ${JSON.stringify(p.description)}` : '';
      return {
        description: `Snapshot ${t.vmid} as "${name}"`,
        method: 'POST', path: `${base(t)}/snapshot`,
        body: { snapname: name, ...(p.description ? { description: p.description } : {}) },
        cli: `${tool(t)} snapshot ${t.vmid} ${name}${desc}`,
      };
    }
    case 'guest.destroy':
      return {
        description: `Destroy ${t.type === 'qemu' ? 'VM' : 'CT'} ${t.vmid} on ${t.node} and purge its disks`,
        method: 'DELETE', path: base(t), body: { purge: 1, 'destroy-unreferenced-disks': 1 },
        cli: `${tool(t)} destroy ${t.vmid} --purge 1 --destroy-unreferenced-disks 1`,
      };
  }
}

export const confirmTextFor = (vmids: number[]) => `destroy ${vmids.join(',')}`;

export const isDestructive = (action: string) => action === 'guest.destroy' || action === 'guest.stop';
