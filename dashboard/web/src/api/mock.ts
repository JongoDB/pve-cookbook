// In-memory implementation of the galley API for `npm run dev:mock`.
// Generic demo data only: two clusters, ~20 guests, two NVIDIA A2 GPUs on pve1.
import { ApiError } from './http';
import type {
  AddClusterRequest, Api, AuditEntry, Cluster, ClusterLoginRequest, EventHandlers, Finding, Fleet,
  Guest, GuestFilter, GuestTarget, LoginRequest, Me, Plan, PlanRequest, Probe, RunResult, Task,
} from './types';
import { ACTION_LABEL, confirmTextFor, guestSteps, type GuestAction, type GuestParams } from '../lib/actions';

const GiB = 1024 ** 3;
const TiB = 1024 ** 4;
const now = () => Math.floor(Date.now() / 1000);
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms + Math.random() * 80));
const rid = () => Math.random().toString(36).slice(2, 10);

interface MockNode { name: string; maxcpu: number; maxmem: number; kernel: string; cpu: number; uptime: number }
interface MockCluster { id: string; name: string; endpoints: { host: string; fingerprint: string }[]; nodes: MockNode[] }

const fp = (seed: number) =>
  Array.from({ length: 32 }, (_, i) => ((seed * 37 + i * 91) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');

function seedClusters(): MockCluster[] {
  return [
    {
      id: 'pve-lab', name: 'pve-lab',
      endpoints: [11, 12, 13].map((o) => ({ host: `192.0.2.${o}`, fingerprint: fp(o) })),
      nodes: ['pve1', 'pve2', 'pve3'].map((n, i) => ({
        name: n, maxcpu: 40, maxmem: 503 * GiB, kernel: '7.0.14-30-pve', cpu: [0.18, 0.09, 0.11][i], uptime: 13 * 3600 + i * 400,
      })),
    },
    {
      id: 'edge-01', name: 'edge-01',
      endpoints: [{ host: '198.51.100.20', fingerprint: fp(20) }],
      nodes: [{ name: 'edge1', maxcpu: 16, maxmem: 64 * GiB, kernel: '7.0.2-6-pve', cpu: 0.34, uptime: 41 * 86400 }],
    },
  ];
}

function g(clusterId: string, vmid: number, name: string, type: 'qemu' | 'lxc', node: string, status: string,
  maxcpu: number, maxmemG: number, maxdiskG: number, tags: string[] = [], hastate?: string): Guest {
  const running = status === 'running';
  return {
    clusterId, vmid, name, type, node, status, maxcpu,
    cpu: running ? Math.random() * 0.35 : 0,
    maxmem: maxmemG * GiB, mem: running ? maxmemG * GiB * (0.3 + Math.random() * 0.5) : 0,
    maxdisk: maxdiskG * GiB, disk: maxdiskG * GiB * 0.4,
    uptime: running ? 3600 * (5 + vmid % 200) : 0, tags, template: false, ...(hastate ? { hastate } : {}),
  };
}

function seedGuests(): Guest[] {
  const L = 'pve-lab';
  return [
    g(L, 100, 'haproxy', 'lxc', 'pve1', 'running', 2, 1, 8, ['edge', 'prod'], 'started'),
    g(L, 101, 'haproxy-b', 'lxc', 'pve2', 'running', 2, 1, 8, ['edge', 'prod'], 'started'),
    g(L, 110, 'dns01', 'lxc', 'pve2', 'running', 1, 0.5, 4, ['infra']),
    g(L, 120, 'web01', 'qemu', 'pve1', 'running', 4, 8, 40, ['prod', 'web'], 'started'),
    g(L, 121, 'web02', 'qemu', 'pve2', 'running', 4, 8, 40, ['prod', 'web'], 'started'),
    g(L, 125, 'db01', 'qemu', 'pve3', 'running', 8, 32, 200, ['prod', 'db'], 'started'),
    g(L, 130, 'prometheus', 'lxc', 'pve3', 'running', 2, 4, 64, ['monitoring']),
    g(L, 131, 'grafana', 'lxc', 'pve2', 'running', 2, 2, 8, ['monitoring']),
    g(L, 140, 'gitea', 'lxc', 'pve1', 'running', 2, 2, 32, ['dev']),
    g(L, 141, 'ci-runner', 'qemu', 'pve3', 'stopped', 8, 16, 80, ['dev']),
    g(L, 150, 'nextcloud', 'qemu', 'pve2', 'running', 4, 8, 120, ['apps']),
    g(L, 151, 'uptime-kuma', 'lxc', 'pve3', 'running', 1, 1, 4, ['monitoring']),
    g(L, 160, 'k8s-cp1', 'qemu', 'pve1', 'running', 4, 8, 60, ['k8s']),
    g(L, 161, 'k8s-cp2', 'qemu', 'pve2', 'running', 4, 8, 60, ['k8s']),
    g(L, 162, 'k8s-cp3', 'qemu', 'pve3', 'running', 4, 8, 60, ['k8s']),
    g(L, 170, 'minio', 'qemu', 'pve3', 'running', 4, 16, 500, ['storage']),
    g(L, 300, 'llm-vllm', 'qemu', 'pve1', 'running', 8, 32, 120, ['gpu', 'ai'], 'started'),
    g(L, 310, 'ollama', 'lxc', 'pve1', 'running', 4, 16, 80, ['gpu', 'ai']),
    g(L, 999, 'sandbox', 'lxc', 'pve2', 'stopped', 1, 0.5, 4, ['lab']),
    g('edge-01', 200, 'edge-proxy', 'lxc', 'edge1', 'running', 2, 2, 8, ['edge']),
    g('edge-01', 201, 'edge-dns', 'lxc', 'edge1', 'running', 1, 0.5, 4, ['infra']),
    { ...g('pve-lab', 9000, 'tpl-debian13', 'qemu', 'pve1', 'stopped', 2, 2, 10, ['template']), template: true },
  ];
}


export class MockApi implements Api {
  private needsSetup = import.meta.env.VITE_MOCK_SETUP === '1';
  private clustersState: MockCluster[] = this.needsSetup ? [] : seedClusters();
  private guestsState: Guest[] = this.needsSetup ? [] : seedGuests();
  private session: Me | null = null;
  private plans = new Map<string, Plan & { ran?: boolean }>();
  private auditLog: AuditEntry[] = [];
  private taskLog: Task[] = [];
  private backupJob = new Set<number>();
  private listeners = new Set<EventHandlers>();
  private unauthorized: (() => void) | null = null;
  private settled = new Map<string, Promise<AuditEntry>>();
  /** The one-time setup code (mock: any non-empty code except "wrong" is accepted). */
  readonly setupToken = 'demo-setup-code';
  private stepDelayMs: number;

  /** stepDelayMs: how long each async run step takes (tests pass 0). */
  constructor(opts: { stepDelayMs?: number } = {}) {
    this.stepDelayMs = opts.stepDelayMs ?? 900;
    for (const x of this.guestsState) if (x.vmid !== 131) this.backupJob.add(x.vmid);
    const t0 = now();
    const seedTasks: [string, string, string, string, number, string][] = [
      ['pve-lab', 'pve1', 'vzdump', '', 7200, 'OK'],
      ['pve-lab', 'pve2', 'vzdump', '', 7180, 'OK'],
      ['pve-lab', 'pve3', 'vzdump', '', 7150, 'OK'],
      ['pve-lab', 'pve1', 'qmstart', '300', 5400, 'OK'],
      ['pve-lab', 'pve2', 'vzcreate', '131', 3600 * 70, 'OK'],
      ['edge-01', 'edge1', 'aptupdate', '', 1800, 'OK'],
      ['pve-lab', 'pve3', 'qmigrate', '125', 900, 'OK'],
      ['pve-lab', 'pve2', 'vzstart', '999', 600, 'command \'lxc-start\' failed: exit code 1'],
    ];
    this.taskLog = seedTasks.map(([c, n, type, id, ageS, status]) => ({
      clusterId: c, node: n, type, id, user: 'root@pam', starttime: t0 - ageS, endtime: t0 - ageS + 40, status,
      upid: `UPID:${n}:${rid()}:${type}:${id}:root@pam:`,
    })).sort((a, b) => b.starttime - a.starttime);

    setInterval(() => this.tick(), 3000);
  }

  // ---------- helpers ----------
  private requireAuth() {
    if (!this.session) { this.unauthorized?.(); throw new ApiError(401, 'unauthenticated', 'log in first'); }
  }

  private requireSetupToken(t?: string) {
    if (!this.needsSetup) return;
    if (!t) throw new ApiError(403, 'setup_token_required', 'setup code required');
    if (t === 'wrong') throw new ApiError(403, 'setup_token_invalid', 'setup code invalid');
  }

  onUnauthorized(fn: (() => void) | null) { this.unauthorized = fn; }

  /** Resolves with the final audit entry of an async run (tests). */
  whenSettled(auditId: string): Promise<AuditEntry> {
    return this.settled.get(auditId) ?? Promise.reject(new Error(`unknown run ${auditId}`));
  }

  private clusterView(c: MockCluster): Cluster {
    return {
      id: c.id, name: c.name, endpoints: c.endpoints,
      status: {
        reachable: true, quorate: true, nodes: c.nodes.length, nodesOnline: c.nodes.length,
        activeEndpoint: c.endpoints[0]?.host ?? '', lastPoll: now() - 2,
      },
    };
  }

  private buildFleet(): Fleet {
    const clusters = this.clustersState.map((c) => {
      const gs = this.guestsState.filter((x) => x.clusterId === c.id && !x.template);
      const isLab = c.id === 'pve-lab';
      const unprotected = gs.filter((x) => !this.backupJob.has(x.vmid)).map((x) => x.vmid);
      return {
        id: c.id, name: c.name, quorate: true,
        nodes: c.nodes.map((n) => {
          const ng = gs.filter((x) => x.node === n.name);
          return {
            name: n.name, online: true, cpu: n.cpu, maxcpu: n.maxcpu, maxmem: n.maxmem, uptime: n.uptime,
            mem: ng.reduce((a, x) => a + x.mem, 0) + 9 * GiB, guests: ng.length, kernel: n.kernel, pveversion: 'pve-manager/9.2.32',
          };
        }),
        ceph: isLab ? { health: 'HEALTH_OK', osdsUp: 9, osdsIn: 9, osdsTotal: 9, usedBytes: 0.42 * TiB, totalBytes: 31.4 * TiB } : null,
        storage: isLab
          ? [
              { id: 'vm-pool', node: 'pve1', type: 'rbd', shared: true, used: 0.14 * TiB, total: 10.4 * TiB, active: true },
              { id: 'cephfs', node: 'pve1', type: 'cephfs', shared: true, used: 0.01 * TiB, total: 10.4 * TiB, active: true },
              ...c.nodes.map((n) => ({ id: 'local-zfs', node: n.name, type: 'zfspool', shared: false, used: 60 * GiB, total: 720 * GiB, active: true })),
            ]
          : [{ id: 'local-zfs', node: 'edge1', type: 'zfspool', shared: false, used: 380 * GiB, total: 920 * GiB, active: true }],
        ha: { quorum: true, resources: gs.filter((x) => x.hastate).length, errors: 0 },
        backups: { covered: gs.length - unprotected.length, total: gs.length, unprotected },
      };
    });
    const findings: Finding[] = [];
    for (const c of clusters) {
      for (const vmid of c.backups.unprotected) {
        const gx = this.guestsState.find((x) => x.clusterId === c.id && x.vmid === vmid);
        findings.push({
          id: `backup-coverage:${c.id}:${vmid}`, level: 'WARN', check: 'backup-coverage', clusterId: c.id, where: c.name,
          message: `Guest ${vmid} (${gx?.name ?? '?'}) is not in any backup job`,
          fix: { action: 'backup.protect', params: { vmids: [vmid], job: 'nightly-all' }, label: 'Add to nightly-all' },
        });
      }
    }
    if (this.clustersState.some((c) => c.id === 'pve-lab')) {
      findings.push({
        id: 'corosync-retx:pve-lab:pve1', level: 'WARN', check: 'corosync-retx', clusterId: 'pve-lab', where: 'pve-lab/pve1',
        message: 'corosync: 33 retransmits in 10 min — cluster link shared with guest traffic',
      });
    }
    if (this.clustersState.some((c) => c.id === 'edge-01')) {
      findings.push({
        id: 'updates:edge-01:edge1', level: 'INFO', check: 'updates', clusterId: 'edge-01', where: 'edge-01/edge1',
        message: '14 package updates pending, reboot required for new kernel',
      });
    }
    const guests = this.guestsState.filter((x) => !x.template);
    const nodes = clusters.reduce((a, c) => a + c.nodes.length, 0);
    return {
      updatedAt: now(),
      totals: { clusters: clusters.length, nodes, nodesOnline: nodes, guests: guests.length, running: guests.filter((x) => x.status === 'running').length },
      clusters, findings,
    };
  }

  private emit() {
    const f = this.buildFleet();
    const t = this.taskLog.slice(0, 50);
    for (const l of this.listeners) { l.fleet?.(f); l.tasks?.(t); }
  }

  private tick() {
    for (const c of this.clustersState) for (const n of c.nodes) {
      n.cpu = Math.min(0.95, Math.max(0.02, n.cpu + (Math.random() - 0.5) * 0.04));
      n.uptime += 3;
    }
    for (const x of this.guestsState) if (x.status === 'running') {
      x.cpu = Math.min(1, Math.max(0, x.cpu + (Math.random() - 0.5) * 0.06));
      x.uptime += 3;
    }
    this.emit();
  }

  private findGuest(clusterId: string, vmid: number) {
    const x = this.guestsState.find((y) => y.clusterId === clusterId && y.vmid === vmid);
    if (!x) throw new ApiError(404, 'not_found', `guest ${vmid} not found`);
    return x;
  }

  // ---------- Api ----------
  async health() { await wait(20); return { ok: true, version: '0.1.0-mock' }; }
  async setup() { await wait(20); return { needsSetup: this.needsSetup, clusters: this.clustersState.map((c) => ({ id: c.id, name: c.name })) }; }

  async probe(endpoints: string[], setupToken?: string): Promise<{ endpoints: Probe[] }> {
    await wait(400);
    this.requireSetupToken(setupToken);
    return {
      endpoints: endpoints.map((h, i) => (h.includes('bad')
        ? { host: h, reachable: false, fingerprint: '', trustedBySystem: false, error: 'connection refused' }
        : { host: h, reachable: true, fingerprint: fp(i + 40), trustedBySystem: false })),
    };
  }

  async addCluster(r: AddClusterRequest, setupToken?: string): Promise<Cluster> {
    await wait();
    if (!this.needsSetup) this.requireAuth();
    this.requireSetupToken(setupToken);
    if (!r.name || !r.endpoints.length) throw new ApiError(400, 'invalid', 'name and at least one endpoint required');
    if (!/^[^@!]+@[^!]+![\w-]+$/.test(r.tokenId)) throw new ApiError(400, 'invalid_token', 'token id must look like user@realm!name');
    const id = r.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (this.clustersState.some((c) => c.id === id)) throw new ApiError(409, 'exists', `cluster ${id} already registered`);
    const c: MockCluster = {
      id, name: r.name, endpoints: r.endpoints,
      nodes: r.endpoints.map((_e, i) => ({ name: `node${i + 1}`, maxcpu: 16, maxmem: 128 * GiB, kernel: '7.0.14-30-pve', cpu: 0.05, uptime: 3600 })),
    };
    this.clustersState.push(c);
    if (this.needsSetup) {
      this.needsSetup = false;
      this.guestsState.push(...seedGuests().filter((x) => x.clusterId === 'pve-lab').slice(0, 6).map((x) => ({ ...x, clusterId: id, node: c.nodes[0].name })));
    }
    this.emit();
    return this.clusterView(c);
  }

  async clusters() { await wait(40); return this.clustersState.map((c) => this.clusterView(c)); }

  async removeCluster(id: string) {
    await wait(); this.requireAuth();
    this.clustersState = this.clustersState.filter((c) => c.id !== id);
    this.guestsState = this.guestsState.filter((x) => x.clusterId !== id);
    if (this.session) this.session.clusters = this.session.clusters.filter((c) => c.id !== id);
    this.emit();
  }

  async login(r: LoginRequest): Promise<Me> {
    await wait(300);
    if (r.password === 'flood') {
      throw new ApiError(429, 'rate_limited', 'too many attempts', 12);
    }
    if (!r.username || !r.password) throw new ApiError(401, 'auth_failed', 'authentication failure');
    if (r.password === 'wrong') throw new ApiError(401, 'auth_failed', 'authentication failure');
    this.session = {
      user: `${r.username}@${r.realm}`, csrf: rid(),
      clusters: this.clustersState.map((c) => ({ id: c.id, name: c.name, authed: c.id === r.clusterId || c.id !== 'edge-01' })),
    };
    return this.session;
  }

  async clusterLogin(id: string, r: ClusterLoginRequest): Promise<Me> {
    await wait(300); this.requireAuth();
    if (!r.password || r.password === 'wrong') throw new ApiError(401, 'auth_failed', 'authentication failure');
    this.session = { ...this.session!, clusters: this.session!.clusters.map((c) => (c.id === id ? { ...c, authed: true } : c)) };
    return this.session;
  }

  async logout() { await wait(); this.session = null; }
  async me() { await wait(30); this.requireAuth(); return this.session!; }
  async fleet() { await wait(60); this.requireAuth(); return this.buildFleet(); }

  async guests(f: GuestFilter = {}) {
    await wait(60); this.requireAuth();
    const q = (f.q ?? '').toLowerCase();
    return this.guestsState.filter((x) =>
      (!f.cluster || x.clusterId === f.cluster) && (!f.status || x.status === f.status) && (!f.type || x.type === f.type) &&
      (!q || x.name.toLowerCase().includes(q) || String(x.vmid).includes(q) || x.tags.some((t) => t.includes(q))));
  }

  async tasks(f: { cluster?: string; limit?: number } = {}) {
    await wait(40); this.requireAuth();
    return this.taskLog.filter((t) => !f.cluster || t.clusterId === f.cluster).slice(0, f.limit ?? 50);
  }

  async targets(clusterId: string, node: string) {
    await wait(40); this.requireAuth();
    const c = this.clustersState.find((x) => x.id === clusterId);
    return (c?.nodes ?? []).map((n) => n.name).filter((n) => n !== node);
  }

  async createPlan(r: PlanRequest): Promise<Plan> {
    await wait(); this.requireAuth();
    const authed = this.session!.clusters.find((c) => c.id === r.clusterId)?.authed;
    if (!authed) throw new ApiError(403, 'cluster_not_authed', `log in to ${r.clusterId} first`);
    const t0 = now();
    const base = { id: rid(), action: r.action, clusterId: r.clusterId, createdAt: t0, expiresAt: t0 + 600 };
    let plan: Plan;
    if (r.action === 'backup.protect') {
      const vmids = (r.params.vmids as number[]) ?? [];
      const job = (r.params.job as string) ?? 'nightly-all';
      plan = {
        ...base, title: `Protect ${vmids.join(', ')} with backups`, destructive: false,
        summary: `Adds ${vmids.length === 1 ? 'guest' : 'guests'} ${vmids.join(', ')} to backup job ${job}. Nothing is backed up until the job next runs.`,
        steps: [{
          description: `Add ${vmids.join(', ')} to backup job ${job}`, method: 'PUT', path: `/cluster/backup/${job}`,
          body: { vmid: vmids.join(',') }, cli: `pvesh set /cluster/backup/${job} --vmid ${vmids.join(',')}`,
        }],
      };
    } else if (r.action.startsWith('guest.')) {
      const targets = (r.params.targets as GuestTarget[]) ?? [];
      if (!targets.length) throw new ApiError(400, 'invalid', 'no targets');
      const p = r.params as GuestParams;
      const action = r.action as GuestAction;
      const label = ACTION_LABEL[action] ?? action;
      const ids = targets.map((t) => t.vmid);
      plan = {
        ...base,
        title: `${label} ${ids.length === 1 ? ids[0] : `${ids.length} guests`}${action === 'guest.migrate' ? ` → ${p.target}` : ''}`,
        summary: action === 'guest.destroy'
          ? 'Permanently deletes the guest configuration and every disk. This cannot be undone.'
          : action === 'guest.stop'
            ? 'Hard power-off, like pulling the plug. Prefer Shut down unless the guest is hung.'
            : `${ids.length} API call${ids.length > 1 ? 's' : ''}, run in order as ${this.session!.user}.`,
        destructive: action === 'guest.destroy' || action === 'guest.stop',
        ...(action === 'guest.destroy' ? { confirmText: confirmTextFor(ids) } : {}),
        steps: targets.flatMap((t) => guestSteps(action, t, p, this.guestsState.find((x) => x.clusterId === r.clusterId && x.vmid === t.vmid)?.status === 'running')),
      };
    } else {
      throw new ApiError(400, 'unknown_action', `unknown action ${r.action}`);
    }
    this.plans.set(plan.id, plan);
    return plan;
  }

  /**
   * Mirrors the async backend: validates, answers like a 202 `{auditId, status:"running"}`,
   * then executes the steps one by one, pushing `event: audit` frames with per-step status.
   */
  async runPlan(id: string, confirm?: string): Promise<RunResult> {
    await wait(300); this.requireAuth();
    const plan = this.plans.get(id);
    if (!plan) throw new ApiError(404, 'not_found', 'plan not found');
    if (plan.ran) throw new ApiError(409, 'already_ran', 'plan already ran');
    if (now() >= plan.expiresAt) throw new ApiError(410, 'expired', 'plan expired — create it again');
    if (plan.confirmText && confirm !== plan.confirmText) throw new ApiError(400, 'confirm_mismatch', `type "${plan.confirmText}" to confirm`);
    plan.ran = true;

    const user = this.session!.user;
    const entry: AuditEntry = {
      id: rid(), at: now(), user, clusterId: plan.clusterId, action: plan.action, title: plan.title,
      cli: plan.steps.map((s) => s.cli), ok: false, results: [], status: 'running',
    };
    this.auditLog.unshift(entry);
    const publish = () => {
      const snap: AuditEntry = { ...entry, results: entry.results.map((r) => ({ ...r })) };
      for (const l of this.listeners) l.audit?.(snap);
    };
    const sleep = () => new Promise((r) => setTimeout(r, this.stepDelayMs));

    const done = (async () => {
      for (let i = 0; i < plan.steps.length; i++) {
        const s = plan.steps[i];
        const m = s.path.match(/^\/nodes\/([^/]+)\/(qemu|lxc)\/(\d+)/);
        const node = m?.[1] ?? 'pve1';
        const vmid = m ? Number(m[3]) : 0;
        const op = s.method === 'DELETE' ? 'destroy' : s.path.match(/\/status\/(\w+)$/)?.[1] ?? (s.path.endsWith('/migrate') ? 'migrate' : s.path.endsWith('/snapshot') ? 'snapshot' : '');
        const type = plan.action === 'backup.protect' ? 'vzdump' : op === 'migrate' ? (m?.[2] === 'lxc' ? 'vzmigrate' : 'qmigrate') : `${m?.[2] === 'lxc' ? 'vz' : 'qm'}${op}`;
        const upid = `UPID:${node}:${rid()}:${type}:${vmid || ''}:${user}:`;
        entry.results.push({ step: i, ok: false, status: 'running', upid });
        publish();
        await sleep();
        const res = entry.results[i];
        try {
          if (plan.action === 'backup.protect') {
            for (const v of (s.body.vmid as string).split(',')) this.backupJob.add(Number(v));
          } else if (m) {
            const gx = this.findGuest(plan.clusterId, vmid);
            if (op === 'start') { if (gx.status === 'running') throw new Error('already running'); gx.status = 'running'; gx.uptime = 1; }
            if (op === 'shutdown' || op === 'stop') { gx.status = 'stopped'; gx.cpu = 0; gx.uptime = 0; gx.mem = 0; }
            if (op === 'reboot') gx.uptime = 1;
            if (op === 'migrate') gx.node = s.body.target as string;
            if (op === 'destroy') this.guestsState = this.guestsState.filter((y) => y !== gx);
          }
          this.taskLog.unshift({ clusterId: plan.clusterId, upid, node, type, id: vmid ? String(vmid) : '', user, starttime: now(), endtime: now() + 1, status: 'OK' });
          Object.assign(res, { ok: true, status: 'ok', exitstatus: 'OK' });
        } catch (e) {
          const msg = (e as Error).message;
          Object.assign(res, { ok: false, status: 'error', error: msg, exitstatus: msg });
        }
        this.emit();
      }
      entry.ok = entry.results.every((r) => r.ok);
      entry.status = 'done';
      publish();
      return { ...entry, results: entry.results.map((r) => ({ ...r })) };
    })();
    this.settled.set(entry.id, done);
    return { auditId: entry.id, status: 'running', results: [] };
  }

  async audit(limit = 100) { await wait(40); this.requireAuth(); return this.auditLog.slice(0, limit); }

  subscribe(h: EventHandlers): () => void {
    this.listeners.add(h);
    h.mode?.('live');
    if (this.session) setTimeout(() => this.emit(), 50);
    return () => { this.listeners.delete(h); };
  }
}
