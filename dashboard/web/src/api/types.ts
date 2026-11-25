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
  /** how user logins are kept (applies to new logins) */
  credentialMode?: CredentialMode;
  /** how host commands reach nodes; only where the user has Sys.Audit on / */
  hostTransport?: HostTransport;
  status: ClusterStatus;
}

/** ticket: the user's PVE ticket, renewed while the session is in use. token: a per-session API token created at login. */
export type CredentialMode = 'ticket' | 'token';
/** pve: PVE's node terminal as the acting user (root@pam only). ssh: galley's own SSH key. */
export type HostTransport = 'pve' | 'ssh';

export interface AddClusterRequest {
  name: string;
  endpoints: Endpoint[];
  tokenId: string;
  tokenSecret: string;
  shareLogin?: boolean;
}

export interface UpdateClusterRequest { name?: string; endpoints?: Endpoint[]; shareLogin?: boolean; credentialMode?: CredentialMode; hostTransport?: HostTransport }

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

export interface MeCluster {
  id: string; name: string; authed: boolean; admin?: boolean;
  /** Sys.Modify + Sys.Console + Permissions.Modify on /: may run host commands (older builds: use `admin`) */
  hostAdmin?: boolean;
  /** this session had a login here that lapsed (unused too long) or PVE refused: ask for the password again */
  loginExpired?: boolean;
  credentialMode?: CredentialMode;
}

export interface Me {
  user: string;
  csrf: string;
  version?: string;
  galleyAdmin?: boolean;
  /** idle expiry (moves with use) */
  expires?: number;
  /** hard end of the session, however active it is */
  maxExpires?: number;
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
  /** "assistant" for drafts the assistant proposed (always need typed confirmation) */
  source?: string;
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
  /** host.exec: the command's combined output (≤ 256 KiB), visible to the actor and administrators */
  output?: string;
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
  /** set when an agent acted for the user: "agent:<name>" */
  via?: string;
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

// ---- assistant ----

export interface AssistantStatus { enabled: boolean; state?: "ready" | "off" | "not_configured"; provider: string; model: string; dataNotice: string }

export type AssistantProvider = 'anthropic' | 'openai';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AssistantConfig {
  enabled: boolean;
  provider: AssistantProvider;
  baseUrl?: string;
  model: string;
  effort?: Effort | '';
  fallback: boolean;
  maxTokens?: number;
}

export interface AssistantSettings { config: AssistantConfig; hasApiKey: boolean }

/** PUT /api/settings/assistant: the key is write-only. */
export interface AssistantSettingsUpdate extends AssistantConfig { apiKey?: string; clearApiKey?: boolean }

export interface ChatRequest { conversationId?: string; message: string }

export interface ToolEvent { id: string; name: string; status: 'running' | 'ok' | 'error'; input?: Record<string, unknown>; error?: string }

/** One frame of POST /api/assistant/chat (text/event-stream). */
export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; tool: ToolEvent }
  | { type: 'change'; plan: Plan }
  | { type: 'done'; conversationId: string }
  | { type: 'error'; message: string };

// ---- API schema (GET /api/clusters/{id}/schema) ----

export interface SchemaParam {
  type?: string;
  description?: string;
  verbose_description?: string;
  optional?: number;
  default?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  pattern?: string;
  format?: unknown;
  typetext?: string;
  items?: SchemaParam;
  properties?: Record<string, SchemaParam>;
}

export interface SchemaMethod {
  method: string;
  name?: string;
  description?: string;
  protected?: number;
  permissions?: Record<string, unknown>;
  parameters?: SchemaParam;
  returns?: SchemaParam;
}

export interface SchemaPathEntry { path: string; text: string; methods: Record<string, string> }

export interface SchemaPathInfo { path: string; text: string; info: Record<string, SchemaMethod>; vars: Record<string, string> }

// ---- host commands ----

export interface HostPin { addr: string; fingerprint: string; pinnedBy: string; pinnedAt: number }
export interface HostNode { node: string; online: boolean; pin?: HostPin }
/** GET /api/clusters/{id}/hosts. The key and install line exist only with the ssh transport. */
export interface HostsInfo { transport: HostTransport; nodes: HostNode[]; note?: string; authorizedKey?: string; install?: string }
export interface HostScan { node: string; addr: string; fingerprint: string; verify: string }

// ---- consoles ----

export type ConsoleType = 'qemu' | 'lxc' | 'node';
export interface ConsoleRequest { type: ConsoleType; node: string; vmid?: number }
export interface ConsoleTicket { token: string; protocol: 'vnc' | 'term'; password: string; user: string; port: string }

/** The whole surface the SPA uses. Implemented over HTTP and in-memory (mock mode). */
// ---- help (GET /api/docs, GET /api/docs/{slug}) ----

/** One page of the user guide, without its body. `route` is the galley page it explains. */
export interface DocSummary { slug: string; title: string; summary: string; order: number; route?: string }
/** A user-guide page; markdown has no front matter. Relative links (`changes.md#x`) point to other pages. */
export interface Doc extends Omit<DocSummary, 'order'> { order?: number; markdown: string }

// ---- agents (GET/POST /api/agent-tokens, DELETE /api/agent-tokens/{id}) ----

/** read: query only. draft: also propose changes the user applies. apply: also apply changes itself. */
export type AgentScope = 'read' | 'draft' | 'apply';
export interface AgentToken { id: string; name: string; scope: AgentScope; created: number; lastSeen: number; expires: number }
export interface CreateAgentTokenRequest { name: string; scope: AgentScope; days: number }
/** `token` is shown once; `warnings` name clusters where PVE refused a token for the agent. */
export interface CreatedAgentToken { token: string; id: string; name: string; scope: AgentScope; expires: number; clusters: string[]; warnings?: string[] | null }

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
  /** GET /api/plans: the user's pending changes, newest first (including assistant and agent drafts). */
  plans(): Promise<Plan[]>;
  runPlan(id: string, confirm?: string): Promise<RunResult>;
  discardPlan(id: string): Promise<void>;
  audit(limit?: number): Promise<AuditEntry[]>;
  /** What every user may know about the assistant (no secrets). */
  assistantStatus(): Promise<AssistantStatus>;
  assistantSettings(): Promise<AssistantSettings>;
  putAssistantSettings(s: AssistantSettingsUpdate): Promise<void>;
  /**
   * POST /api/assistant/chat. Resolves when the stream ends; frames go to onEvent as they arrive.
   * A non-2xx answer (busy, conversation_full, assistant_disabled, 429) rejects with ApiError.
   */
  chat(req: ChatRequest, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void>;
  schemaPaths(clusterId: string): Promise<SchemaPathEntry[]>;
  /** The schema node for a concrete path, with the values of its template variables. */
  schema(clusterId: string, path: string): Promise<SchemaPathInfo>;
  hosts(clusterId: string): Promise<HostsInfo>;
  scanHost(clusterId: string, node: string): Promise<HostScan>;
  pinHost(clusterId: string, node: string, fingerprint: string): Promise<void>;
  unpinHost(clusterId: string, node: string): Promise<void>;
  openConsole(clusterId: string, req: ConsoleRequest): Promise<ConsoleTicket>;
  subscribe(h: EventHandlers): () => void;
  /**
   * Register (or clear, with null) the callback for any 401 outside of login: the session
   * ended server-side and the app must return to the login screen.
   */
  onUnauthorized(fn: (() => void) | null): void;
  /** The user guide's pages in reading order. */
  docs(): Promise<DocSummary[]>;
  agentTokens(): Promise<AgentToken[]>;
  createAgentToken(req: CreateAgentTokenRequest): Promise<CreatedAgentToken>;
  deleteAgentToken(id: string): Promise<void>;
  doc(slug: string): Promise<Doc>;
  /** GET /api/whats-new: release notes, newest first. */
  whatsNew(): Promise<WhatsNew>;
  /** GET /api/feedback: whether Send feedback is on, and the GitHub repository it files to. */
  feedback(): Promise<FeedbackConfig>;
  /** GET /api/agent-policy: what apply-scope agent tokens need a person for. */
  agentPolicy(): Promise<AgentPolicy>;
  /** PUT /api/settings/agents (galley admins). */
  putAgentPolicy(p: AgentPolicy): Promise<AgentPolicy>;
  /** PUT /api/settings/feedback (galley admins). */
  putFeedback(c: FeedbackConfig): Promise<FeedbackConfig>;
}

// ---- what's new and feedback ----

export interface Release { version: string; date: string; markdown: string }
export interface WhatsNew { version: string; releases: Release[] }
/** What needs a person, strictest first. all: every change; risky: all but routine guest work (default); hosts: host commands and access changes; always: nothing. */
export type AgentApproval = 'all' | 'risky' | 'hosts' | 'always';
export interface AgentPolicy { approval: AgentApproval }
export interface FeedbackConfig { enabled: boolean; repo: string }
