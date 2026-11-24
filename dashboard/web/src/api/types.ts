// Types mirror dashboard/docs/api.md exactly. Times are Unix seconds, sizes bytes,
// CPU a 0–1 fraction.

/** Public, pre-login: whether setup is needed and which clusters can be logged into. */
export interface SetupInfo { needsSetup: boolean; clusters: { id: string; name: string }[] }

export interface ApiErrorBody { error: string; code: string; /** seconds, with code "rate_limited" (429) */ retryAfter?: number }

export interface Probe {
  host: string;
  reachable: boolean;
  fingerprint: string;
  trustedBySystem: boolean;
  error?: string;
}

export interface Endpoint { host: string; fingerprint: string }

export interface ClusterStatus {
  reachable: boolean;
  quorate: boolean;
  /** absent when the user lacks Sys.Audit on / of that cluster */
  nodes?: number;
  nodesOnline?: number;
  activeEndpoint?: string;
  lastPoll: number;
  error?: string;
}

export interface Cluster {
  id: string;
  name: string;
  authed?: boolean;
  admin?: boolean;
  /** only where the user has Sys.Audit on / */
  endpoints?: Endpoint[];
  tokenId?: string;
  shareLogin?: boolean;
  brokenSecret?: boolean;
  status: ClusterStatus;
}

export interface AddClusterRequest {
  name: string;
  endpoints: Endpoint[];
  tokenId: string;
  tokenSecret: string;
  shareLogin?: boolean;
}

export interface UpdateClusterRequest { name?: string; endpoints?: Endpoint[]; shareLogin?: boolean }

export interface LoginRequest {
  clusterId: string;
  username: string;
  realm: string;
  password: string;
  otp?: string;
}

/** Adds a credential for one more cluster; the identity (user@realm) is the session's. */
export interface ClusterLoginRequest { password: string; otp?: string }

/** A PVE authentication realm (GET /api/realms?cluster=). */
export interface Realm { realm: string; type: string; comment?: string; tfa?: string }

export interface MeCluster { id: string; name: string; authed: boolean; admin?: boolean }

export interface Me {
  user: string;
  csrf: string;
  version?: string;
  galleyAdmin?: boolean;
  expires?: number;
  clusters: MeCluster[];
}

export interface Node {
  name: string;
  online: boolean;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  uptime: number;
  guests: number;
  kernel?: string;
  pveversion?: string;
}

export interface Ceph {
  health: string;
  osdsUp: number;
  osdsIn: number;
  osdsTotal: number;
  usedBytes: number;
  totalBytes: number;
}

export interface Storage {
  id: string;
  node: string;
  type: string;
  shared: boolean;
  used: number;
  total: number;
  active: boolean;
  /** PVE's raw status ("available", "unknown", …) */
  status?: string;
  disabled?: boolean;
}

export interface Backups { known?: boolean; covered: number; total: number; unprotected: number[] }

export interface ClusterSummary {
  id: string;
  name: string;
  quorate: boolean;
  nodes: Node[];
  ceph: Ceph | null;
  storage: Storage[];
  ha: { quorum: boolean; resources: number; errors: number };
  backups: Backups;
  lastPoll?: number;
  lastSuccess?: number;
  stale?: boolean;
  /** section → message, for sections whose latest read failed */
  errors?: Record<string, string>;
}

export type FindingLevel = 'INFO' | 'WARN' | 'CRIT';

export interface Fix {
  action: string;
  params: Record<string, unknown>;
  label: string;
}

export interface FindingResource { kind: 'cluster' | 'node' | 'guest' | 'storage'; id: string; node?: string }

export interface Finding {
  id: string;
  level: FindingLevel;
  check: string;
  clusterId: string;
  where: string;
  message: string;
  resource?: FindingResource;
  fix?: Fix;
}

export interface Fleet {
  updatedAt: number;
  totals: { clusters: number; nodes: number; nodesOnline: number; guests: number; running: number };
  clusters: ClusterSummary[];
  findings: Finding[];
}

export type GuestType = 'qemu' | 'lxc';

export interface Guest {
  clusterId: string;
  vmid: number;
  name: string;
  type: GuestType;
  node: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  tags: string[];
  template: boolean;
  hastate?: string;
}

export interface GuestFilter { cluster?: string; q?: string; status?: string; type?: string }

export interface Task {
  clusterId: string;
  upid: string;
  node: string;
  type: string;
  id: string;
  user: string;
  starttime: number;
  endtime?: number;
  status?: string;
}

export interface Step {
  description: string;
  method: string;
  path: string;
  body: Record<string, unknown>;
  cli: string;
}

export interface Plan {
  id: string;
  action: string;
  title: string;
  summary: string;
  clusterId: string;
  destructive: boolean;
  confirmText?: string;
  steps: Step[];
  createdAt: number;
  expiresAt: number;
}

export interface PlanRequest {
  action: string;
  clusterId: string;
  params: Record<string, unknown>;
}

export type StepStatus = 'running' | 'ok' | 'error' | 'unknown';

export interface StepResult {
  step: number;
  ok: boolean;
  upid?: string;
  error?: string;
  /** async runs: per-step progress (absent on the legacy synchronous shape) */
  status?: StepStatus;
  /** PVE task exit status, e.g. "OK" or "command 'qm start 120' failed: exit code 1" */
  exitstatus?: string;
}

/** Overall status of a run: "running" until finished, then "ok"/"error" (older builds: "done"). */
export type RunStatus = 'running' | 'ok' | 'error' | 'done';

/**
 * POST /api/plans/{id}/run. Either the synchronous 200 shape ({auditId, results} with every
 * step finished) or the async 202 shape ({auditId, status:"running"}), after which progress
 * arrives as `event: audit` frames whose id equals auditId. HttpApi normalises a missing
 * `results` to [].
 */
export interface RunResult { auditId: string; status?: RunStatus; results: StepResult[] }

export interface AuditEntry {
  id: string;
  at: number;
  updated?: number;
  user: string;
  actorUser?: string;
  clusterId: string;
  action: string;
  title: string;
  cli: string[];
  ok: boolean;
  results: StepResult[];
  /** async runs: 'running' until every step has finished */
  status?: RunStatus;
}

export interface GuestTarget { vmid: number; node: string; type: GuestType }

// ---- metrics (GET/POST /api/metrics) ----

export type MetricKind = 'cluster' | 'node' | 'guest' | 'storage';
export type Timeframe = 'hour' | 'day' | 'week' | 'month' | 'year';

/** Normalized series names (see internal/server/metrics.go). */
export type MetricName =
  | 'cpu' | 'cpus' | 'memUsed' | 'memTotal' | 'swapUsed' | 'swapTotal' | 'rootUsed' | 'rootTotal'
  | 'diskUsed' | 'diskTotal' | 'netIn' | 'netOut' | 'diskRead' | 'diskWrite' | 'ioWait' | 'load'
  | 'pressureCpu' | 'pressureIo' | 'pressureMem';

export interface MetricQuery {
  cluster: string;
  kind: MetricKind;
  /** node name, vmid, or storage[@node]; "" for a cluster */
  id: string;
  timeframe: Timeframe;
  cf?: 'AVERAGE' | 'MAX';
}

export interface MetricSeries {
  query: MetricQuery;
  t: number[];
  /** null = no sample (a gap, never zero) */
  series: Partial<Record<MetricName, (number | null)[]>>;
  error?: string;
}

export interface EventHandlers {
  fleet?: (f: Fleet) => void;
  tasks?: (t: Task[]) => void;
  audit?: (a: AuditEntry) => void;
  /** live = SSE connected; polling = fallback while the stream is down (it keeps retrying) */
  mode?: (m: 'live' | 'polling') => void;
}

/** The whole surface the SPA uses. Implemented over HTTP and in-memory (mock mode). */
export interface Api {
  health(): Promise<{ ok: boolean; version?: string; status?: string }>;
  setup(): Promise<SetupInfo>;
  realms(clusterId: string): Promise<Realm[]>;
  /** setupToken: the installer's one-time setup code, required while no cluster is registered */
  probe(endpoints: string[], setupToken?: string): Promise<{ endpoints: Probe[] }>;
  addCluster(req: AddClusterRequest, setupToken?: string): Promise<Cluster>;
  clusters(): Promise<Cluster[]>;
  updateCluster(id: string, req: UpdateClusterRequest): Promise<Cluster>;
  removeCluster(id: string): Promise<void>;
  login(req: LoginRequest): Promise<Me>;
  openidLogin(clusterId: string, realm: string): Promise<{ authUrl: string }>;
  clusterLogin(id: string, req: ClusterLoginRequest): Promise<Me>;
  logout(): Promise<void>;
  me(): Promise<Me>;
  getPref<T>(key: string): Promise<T>;
  putPref<T>(key: string, value: T): Promise<void>;
  fleet(): Promise<Fleet>;
  guests(f?: GuestFilter): Promise<Guest[]>;
  tasks(f?: { cluster?: string; limit?: number }): Promise<Task[]>;
  targets(clusterId: string, node: string): Promise<string[]>;
  metrics(q: MetricQuery): Promise<MetricSeries>;
  /** 1–32 queries, answered in order; a failed query carries `error` */
  metricsBatch(qs: MetricQuery[]): Promise<MetricSeries[]>;
  /** Read pass-through: GET /api/clusters/{id}/pve/{path}, run as the user (PVE ACLs apply). */
  pve<T>(clusterId: string, path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  createPlan(req: PlanRequest): Promise<Plan>;
  runPlan(id: string, confirm?: string): Promise<RunResult>;
  discardPlan(id: string): Promise<void>;
  audit(limit?: number): Promise<AuditEntry[]>;
  subscribe(h: EventHandlers): () => void;
  /**
   * Register (or clear, with null) the callback for any 401 outside of login: the session
   * ended server-side and the app must return to the login screen.
   */
  onUnauthorized(fn: (() => void) | null): void;
}
