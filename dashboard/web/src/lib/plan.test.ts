import { describe, expect, it } from 'vitest';
import type { Plan } from '../api/types';
import { canRun, planCli } from './plan';

const base: Plan = {
  id: 'p1', action: 'guest.start', title: 'Start 120', summary: '', clusterId: 'lab', destructive: false,
  steps: [{ description: 'Start VM 120', method: 'POST', path: '/nodes/pve1/qemu/120/status/start', body: {}, cli: 'qm start 120' }],
  createdAt: 1000, expiresAt: 1600,
};

describe('canRun (plan pane confirm gating)', () => {
  it('blocks when there is no plan', () => {
    expect(canRun(null, '', 1100)).toBe(false);
  });

  it('allows a non-destructive plan without typing', () => {
    expect(canRun(base, '', 1100)).toBe(true);
  });

  it('allows a flagged-but-unconfirmed plan (hard stop) without typing', () => {
    expect(canRun({ ...base, action: 'guest.stop', destructive: true }, '', 1100)).toBe(true);
  });

  it('requires the exact confirm text for destroy', () => {
    const p: Plan = { ...base, action: 'guest.destroy', destructive: true, confirmText: 'destroy 120' };
    expect(canRun(p, '', 1100)).toBe(false);
    expect(canRun(p, 'destroy 12', 1100)).toBe(false);
    expect(canRun(p, 'Destroy 120', 1100)).toBe(false);
    expect(canRun(p, 'destroy 120 ', 1100)).toBe(false);
    expect(canRun(p, 'destroy 120', 1100)).toBe(true);
  });

  it('blocks expired plans', () => {
    expect(canRun(base, '', 1600)).toBe(false);
  });

  it('joins step CLIs in order', () => {
    expect(planCli({ ...base, steps: [...base.steps, { ...base.steps[0], cli: 'qm start 121' }] })).toBe('qm start 120\nqm start 121');
  });
});
