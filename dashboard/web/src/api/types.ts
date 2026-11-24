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
  nodes: number;
  nodesOnline: number;
  activeEndpoint: string;
  lastPoll: number;
  error?: string;
}

export interface Cluster {
  id: string;
  name: string;
  endpoints: Endpoint[];
  status: ClusterStatus;
}

export interface AddClusterRequest {
  name: string;
  endpoints: Endpoint[];
  tokenId: string;
  tokenSecret: string;
}

export interface LoginRequest {
  clusterId: string;
  username: string;
  realm: string;
  password: string;
  otp?: string;
}

export type ClusterLoginRequest = Omit<LoginRequest, 'clusterId'>;

export interface Me {
  user: string;
  csrf: string;
  clusters: { id: string; name: string; authed: boolean }[];
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
}

export interface ClusterSummary {
  id: string;
  name: string;
  quorate: boolean;
  nodes: Node[];
  ceph: Ceph | null;
  storage: Storage[];
  ha: { quorum: boolean; resources: number; errors: number };
  backups: { covered: number; total: number; unprotected: number[] };
}

export type FindingLevel = 'INFO' | 'WARN' | 'CRIT';

export interface Fix {
  action: string;
  params: Record<string, unknown>;
  label: string;
}

export interface Finding {
  id: string;
  level: FindingLevel;
  check: string;
  clusterId: string;
  where: string;
  message: string;
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

export type StepStatus = 'running' | 'ok' | 'error';

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

/**
 * POST /api/plans/{id}/run. Either the synchronous 200 shape ({auditId, results} with every
 * step finished) or the async 202 shape ({auditId, status:"running"}), after which progress
 * arrives as `event: audit` frames whose id equals auditId. HttpApi normalises a missing
 * `results` to [].
 */
export interface RunResult { auditId: string; status?: 'running' | 'done'; results: StepResult[] }

export interface AuditEntry {
  id: string;
  at: number;
  user: string;
  clusterId: string;
  action: string;
  title: string;
  cli: string[];
  ok: boolean;
  results: StepResult[];
  /** async runs: 'running' until every step has finished */
  status?: 'running' | 'done';
}

export interface GuestTarget { vmid: number; node: string; type: GuestType }

export interface EventHandlers {
  fleet?: (f: Fleet) => void;
  tasks?: (t: Task[]) => void;
  audit?: (a: AuditEntry) => void;
  /** live = SSE connected; polling = fallback while the stream is down (it keeps retrying) */
  mode?: (m: 'live' | 'polling') => void;
}

/** The whole surface the SPA uses. Implemented over HTTP and in-memory (mock mode). */
export interface Api {
  health(): Promise<{ ok: boolean; version: string }>;
  setup(): Promise<SetupInfo>;
  /** setupToken: the installer's one-time setup code, required while no cluster is registered */
  probe(endpoints: string[], setupToken?: string): Promise<{ endpoints: Probe[] }>;
  addCluster(req: AddClusterRequest, setupToken?: string): Promise<Cluster>;
  clusters(): Promise<Cluster[]>;
  removeCluster(id: string): Promise<void>;
  login(req: LoginRequest): Promise<Me>;
  clusterLogin(id: string, req: ClusterLoginRequest): Promise<Me>;
  logout(): Promise<void>;
  me(): Promise<Me>;
  fleet(): Promise<Fleet>;
  guests(f?: GuestFilter): Promise<Guest[]>;
  tasks(f?: { cluster?: string; limit?: number }): Promise<Task[]>;
  targets(clusterId: string, node: string): Promise<string[]>;
  createPlan(req: PlanRequest): Promise<Plan>;
  runPlan(id: string, confirm?: string): Promise<RunResult>;
  audit(limit?: number): Promise<AuditEntry[]>;
  subscribe(h: EventHandlers): () => void;
  /**
   * Register (or clear, with null) the callback for any 401 outside of login: the session
   * ended server-side and the app must return to the login screen.
   */
  onUnauthorized(fn: (() => void) | null): void;
}
