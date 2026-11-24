# galley HTTP API (v0)

All endpoints are JSON under `/api`. The SPA uses exactly this API; so can scripts and the
MCP server. Times are Unix seconds. Sizes are bytes. CPU is a 0–1 fraction (as PVE reports).

## Auth model

galley holds no authority of its own over clusters.

- **Service token (per cluster, read-only):** feeds the background poller's shared cache.
  Registration refuses tokens that hold any write privilege (`Sys.Modify`, `VM.PowerMgmt`,
  `VM.Allocate`, …) and requires `Sys.Audit` on `/` — i.e. the `PVEAuditor` role
  (`recipes/admin/users-roles-tokens.md`). Never used for anything a user sees unfiltered.
- **User identity = PVE identity:** `POST /api/login` (password, TOTP/recovery code) or
  OpenID Connect through a PVE `openid` realm. galley stores the user's PVE ticket per cluster
  (AES-GCM encrypted), renews it in the background, and uses it for:
  - **every read shown to that user** — cache data is filtered by what PVE returns from
    `/cluster/resources` and `/access/permissions` for that user (re-checked every 30 s);
    cluster-wide state (Ceph, HA, corosync, all tasks, audit of other users) needs
    `Sys.Audit` on `/`;
  - **every change** — so PVE ACLs apply and PVE's task log shows the real user.
- **One session = one identity.** Adding a cluster login to a session must use the same
  `user@realm`. Credentials are reused on other clusters only between clusters an admin
  marked `shareLogin` (same realm, e.g. LDAP/AD).
- **Sessions** are stored server-side (hashed id), survive restarts, idle-expire after 8 h and
  hard-expire after 24 h. Cookie `galley_session`: HttpOnly, Secure, SameSite=Lax.
- **CSRF:** authenticated mutations need `X-Galley-CSRF: <csrf>` from `GET /api/me`. All
  mutations (including login and setup) must be `Content-Type: application/json` and must not
  carry a cross-site `Origin` / `Sec-Fetch-Site`.
- **Rate limits:** login failures are limited per client IP (IPv6 per /64) and per username
  (10 per 15 min, counted before the attempt completes so parallel guesses cannot exceed it;
  30 attempts per minute; an unreachable cluster does not count) → `429 {"code":"rate_limited","retryAfter":seconds}` + `Retry-After`.
- **Admin rights:** renaming or removing a cluster needs `Sys.Modify` on `/` *of that
  cluster*. Adding a cluster, changing a cluster's endpoints (they decide where passwords are
  sent) or enabling `shareLogin` needs a **galley admin**: `Sys.Modify` on `/` in every
  registered cluster, or `galley --admin cluster:user@realm` while logged in to that cluster
  as that user.
- A login is rejected if the cluster answers for a different user than the one requested.
- Errors: HTTP status + `{"error": "message", "code": "snake_case"}`. Only `401` with code
  `unauthenticated` means the galley session ended; `login_failed` / `otp_required` are
  credential answers; `409 cluster_login_required` means this session has no (valid) login
  for that cluster.
- **Tasks:** like PVE, you see only your own tasks unless you hold `Sys.Audit` on `/`.

## Setup & clusters

| Method & path | Body | Response |
|---|---|---|
| `GET /api/health` | – | `{"ok":true,"status":"ok"\|"degraded","clusters":n,"staleClusters":n}`; `503` if the database is down |
| `GET /api/setup` | – | `{"needsSetup":bool,"clusters":[{"id","name"}]}` |
| `GET /api/realms?cluster=id` | – | PVE realms (for the login form; `type:"openid"` offers SSO) |
| `POST /api/clusters/probe` | `{"endpoints":["192.0.2.11","192.0.2.12:8006"]}` | `{"endpoints":[Probe]}` |
| `POST /api/clusters` | `{"name","endpoints":[{"host","fingerprint"}],"tokenId":"galley@pve!poller","tokenSecret","shareLogin"?}` | `201 Cluster` |
| `GET /api/clusters` | – | `[Cluster]` (endpoints/token id only where the user has `Sys.Audit`) |
| `PUT /api/clusters/{id}` | `{"name"?,"endpoints"?,"shareLogin"?}` | `Cluster` — rename, re-pin certificates after renewal, toggle login sharing |
| `DELETE /api/clusters/{id}` | – | `204` |

**First run:** while no cluster is registered, galley writes a one-time setup code to
`<data>/setup-token` (and logs it). `probe` and the first `POST /api/clusters` require header
`X-Galley-Setup-Token: <code>` (`401 setup_token_required`, `403 setup_token_invalid`). The
file is removed once the first cluster is registered.

`Probe` = `{"host","reachable":bool,"fingerprint":"AB:CD:…"(sha256 of leaf cert),"trustedBySystem":bool,"error"?}`

`Cluster` = `{"id","name","authed","admin","endpoints"?,"tokenId"?,"shareLogin"?,"status":{"reachable","quorate","nodes","nodesOnline","activeEndpoint","lastPoll","error"?}}`

TLS: an endpoint is accepted if its certificate verifies against system roots **or** its
leaf SHA-256 fingerprint equals the pinned one. Reads fail over across endpoints in order;
mutations fail over only if the request never reached a node (or pveproxy answered 595/596),
so a change is never sent twice.

## Session

| Method & path | Body | Response |
|---|---|---|
| `POST /api/login` | `{"clusterId","username":"root","realm":"pam","password","otp"?}` | `Me` + cookie. `otp` may be a TOTP code or `recovery:<code>`. |
| `POST /api/login/openid` | `{"clusterId","realm"}` | `{"authUrl"}` — send the browser there |
| `GET /api/login/openid/callback` | (from the IdP) | `303 /` with a session, or `303 /?loginError=…` |
| `POST /api/clusters/{id}/login` | `{"password","otp"?}` | `Me` (adds a credential for one more cluster, same identity) |
| `POST /api/logout` | `{}` | `204` |
| `GET /api/me` | – | `Me` or `401` |
| `GET/PUT /api/prefs/{key}` | any JSON ≤ 64 KiB | per-user preferences (e.g. dashboard layout) |

`Me` = `{"user":"root@pam","csrf","version","galleyAdmin":bool,"expires","clusters":[{"id","name","authed":bool,"admin":bool}]}`

For SSO, the PVE `openid` realm's IdP client must allow
`https://<galley-host>/api/login/openid/callback` as a redirect URI. Run galley with
`--public-url https://<galley-host>` so the redirect does not depend on the request's Host
header. The flow is bound to the starting browser by a short-lived `galley_oidc` cookie.

## Read models (from the poller cache)

`GET /api/fleet` →

```json
{
  "updatedAt": 0,
  "totals": {"clusters":2,"nodes":4,"nodesOnline":4,"guests":23,"running":20},
  "clusters": [ClusterSummary],
  "findings": [Finding]
}
```

`updatedAt` is the oldest `lastSuccess` across clusters (0 when there are no clusters or any
cluster has never been read successfully). Use the per-cluster fields below for liveness.

`ClusterSummary` = `{"id","name","quorate","nodes":[Node],"ceph":Ceph|null,"storage":[Storage],"ha":{"quorum":bool,"resources":int,"errors":int},"backups":{"known":bool,"covered":int,"total":int,"unprotected":[vmid]},"lastPoll","lastSuccess","stale":bool,"errors"?:{"<section>":"message"}}`

- `lastPoll` — start of the latest poll attempt. `lastSuccess` — last poll that read both
  `/cluster/status` and `/cluster/resources` (0 = never).
- `stale` — the latest poll could not read status+resources, or none succeeded within 3 poll
  intervals. The rest of the summary is then the last good data, not current.
- `errors` — sections whose latest read failed (omitted when all are current). Each section
  keeps its last good data on failure. Sections: `status`, `resources`, `ceph`, `ha`,
  `backup-jobs`, `backup-coverage`, `corosync`, `firewall`, `tasks`, `storage-config`
  (`GET /storage`, refreshed every 60 s), `node-details` (kernel/version/updates, every 60 s).
- `backups.known` — false when backup coverage could not be read on the latest poll; then
  `covered` is 0 and `unprotected` is the last known list. Never treat unknown as covered.

`Node` = `{"name","online","cpu","maxcpu","mem","maxmem","uptime","guests","kernel"?,"pveversion"?}`

`Ceph` = `{"health":"HEALTH_OK","osdsUp","osdsIn","osdsTotal","usedBytes","totalBytes"}`

`Storage` = `{"id","node","type","shared":bool,"used","total","active":bool,"status","disabled"?:bool}`
— `status` is PVE's raw value; PVE reports `unknown` both for disabled storage and for enabled
storage it cannot reach, so `disabled` (from the storage configuration) tells them apart.

`Finding` = `{"id","level":"INFO|WARN|CRIT","check","clusterId","where","message","resource":{"kind","id","node"?},"fix"?:{"action","params":{},"label"}}`

`resource` says what the finding is about (for per-user filtering):

| `kind` | `id` | `node` | checks |
|---|---|---|---|
| `cluster` | `""` | – | `reachability`, `quorum`, `ceph`, `ceph-osd`, `ha-quorum`, `corosync-links`, `firewall`, `backup-jobs`, `<section>-unknown` |
| `node` | node name | node name | `node-offline`, `updates` |
| `guest` | vmid (decimal string) | guest's node, if known | `backup-coverage`, `ha-resource` |
| `storage` | storage id | node, for non-shared storage only | `storage` (fill level), `storage-offline` |

Notable checks: `<section>-unknown` (WARN, "could not read <what>: <error>") for every section
that failed on the latest poll; `reachability` (CRIT) when the API cannot be reached at all;
`storage-offline` (CRIT) when an enabled storage is not `available` (one finding per shared
storage listing the affected nodes; one per node for local storage); `ha-resource` (CRIT) for
HA services in state `error`, `fence` or `recovery`.

`GET /api/guests?cluster=&q=&status=&type=` → `[Guest]`

`Guest` = `{"clusterId","vmid","name","type":"qemu|lxc","node","status","cpu","maxcpu","mem","maxmem","disk","maxdisk","uptime","tags":[],"template":bool,"hastate"?}`

`GET /api/tasks?cluster=&limit=50` → `[Task]` newest first

`Task` = `{"clusterId","upid","node","type","id","user","starttime","endtime"?,"status"?}`

`GET /api/nodes/{clusterId}/{node}/targets` → `["pve2","pve3"]` (migration targets, online nodes except source)

## Metrics (one model for every resource)

`GET /api/metrics?cluster=&kind=cluster|node|guest|storage&id=&timeframe=hour|day|week|month|year&cf=AVERAGE|MAX`
→ `{"query":{…},"t":[unix…],"series":{"cpu":[0.12,null,…],…},"error"?}`

`POST /api/metrics {"queries":[MetricQuery…]}` (≤ 32) → `[MetricSeries]` in order.

Normalized from PVE's rrddata: `cpu` (0–1), `cpus`, `memUsed`, `memTotal`, `swapUsed`,
`swapTotal`, `rootUsed`, `rootTotal`, `diskUsed`, `diskTotal` (bytes), `netIn`, `netOut`,
`diskRead`, `diskWrite` (bytes/s), `ioWait` (0–1), `load`, `pressureCpu`, `pressureIo`,
`pressureMem` (PSI some avg10, %). `null` is a missing sample. `id` is a node name, a vmid,
or `storage[@node]`; `kind=cluster` sums the cluster's online nodes (cpu weighted by cpus) and
needs `Sys.Audit` on `/`. Each query is authorized against the user's PVE view.

## Reading anything from PVE

`GET /api/clusters/{id}/pve/{path}?{query}` → `{"data": …}` — a GET against the PVE API
**as the user** (PVE checks permissions). Detail pages and the resource editor read through it.

## API schema (create, read, update, delete for everything)

galley loads each cluster's own API schema (`/pve-docs/api-viewer/apidoc.js`, matching that
cluster's PVE version; cached 6 h).

- `GET /api/clusters/{id}/schema` → `[{"path":"/nodes/{node}/qemu/{vmid}/config","text","methods":{"GET":"…","PUT":"…"}}]`
- `GET /api/clusters/{id}/schema?path=/nodes/pve1/qemu/120/config` → `{"path","text","info":{method: {description, permissions, parameters, returns}},"vars":{"node":"pve1","vmid":"120"}}`

## Consoles

`POST /api/clusters/{id}/console {"type":"qemu"|"lxc"|"node","node","vmid"?}` asks PVE, as the
user (`VM.Console` / `Sys.Console` apply), for a console ticket →
`{"token","protocol":"vnc"|"term","password","user","port"}`. Then open the websocket
`GET /api/console/{token}` (same origin, one use, valid 1 minute); galley proxies it to PVE's
`vncwebsocket` over the pinned TLS connection. `vnc`: noVNC with `password`. `term`: send
`<user>:<password>\n` first, then PVE termproxy frames (`0:<len>:<data>`, resize `1:<cols>:<rows>:`).

## Host commands (outside the PVE API)

For what the API cannot do (NIC flow control, kernel parameters, disks, packages). Needs
administrator rights on `/` of that cluster (`Sys.Modify`, `Sys.Console`, `Permissions.Modify`).

- `GET /api/clusters/{id}/hosts` → nodes with their pinned SSH endpoint, galley's public key
  (`restrict ssh-ed25519 …`) and the line that installs it cluster-wide
  (`/etc/pve/priv/authorized_keys`).
- `POST /api/clusters/{id}/hosts/{node}/scan` → `{"addr","fingerprint"}` read from the node's SSH
  server — compare with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the node.
- `PUT /api/clusters/{id}/hosts/{node} {"fingerprint"}` pins it after galley re-reads the key
  from the node's own cluster address (from `/cluster/status`; it cannot be pointed elsewhere)
  and it matches; `DELETE` unpins. galley uses a separate SSH key per cluster.
- Change action `host.exec {"node","command","reason"?}` — always needs typed confirmation
  `run on <node>`; output (≤ 256 KiB) and exit status are recorded in the audit log, visible only
  to the actor and administrators. Connections to a host whose key differs from the pin are refused.

## Assistant

- `GET /api/assistant` → `{"enabled","provider","model","dataNotice"}`
- `GET/PUT /api/settings/assistant` (galley admins) → `{"config":{"enabled","provider":"anthropic"|"openai","baseUrl"?,"model","effort"?,"fallback","maxTokens"?},"hasApiKey"}`.
  The API key is write-only (`"apiKey"` to set, `"clearApiKey":true` to remove); stored encrypted.
- `POST /api/assistant/chat {"conversationId"?, "message"}` → `text/event-stream` with
  `text {"delta"}`, `tool {"id","name","status":"running"|"ok"|"error","input"?,"error"?}`,
  `change {Plan}` (a drafted change — show it in Changes), `done {"conversationId"}`,
  `error {"message"}`.

The assistant's tools run with the user's PVE permissions (`list_resources`, `get_findings`,
`list_tasks`, `pve_get`, `get_metrics`, `api_schema`) and can only **draft** changes
(`propose_change`, `propose_host_command` for administrators). Nothing is applied until the user
applies it, and drafts are marked `"source":"assistant"`, titled "Assistant draft: …" and always
need typed confirmation (`apply N steps`), so text the model read from the cluster can never become
a one-click change. Conversations are capped (~400 KB); start a new one when told. Default model: `claude-opus-5-5` with Anthropic's server-side refusal fallback;
OpenAI-compatible endpoints (OpenAI, xAI, OpenRouter, vLLM, Ollama) are supported via `baseUrl`.

## Plans (every mutation goes through a plan)

`POST /api/plans` `{"action","clusterId","params":{}}` → `Plan`

`Plan` = `{"id","action","title","summary","clusterId","destructive":bool,"confirmText"?:"destroy 120","steps":[Step],"createdAt","expiresAt"}`

`Step` = `{"description","method":"POST","path":"/nodes/pve1/qemu/120/status/start","body":{},"cli":"qm start 120"}`

MVP actions (`params`):

| action | params | destructive |
|---|---|---|
| `guest.start` / `guest.shutdown` / `guest.stop` / `guest.reboot` | `{"targets":[{"vmid","node","type"}]}` | stop: no confirm text, but flagged |
| `guest.migrate` | `{"targets":[…],"target":"pve2","online":true}` | no |
| `guest.snapshot` | `{"targets":[…],"name":"pre-upgrade","description"?}` | no |
| `guest.destroy` | `{"targets":[{"vmid","node","type"}]}` | **yes** — `confirmText` = `destroy <vmid>[,<vmid>…]` |
| `backup.protect` | `{"vmids":[131],"job":"nightly-all"}` | no |
| `host.exec` | `{"node","command","reason"?}` | **always** — `run on <node>` (administrators only) |
| `api.call` | `{"title"?,"summary"?,"calls":[{"method":"POST\|PUT\|DELETE","path":"/nodes/pve1/qemu/300/config","body":{"hostpci1":"mapping=gpu-a2-1,pcie=1"}}]}` (1–20 calls) | DELETEs and destructive paths (`status/stop`, `rollback`, disk wipes…) — `confirmText` = `delete qemu/300`, `confirm …` or `apply N changes` |

`api.call` is the generic create/update/delete: each call is validated against the cluster's
API schema (method exists, every body key is a parameter — indexed families like `net0`
match `net[n]` — types, ranges, enums, required parameters) and shown with its `pvesh`
equivalent. It runs as the user like every other change. Paths must be canonical (no trailing
slash, no percent-encoding). A call is destructive — typed confirmation — when it deletes, or its
matched schema path stops/resets/rolls back/wipes/initializes disks or changes passwords, or its
body deletes options, purges, forces, reboots or shuts down a node, removes ACLs, toggles a
firewall, or stops an HA resource. Secret parameters (passwords, tokens, keys) are redacted from
the CLI text and the audit log.

`POST /api/plans/{id}/run` `{"confirm"?: "destroy 120"}` → `202 {"auditId","status":"running","results":[]}`

The change is recorded in the audit log as `running` **before** anything is sent, then runs in
the background (independent of the browser) as the user. Each step that returns a PVE task
(UPID) is followed to completion; a step only counts as `ok` when its task exits `OK`
(or with warnings). The first failure stops the change. Progress and the outcome arrive as
SSE `audit` events and in `GET /api/audit`. Changes interrupted by a galley restart are
marked `error` with a note to check the PVE task log.

`Result` = `{"step","status":"running"|"ok"|"error"|"unknown","ok":bool,"upid"?,"exitstatus"?,"error"?}`

`unknown` means galley stopped following a task that may still be running in PVE (after
6 hours, or a galley restart). Long changes keep working across ticket renewals: every
request presents the user's current ticket.

`DELETE /api/plans/{id}` discards a pending plan. Plans expire after 10 minutes, run at most
once, are visible only to their owner (max 50 pending per user), and only target guests the
user can see.

## Audit

`GET /api/audit?limit=100` → `[{"id","at","updated","user","actorUser","clusterId","action","title","cli":["…"],"status":"running"|"ok"|"error","ok":bool,"results":[Result]}]`

`user` is the galley session's identity, `actorUser` the PVE identity the change ran as.
Entries are scoped to their cluster: you see an entry if you are logged in to that cluster
and either hold `Sys.Audit` on `/` there or `actorUser` is you.
Besides plans, the log records logins (`auth.login`, including failures with the client IP)
and cluster administration (`cluster.add`, `cluster.update`, `cluster.delete`). Users see
their own entries; `Sys.Audit` on `/` of a cluster shows everyone's entries for it.

## Live events

`GET /api/events` — Server-Sent Events:

- `event: fleet` — full `/api/fleet` payload after each poll of any cluster (at most once per second)
- `event: tasks` — `[Task]` newest 50 across clusters, on change (at most once per second)
- `event: audit` — an audit entry whenever it is created or updated (plan progress)
- `event: session` — `{"state":"ended"}` just before the stream closes because the session ended

Every payload is filtered for the subscriber exactly like the matching GET endpoint.
At most 4 streams per session.
