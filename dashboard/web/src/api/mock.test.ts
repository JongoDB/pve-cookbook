import { describe, expect, it } from 'vitest';
import { MockApi } from './mock';

describe('MockApi (demo backend honours the api.md contract)', () => {
  it('requires login, then serves fleet and guests', async () => {
    const api = new MockApi();
    await expect(api.fleet()).rejects.toMatchObject({ status: 401 });
    const me = await api.login({ clusterId: 'pve-lab', username: 'root', realm: 'pam', password: 'x' });
    expect(me.user).toBe('root@pam');
    const f = await api.fleet();
    expect(f.totals.nodes).toBe(4);
    expect(f.findings.some((x) => x.fix?.action === 'backup.protect')).toBe(true);
    expect((await api.guests({ q: 'gpu' })).map((g) => g.vmid).sort()).toEqual([300, 310]);
  });

  it('runs a finding fix and records audit + task', async () => {
    const api = new MockApi();
    await api.login({ clusterId: 'pve-lab', username: 'root', realm: 'pam', password: 'x' });
    const fix = (await api.fleet()).findings.find((x) => x.fix)!;
    const plan = await api.createPlan({ action: fix.fix!.action, clusterId: fix.clusterId, params: fix.fix!.params });
    expect(plan.steps[0].cli).toBe('pvesh set /cluster/backup/nightly-all --vmid 131');
    const run = await api.runPlan(plan.id);
    expect(run.results.every((r) => r.ok)).toBe(true);
    expect((await api.fleet()).findings.some((x) => x.id === fix.id)).toBe(false);
    expect((await api.audit())[0].cli).toEqual(plan.steps.map((s) => s.cli));
    await expect(api.runPlan(plan.id)).rejects.toMatchObject({ code: 'already_ran' });
  });

  it('gates destroy on the exact confirm text', async () => {
    const api = new MockApi();
    await api.login({ clusterId: 'pve-lab', username: 'root', realm: 'pam', password: 'x' });
    const plan = await api.createPlan({ action: 'guest.destroy', clusterId: 'pve-lab', params: { targets: [{ vmid: 999, node: 'pve2', type: 'lxc' }] } });
    expect(plan.confirmText).toBe('destroy 999');
    await expect(api.runPlan(plan.id, 'destroy 99')).rejects.toMatchObject({ code: 'confirm_mismatch' });
    await api.runPlan(plan.id, 'destroy 999');
    expect((await api.guests()).some((g) => g.vmid === 999)).toBe(false);
  });

  it('refuses plans on clusters the user is not logged in to', async () => {
    const api = new MockApi();
    await api.login({ clusterId: 'pve-lab', username: 'root', realm: 'pam', password: 'x' });
    await expect(api.createPlan({ action: 'guest.start', clusterId: 'edge-01', params: { targets: [{ vmid: 200, node: 'edge1', type: 'lxc' }] } }))
      .rejects.toMatchObject({ code: 'cluster_not_authed' });
    await api.clusterLogin('edge-01', { username: 'root', realm: 'pam', password: 'x' });
    expect((await api.createPlan({ action: 'guest.reboot', clusterId: 'edge-01', params: { targets: [{ vmid: 200, node: 'edge1', type: 'lxc' }] } })).steps[0].cli).toBe('pct reboot 200');
  });
});
