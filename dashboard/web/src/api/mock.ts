// In-memory implementation of the galley API for `npm run dev:mock`.
// Generic demo data only: two clusters, ~20 guests, two NVIDIA A2 GPUs on pve1.
import { ApiError } from './http';
import type {
  AddClusterRequest, Api, AuditEntry, Cluster, ClusterLoginRequest, ClusterSummary, EventHandlers, Finding, Fleet,
  Guest, GuestFilter, GuestTarget, LoginRequest, Me, MetricName, MetricQuery, MetricSeries, Plan, PlanRequest, Probe,
  Realm, RunResult, Storage, Task, Timeframe, UpdateClusterRequest,
} from './types';
import { ACTION_LABEL, confirmTextFor, guestSteps, type GuestAction, type GuestParams } from '../lib/actions';

const GiB = 1024 ** 3;
const TiB = 1024 ** 4;
const now = () => Math.floor(Date.now() / 1000);
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms + Math.random() * 80));
const rid = () => Math.random().toString(36).slice(2, 10);

interface MockNode { name: string; maxcpu: number; maxmem: number; kernel: string; cpu: number; uptime: number }
interface MockCluster { id: string; name: string; endpoints: { host: string; fingerprint: string }[]; nodes: MockNode[]; shareLogin?: boolean }

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


function mockStorage(c: MockCluster): Storage[] {
  if (c.id === 'pve-lab') {
    return [
      // shared storage appears once per node, as /cluster/resources reports it
      ...c.nodes.flatMap((n) => [
        { id: 'vm-pool', node: n.name, type: 'rbd', shared: true, used: 4.1 * TiB, total: 10.4 * TiB, active: true, status: 'available' },
        { id: 'cephfs', node: n.name, type: 'cephfs', shared: true, used: 1.2 * TiB, total: 10.4 * TiB, active: true, status: 'available' },
        { id: 'nas-backup', node: n.name, type: 'nfs', shared: true, used: 0, total: 0, active: false, status: 'unknown', disabled: false },
      ]),
      ...c.nodes.map((n, i) => ({ id: 'local-zfs', node: n.name, type: 'zfspool', shared: false, used: (60 + i * 140) * GiB, total: 720 * GiB, active: true, status: 'available' })),
    ];
  }
  if (c.id === 'edge-01') return [{ id: 'local-zfs', node: 'edge1', type: 'zfspool', shared: false, used: 780 * GiB, total: 920 * GiB, active: true, status: 'available' }];
  return c.nodes.map((n) => ({ id: 'local', node: n.name, type: 'dir', shared: false, used: 10 * GiB, total: 100 * GiB, active: true, status: 'available' }));
}

// ---- deterministic metric history (same input → same curve) ----

// PVE rrd resolutions: ~70 samples per timeframe
const TF_STEP: Record<Timeframe, number> = { hour: 60, day: 1200, week: 8400, month: 36000, year: 432000 };

function timeAxis(tf: Timeframe): number[] {
  const step = TF_STEP[tf];
  const end = Math.floor(now() / step) * step;
  return Array.from({ length: 70 }, (_, i) => end - (69 - i) * step);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/** Smooth-ish noise in [0,1] for a key at time ts (period in seconds). */
function wave(key: string, ts: number, period = 86400): number {
  const ph = hash(key) * Math.PI * 2;
  const a = Math.sin((ts / period) * Math.PI * 2 + ph);
  const b = Math.sin((ts / (period / 5.3)) * Math.PI * 2 + ph * 1.7);
  const n = hash(`${key}:${Math.floor(ts / 600)}`) - 0.5;
  return Math.min(1, Math.max(0, 0.5 + 0.32 * a + 0.12 * b + 0.12 * n));
}

type Series = Partial<Record<MetricName, (number | null)[]>>;

/** pve3 rebooted 5 h ago: no samples for a short stretch before that (a real gap, not zero). */
function gapAt(key: string, ts: number): boolean {
  const t0 = now();
  if (key.startsWith('node:pve3')) return ts > t0 - 5.4 * 3600 && ts < t0 - 5 * 3600;
  return false;
}

function nodeSeries(c: MockCluster, n: MockNode, t: number[]): Series {
  const key = `node:${n.name}`;
  const base = n.cpu;
  const g = (fn: (ts: number) => number) => t.map((ts, i) => (gapAt(key, ts) || i === t.length - 1 && n.name === 'pve2' ? null : fn(ts)));
  const memFrac = 0.12 + base * 0.6;
  return {
    cpu: g((ts) => Math.max(0.01, base * (0.55 + wave(`${key}cpu`, ts)))),
    cpus: g(() => n.maxcpu),
    memUsed: g((ts) => n.maxmem * (memFrac + 0.04 * wave(`${key}mem`, ts, 86400 * 3))),
    memTotal: g(() => n.maxmem),
    swapUsed: g((ts) => 0.2 * GiB * wave(`${key}swap`, ts, 86400 * 7)),
    swapTotal: g(() => 8 * GiB),
    rootUsed: g((ts) => (11 + wave(`${key}root`, ts, 86400 * 30)) * GiB),
    rootTotal: g(() => 94 * GiB),
    netIn: g((ts) => (c.id === 'edge-01' ? 4e6 : 18e6) * (0.2 + 1.6 * wave(`${key}in`, ts))),
    netOut: g((ts) => (c.id === 'edge-01' ? 2e6 : 9e6) * (0.2 + 1.4 * wave(`${key}out`, ts))),
    ioWait: g((ts) => 0.002 + 0.02 * wave(`${key}io`, ts)),
    load: g((ts) => n.maxcpu * base * (0.6 + wave(`${key}load`, ts))),
    pressureCpu: g((ts) => 0.3 + 3 * wave(`${key}pc`, ts)),
    pressureIo: g((ts) => 0.1 + 1.5 * wave(`${key}pi`, ts)),
    pressureMem: g(() => 0),
  };
}

function sumSeries(parts: Series[], len: number): Series {
  const out: Series = {};
  const keys = new Set(parts.flatMap((p) => Object.keys(p) as MetricName[]));
  for (const k of keys) {
    out[k] = Array.from({ length: len }, (_, i) => {
      const vals = parts.map((p) => p[k]?.[i]).filter((v): v is number => v !== null && v !== undefined);
      if (!vals.length) return null;
      if (k === 'cpu') {
        let w = 0, s = 0;
        parts.forEach((p) => { const v = p.cpu?.[i]; const c = p.cpus?.[i] ?? 1; if (v !== null && v !== undefined) { s += v * (c ?? 1); w += c ?? 1; } });
        return w ? s / w : null;
      }
      if (k === 'ioWait' || k === 'load' || k.startsWith('pressure')) return Math.max(...vals);
      return vals.reduce((a, b) => a + b, 0);
    });
  }
  return out;
}

function guestSeries(gx: Guest, t: number[]): Series {
  const key = `guest:${gx.clusterId}:${gx.vmid}`;
  const on = gx.status === 'running';
  const started = now() - gx.uptime;
  const g = (fn: (ts: number) => number) => t.map((ts) => (!on || ts < started ? 0 : fn(ts)));
  const busy = gx.name === 'llm-vllm' ? 0.6 : gx.name.startsWith('web') ? 0.2 : 0.08;
  return {
    cpu: g((ts) => busy * (0.4 + wave(`${key}cpu`, ts))),
    cpus: t.map(() => gx.maxcpu),
    memUsed: g((ts) => gx.maxmem * (0.35 + 0.3 * wave(`${key}mem`, ts, 86400 * 2))),
    memTotal: t.map(() => gx.maxmem),
    diskUsed: t.map(() => gx.disk),
    diskTotal: t.map(() => gx.maxdisk),
    netIn: g((ts) => 2e6 * busy * 4 * wave(`${key}in`, ts)),
    netOut: g((ts) => 1e6 * busy * 4 * wave(`${key}out`, ts)),
    diskRead: g((ts) => 3e6 * busy * wave(`${key}rd`, ts)),
    diskWrite: g((ts) => 1.5e6 * busy * wave(`${key}wr`, ts)),
    pressureCpu: g((ts) => 2 * busy * wave(`${key}pc`, ts)),
    pressureIo: g((ts) => busy * wave(`${key}pi`, ts)),
    pressureMem: g(() => 0),
  };
}

function storageSeries(st: Storage, t: number[]): Series {
  if (st.status === 'unknown') return { diskUsed: t.map(() => null), diskTotal: t.map(() => null) };
  const t0 = now();
  // grows slowly towards today's value
  return {
    diskUsed: t.map((ts) => st.used * (1 - Math.min(0.25, (t0 - ts) / (86400 * 365 * 2))) * (0.98 + 0.02 * wave(`st:${st.id}`, ts))),
    diskTotal: t.map(() => st.total),
  };
}

function guestConfig(gx: Guest): Record<string, string | number> {
  const mem = Math.round(gx.maxmem / 1024 ** 2);
  const diskG = Math.round(gx.maxdisk / GiB);
  const mac = (n: number) => `BC:24:11:${(gx.vmid >> 8).toString(16).padStart(2, '0').toUpperCase()}:${(gx.vmid & 255).toString(16).padStart(2, '0').toUpperCase()}:0${n}`;
  if (gx.type === 'lxc') {
    return {
      arch: 'amd64', cores: gx.maxcpu, memory: mem, swap: 512, hostname: gx.name, ostype: 'debian',
      rootfs: `local-zfs:subvol-${gx.vmid}-disk-0,size=${diskG}G`,
      ...(gx.name === 'prometheus' ? { mp0: `vm-pool:vm-${gx.vmid}-disk-1,mp=/var/lib/prometheus,size=200G,backup=1` } : {}),
      net0: `name=eth0,bridge=vmbr0,hwaddr=${mac(1)},ip=dhcp,type=veth${gx.tags.includes('prod') ? ',firewall=1' : ''}`,
      onboot: 1, unprivileged: 1, features: 'nesting=1', tags: gx.tags.join(';'),
      ...(gx.name === 'ollama' ? { dev0: '/dev/dri/renderD128,gid=104' } : {}),
      digest: 'f00d',
    };
  }
  const gpu = gx.name === 'llm-vllm';
  return {
    name: gx.name, cores: gx.maxcpu, sockets: 1, cpu: gpu ? 'host' : 'x86-64-v2-AES', memory: mem, balloon: gpu ? 0 : Math.round(mem / 2),
    machine: gpu ? 'q35' : 'pc-i440fx-9.2', bios: gpu ? 'ovmf' : 'seabios', scsihw: 'virtio-scsi-single', ostype: 'l26', agent: 1,
    ...(gpu ? { efidisk0: `local-zfs:vm-${gx.vmid}-disk-2,efitype=4m,pre-enrolled-keys=0,size=1M` } : {}),
    scsi0: `${gpu ? 'local-zfs' : 'vm-pool'}:vm-${gx.vmid}-disk-0,iothread=1,discard=on,ssd=1,size=${diskG}G`,
    ...(gx.name === 'minio' ? { scsi1: `vm-pool:vm-${gx.vmid}-disk-1,iothread=1,size=2T,backup=0` } : {}),
    ide2: 'none,media=cdrom',
    net0: `virtio=${mac(1)},bridge=vmbr0${gx.tags.includes('prod') ? ',tag=20,firewall=1' : ''}`,
    ...(gx.tags.includes('k8s') ? { net1: `virtio=${mac(2)},bridge=vmbr1,tag=30` } : {}),
    ...(gpu ? { hostpci0: 'mapping=gpu-a2-0,pcie=1' } : {}),
    boot: 'order=scsi0;ide2;net0', onboot: 1, tags: gx.tags.join(';'), vmgenid: '6f1c2b0e-0000-4000-8000-00000000abcd',
    smbios1: 'uuid=0b3a9c2e-0000-4000-8000-000000000001', digest: 'beef',
  };
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
  private prefs = new Map<string, unknown>();
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
    // one task still running (a backup)
    this.taskLog.unshift({ clusterId: 'pve-lab', node: 'pve2', type: 'vzdump', id: '125', user: 'root@pam', starttime: t0 - 95, upid: `UPID:pve2:${rid()}:vzdump:125:root@pam:` });

    this.auditLog = [
      {
        id: 'seed-2', at: t0 - 2400, updated: t0 - 2390, user: 'root@pam', actorUser: 'root@pam', clusterId: 'pve-lab', action: 'guest.snapshot',
        title: 'Snapshot 300', cli: ['qm snapshot 300 driver-570'], ok: true, status: 'ok', results: [{ step: 0, ok: true, status: 'ok', exitstatus: 'OK', upid: 'UPID:pve1:0001:qmsnapshot:300:root@pam:' }],
      },
      {
        id: 'seed-1', at: t0 - 9000, updated: t0 - 8990, user: 'root@pam', actorUser: 'root@pam', clusterId: 'pve-lab', action: 'guest.migrate',
        title: 'Migrate 125 to pve3', cli: ['qm migrate 125 pve3 --online'], ok: true, status: 'ok', results: [{ step: 0, ok: true, status: 'ok', exitstatus: 'OK' }],
      },
    ];
    if (typeof window !== 'undefined') setInterval(() => this.tick(), 3000);
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
    const mine = this.session?.clusters.find((x) => x.id === c.id);
    return {
      id: c.id, name: c.name, endpoints: c.endpoints, tokenId: 'galley@pve!poller', shareLogin: !!c.shareLogin,
      authed: !!mine?.authed, admin: !!mine?.authed,
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
        ceph: isLab ? { health: 'HEALTH_OK', osdsUp: 9, osdsIn: 9, osdsTotal: 9, usedBytes: 11.4 * TiB, totalBytes: 31.4 * TiB } : null,
        storage: mockStorage(c),
        ha: { quorum: true, resources: gs.filter((x) => x.hastate).length, errors: 0 },
        // edge-01's service token cannot read backup coverage: honest "unknown", never "covered"
        backups: isLab
          ? { known: true, covered: gs.length - unprotected.length, total: gs.length, unprotected }
          : { known: false, covered: 0, total: gs.length, unprotected: [] },
        lastPoll: now() - 2, lastSuccess: now() - 2, stale: false,
        ...(isLab ? {} : { errors: { 'backup-coverage': '403 Permission check failed (/cluster/backup-info, Sys.Audit)' } }),
      } satisfies ClusterSummary;
    });
    const findings: Finding[] = [];
    for (const c of clusters) {
      for (const vmid of c.backups.unprotected) {
        const gx = this.guestsState.find((x) => x.clusterId === c.id && x.vmid === vmid);
        findings.push({
          id: `backup-coverage:${c.id}:${vmid}`, level: 'WARN', check: 'backup-coverage', clusterId: c.id, where: c.name,
          message: `Guest ${vmid} (${gx?.name ?? '?'}) is not in any backup job`,
          resource: { kind: 'guest', id: String(vmid), ...(gx ? { node: gx.node } : {}) },
          fix: { action: 'backup.protect', params: { vmids: [vmid], job: 'nightly-all' }, label: 'Add to nightly-all' },
        });
      }
    }
    if (this.clustersState.some((c) => c.id === 'pve-lab')) {
      findings.unshift({
        id: 'storage-offline:pve-lab:nas-backup', level: 'CRIT', check: 'storage-offline', clusterId: 'pve-lab', where: 'pve-lab',
        message: 'Storage nas-backup is not available on pve1, pve2, pve3', resource: { kind: 'storage', id: 'nas-backup' },
      });
      findings.push({
        id: 'corosync-links:pve-lab:pve1', level: 'WARN', check: 'corosync-links', clusterId: 'pve-lab', where: 'pve-lab/pve1',
        message: 'corosync has a single link, shared with guest traffic (33 retransmits in 10 min)', resource: { kind: 'cluster', id: '' },
      });
    }
    if (this.clustersState.some((c) => c.id === 'edge-01')) {
      findings.push({
        id: 'backup-coverage-unknown:edge-01', level: 'WARN', check: 'backup-coverage-unknown', clusterId: 'edge-01', where: 'edge-01',
        message: 'Could not read backup coverage: 403 Permission check failed', resource: { kind: 'cluster', id: '' },
      });
      findings.push({
        id: 'updates:edge-01:edge1', level: 'INFO', check: 'updates', clusterId: 'edge-01', where: 'edge-01/edge1',
        message: '14 package updates pending, reboot required for new kernel', resource: { kind: 'node', id: 'edge1', node: 'edge1' },
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

  async realms(clusterId: string): Promise<Realm[]> {
    await wait(60);
    if (!this.clustersState.some((c) => c.id === clusterId)) throw new ApiError(404, 'not_found', 'unknown cluster');
    return [
      { realm: 'pam', type: 'pam', comment: 'Linux PAM standard authentication' },
      { realm: 'pve', type: 'pve', comment: 'Proxmox VE authentication server' },
      ...(clusterId === 'pve-lab' ? [{ realm: 'corp', type: 'openid', comment: 'Company SSO' }] : []),
    ];
  }

  async openidLogin(clusterId: string, realm: string) {
    await wait(200);
    if (!this.clustersState.some((c) => c.id === clusterId)) throw new ApiError(404, 'not_found', 'unknown cluster');
    // There is no identity provider in mock mode: come back the way a failed callback would.
    return { authUrl: `/?loginError=${encodeURIComponent(`The demo has no identity provider for realm ${realm}. Log in with a password instead.`)}` };
  }

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

  async clusters() { await wait(40); this.requireAuth(); return this.clustersState.map((c) => this.clusterView(c)); }

  async updateCluster(id: string, r: UpdateClusterRequest): Promise<Cluster> {
    await wait(); this.requireAuth();
    const c = this.clustersState.find((x) => x.id === id);
    if (!c) throw new ApiError(404, 'not_found', 'unknown cluster');
    if (!this.session!.clusters.find((x) => x.id === id)?.authed) throw new ApiError(403, 'forbidden', 'requires Sys.Modify on / in this cluster');
    if (r.name !== undefined) {
      if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/.test(r.name)) throw new ApiError(400, 'bad_request', 'invalid name');
      c.name = r.name;
      this.session!.clusters = this.session!.clusters.map((x) => (x.id === id ? { ...x, name: r.name! } : x));
    }
    if (r.endpoints) {
      if (!r.endpoints.length) throw new ApiError(400, 'bad_request', 'at least one endpoint');
      c.endpoints = r.endpoints;
    }
    if (r.shareLogin !== undefined) c.shareLogin = r.shareLogin;
    this.emit();
    return this.clusterView(c);
  }

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
      user: `${r.username}@${r.realm}`, csrf: rid(), version: '0.2.0-mock', galleyAdmin: true, expires: now() + 8 * 3600,
      clusters: this.clustersState.map((c) => {
        const authed = c.id === r.clusterId || c.id !== 'edge-01';
        return { id: c.id, name: c.name, authed, admin: authed };
      }),
    };
    return this.session;
  }

  async clusterLogin(id: string, r: ClusterLoginRequest): Promise<Me> {
    await wait(300); this.requireAuth();
    if (!r.password || r.password === 'wrong') throw new ApiError(401, 'login_failed', 'authentication failure');
    this.session = { ...this.session!, clusters: this.session!.clusters.map((c) => (c.id === id ? { ...c, authed: true, admin: true } : c)) };
    this.emit();
    return this.session;
  }

  async logout() { await wait(); this.session = null; }
  async me() { await wait(30); this.requireAuth(); return this.session!; }
  async getPref<T>(key: string): Promise<T> {
    await wait(40); this.requireAuth();
    if (!this.prefs.has(key)) throw new ApiError(404, 'not_found', 'no such preference');
    return structuredClone(this.prefs.get(key)) as T;
  }

  async putPref<T>(key: string, value: T): Promise<void> {
    await wait(40); this.requireAuth();
    if (JSON.stringify(value).length > 64 * 1024) throw new ApiError(400, 'bad_request', 'body must be JSON (max 64 KiB)');
    this.prefs.set(key, structuredClone(value));
  }

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
    this.requireClusterLogin(r.clusterId);
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
        title: `${label} ${ids.length === 1 ? ids[0] : `${ids.length} guests`}${action === 'guest.migrate' ? ` to ${p.target}` : ''}`,
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
      id: rid(), at: now(), updated: now(), user, actorUser: user, clusterId: plan.clusterId, action: plan.action, title: plan.title,
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
      entry.status = entry.ok ? 'ok' : 'error';
      publish();
      return { ...entry, results: entry.results.map((r) => ({ ...r })) };
    })();
    this.settled.set(entry.id, done);
    return { auditId: entry.id, status: 'running', results: [] };
  }

  async discardPlan(id: string) { await wait(40); this.requireAuth(); this.plans.delete(id); }

  async audit(limit = 100) { await wait(40); this.requireAuth(); return this.auditLog.slice(0, limit); }

  // ---------- metrics ----------
  async metrics(q: MetricQuery): Promise<MetricSeries> {
    await wait(80); this.requireAuth();
    return this.metricSeries(q);
  }

  async metricsBatch(qs: MetricQuery[]): Promise<MetricSeries[]> {
    await wait(120); this.requireAuth();
    if (!qs.length || qs.length > 32) throw new ApiError(400, 'bad_request', '1–32 queries required');
    return qs.map((q) => this.metricSeries(q));
  }

  private metricSeries(q0: MetricQuery): MetricSeries {
    const q = { ...q0, cf: q0.cf ?? 'AVERAGE' } as MetricQuery;
    const empty = (error: string): MetricSeries => ({ query: q, t: [], series: {}, error });
    const c = this.clustersState.find((x) => x.id === q.cluster);
    if (!c || !this.session?.clusters.find((x) => x.id === q.cluster)?.authed) return empty('not logged in to this cluster');
    const t = timeAxis(q.timeframe);
    if (q.kind === 'node') {
      const n = c.nodes.find((x) => x.name === q.id);
      return n ? { query: q, t, series: nodeSeries(c, n, t) } : empty('no such node');
    }
    if (q.kind === 'cluster') {
      const parts = c.nodes.map((n) => nodeSeries(c, n, t));
      return { query: q, t, series: sumSeries(parts, t.length) };
    }
    if (q.kind === 'guest') {
      const gx = this.guestsState.find((x) => x.clusterId === c.id && String(x.vmid) === q.id);
      return gx ? { query: q, t, series: guestSeries(gx, t) } : empty('no such guest');
    }
    if (q.kind === 'storage') {
      const [sid, node] = q.id.split('@');
      const st = mockStorage(c).find((x) => x.id === sid && (!node || x.node === node));
      return st ? { query: q, t, series: storageSeries(st, t) } : empty('no such storage');
    }
    return empty('kind must be cluster, node, guest or storage');
  }

  // ---------- read pass-through ----------
  private requireClusterLogin(clusterId: string) {
    const c = this.session!.clusters.find((x) => x.id === clusterId);
    if (!c?.authed) throw new ApiError(409, 'cluster_login_required', `log in to ${c?.name ?? clusterId} first`);
  }

  async pve<T>(clusterId: string, path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    await wait(90); this.requireAuth();
    const c = this.clustersState.find((x) => x.id === clusterId);
    if (!c) throw new ApiError(404, 'not_found', 'unknown cluster');
    this.requireClusterLogin(clusterId);
    const p = path.replace(/^\/+/, '');
    const notFound = () => new ApiError(404, 'pve_error', `404 Not Found: /${p}`);
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^nodes\/([^/]+)\/(qemu|lxc)\/(\d+)\/config$/))) {
      const gx = this.guestsState.find((x) => x.clusterId === clusterId && x.vmid === Number(m![3]) && x.type === m![2]);
      if (!gx) throw new ApiError(500, 'pve_error', `Configuration file 'nodes/${m[1]}/${m[2]}/${m[3]}.conf' does not exist`);
      return guestConfig(gx) as T;
    }
    if ((m = p.match(/^nodes\/([^/]+)\/(qemu|lxc)\/(\d+)\/snapshot$/))) {
      const vmid = Number(m[3]);
      const t0 = now();
      const snaps = vmid % 3 === 0
        ? [
            { name: 'pre-upgrade', description: 'Before the 9.2 upgrade', snaptime: t0 - 86400 * 12, vmstate: 0 },
            { name: 'driver-570', description: 'NVIDIA driver 570 installed', snaptime: t0 - 86400 * 3, parent: 'pre-upgrade', vmstate: 1 },
            { name: 'current', description: 'You are here!', parent: 'driver-570', running: 1 },
          ]
        : [{ name: 'current', description: 'You are here!', running: 1 }];
      return snaps as T;
    }
    if ((m = p.match(/^nodes\/([^/]+)\/tasks$/))) {
      const node = m[1];
      const vmid = query.vmid !== undefined ? String(query.vmid) : '';
      return this.taskLog
        .filter((t) => t.clusterId === clusterId && t.node === node && (!vmid || t.id === vmid))
        .slice(0, Number(query.limit ?? 50))
        .map((t) => ({ upid: t.upid, node: t.node, type: t.type, id: t.id, user: t.user, starttime: t.starttime, endtime: t.endtime, status: t.status })) as T;
    }
    if ((m = p.match(/^nodes\/([^/]+)\/status$/))) {
      const n = c.nodes.find((x) => x.name === m![1]);
      if (!n) throw notFound();
      const memUsed = this.guestsState.filter((x) => x.clusterId === clusterId && x.node === n.name).reduce((a, x) => a + x.mem, 0) + 9 * GiB;
      return {
        cpu: n.cpu, uptime: n.uptime, loadavg: [(n.cpu * n.maxcpu).toFixed(2), (n.cpu * n.maxcpu * 0.9).toFixed(2), (n.cpu * n.maxcpu * 0.8).toFixed(2)],
        kversion: `Linux ${n.kernel} #1 SMP PREEMPT_DYNAMIC PMX ${n.kernel}`, pveversion: 'pve-manager/9.2.32/2a0f1e3c',
        cpuinfo: { model: n.maxcpu === 16 ? 'AMD Ryzen 7 7700 8-Core Processor' : 'Intel(R) Xeon(R) Gold 6230 CPU @ 2.10GHz', sockets: n.maxcpu === 16 ? 1 : 2, cores: n.maxcpu / 2 / (n.maxcpu === 16 ? 1 : 2), cpus: n.maxcpu, mhz: '2100.000' },
        memory: { total: n.maxmem, used: memUsed, free: n.maxmem - memUsed },
        swap: { total: 8 * GiB, used: 0.2 * GiB, free: 7.8 * GiB },
        rootfs: { total: 94 * GiB, used: 11.2 * GiB, free: 82.8 * GiB, avail: 78 * GiB },
        'boot-info': { mode: 'efi', secureboot: 0 },
        'current-kernel': { release: n.kernel, sysname: 'Linux' },
      } as T;
    }
    if ((m = p.match(/^nodes\/([^/]+)\/network$/))) {
      if (!c.nodes.some((x) => x.name === m![1])) throw notFound();
      const i = c.nodes.findIndex((x) => x.name === m![1]);
      return [
        { iface: 'eno1', type: 'eth', active: 1, autostart: 1, method: 'manual' },
        { iface: 'enp65s0f0', type: 'eth', active: 1, autostart: 1, method: 'manual', comments: 'SFP-10G-T' },
        { iface: 'vmbr0', type: 'bridge', active: 1, autostart: 1, method: 'static', cidr: `192.0.2.${11 + i}/24`, gateway: '192.0.2.1', bridge_ports: 'eno1', 'bridge_vlan_aware': 1 },
        { iface: 'vmbr1', type: 'bridge', active: 1, autostart: 1, method: 'static', cidr: `10.10.0.${11 + i}/24`, bridge_ports: 'enp65s0f0', comments: 'Ceph and migration' },
      ] as T;
    }
    if ((m = p.match(/^nodes\/([^/]+)\/disks\/list$/))) {
      if (m[1] === 'pve2') throw new ApiError(403, 'pve_error', 'Permission check failed (/nodes/pve2, Sys.Audit)');
      if (!c.nodes.some((x) => x.name === m![1])) throw notFound();
      return [
        { devpath: '/dev/nvme0n1', model: 'Samsung SSD 990 PRO 2TB', serial: 'S7KHNJ0X100001', size: 2000398934016, type: 'nvme', health: 'PASSED', used: 'ZFS', wearout: 97 },
        { devpath: '/dev/sda', model: 'INTEL SSDSC2KG038T8', serial: 'PHYG0000000A3P8EGN', size: 3840755982336, type: 'ssd', health: 'PASSED', used: 'LVM', wearout: 99 },
        { devpath: '/dev/sdb', model: 'INTEL SSDSC2KG038T8', serial: 'PHYG0000000B3P8EGN', size: 3840755982336, type: 'ssd', health: 'PASSED', used: 'LVM', wearout: 100 },
      ] as T;
    }
    if ((m = p.match(/^nodes\/([^/]+)\/storage\/([^/]+)\/content$/))) {
      const sid = m[2];
      const st = mockStorage(c).find((x) => x.id === sid && x.node === m![1]) ?? mockStorage(c).find((x) => x.id === sid && x.shared);
      if (!st) throw notFound();
      if (st.status === 'unknown') throw new ApiError(500, 'pve_error', `storage '${sid}' is not online`);
      const gs = this.guestsState.filter((x) => x.clusterId === clusterId && (st.shared || x.node === st.node));
      const out: Record<string, unknown>[] = [];
      if (st.type === 'rbd' || st.type === 'zfspool') {
        for (const gx of gs.filter((x) => (x.vmid + (st.type === 'rbd' ? 0 : 1)) % 2 === 0)) {
          out.push({ volid: `${sid}:${gx.type === 'lxc' ? 'subvol' : 'vm'}-${gx.vmid}-disk-0`, content: gx.type === 'lxc' ? 'rootdir' : 'images', format: 'raw', size: gx.maxdisk, used: gx.disk, vmid: gx.vmid, ctime: now() - 86400 * (gx.vmid % 40) });
        }
      }
      if (st.type === 'cephfs' || st.type === 'dir') {
        out.push({ volid: `${sid}:iso/debian-13.1.0-amd64-netinst.iso`, content: 'iso', format: 'iso', size: 784 * 1024 ** 2, ctime: now() - 86400 * 30 });
        out.push({ volid: `${sid}:iso/ubuntu-24.04.3-live-server-amd64.iso`, content: 'iso', format: 'iso', size: 3.1 * GiB, ctime: now() - 86400 * 60 });
        out.push({ volid: `${sid}:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst`, content: 'vztmpl', format: 'tzst', size: 128 * 1024 ** 2, ctime: now() - 86400 * 20 });
        out.push({ volid: `${sid}:snippets/cloud-init-user.yaml`, content: 'snippets', format: 'snippet', size: 1400, ctime: now() - 86400 * 5 });
        for (const gx of gs.slice(0, 4)) out.push({ volid: `${sid}:backup/vzdump-${gx.type}-${gx.vmid}-2026_11_23-01_30_00.vma.zst`, content: 'backup', format: 'vma.zst', size: gx.disk * 0.35, vmid: gx.vmid, ctime: now() - 86400 });
      }
      return out as T;
    }
    if (p === 'cluster/backup') {
      if (clusterId !== 'pve-lab') return [] as T;
      return [
        { id: 'nightly-all', schedule: '01:30', storage: 'cephfs', mode: 'snapshot', compress: 'zstd', all: 1, exclude: '131', enabled: 1, 'notes-template': '{{guestname}}' },
        { id: 'weekly-db', schedule: 'sun 03:00', storage: 'cephfs', mode: 'snapshot', compress: 'zstd', vmid: '125', enabled: 1 },
      ].map((j) => (j.id === 'nightly-all' ? { ...j, exclude: [...this.guestsState.filter((x) => x.clusterId === clusterId && !this.backupJob.has(x.vmid) && !x.template).map((x) => x.vmid)].join(',') } : j)) as T;
    }
    throw notFound();
  }

  subscribe(h: EventHandlers): () => void {
    this.listeners.add(h);
    h.mode?.('live');
    if (this.session) setTimeout(() => this.emit(), 50);
    return () => { this.listeners.delete(h); };
  }
}
