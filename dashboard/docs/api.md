# galley HTTP API (v0, MVP)

All endpoints are JSON under `/api`. The SPA uses exactly this API; so can scripts and the
MCP server. Times are Unix seconds. Sizes are bytes. CPU is a 0–1 fraction (as PVE reports).

## Auth model

- **Service token (per cluster, read-only):** registered with the cluster; used by the
  background poller for fleet/guest/task data. Create it with the `PVEAuditor` role
  (`recipes/admin/users-roles-tokens.md`). Never used for mutations.
- **User session:** `POST /api/login` with PVE credentials. galley obtains a PVE ticket per
  cluster and performs every mutation **as that user**, so PVE ACLs apply and PVE's task
  log shows the real user.
- Session cookie `galley_session` (HttpOnly, Secure, SameSite=Strict). Mutating requests
  must send header `X-Galley-CSRF: <csrf>` from `GET /api/me`.
- Errors: HTTP status + `{"error": "message", "code": "snake_case"}`.

## Setup & clusters

| Method & path | Body | Response |
|---|---|---|
| `GET /api/health` | – | `{"ok":true,"version":"0.1.0"}` |
| `GET /api/setup` | – | `{"needsSetup":bool}` — true when no cluster is registered |
| `POST /api/clusters/probe` | `{"endpoints":["192.0.2.11","192.0.2.12:8006"]}` | `{"endpoints":[Probe]}` |
| `POST /api/clusters` | `{"name","endpoints":[{"host","fingerprint"}],"tokenId":"galley@pve!poller","tokenSecret"}` | `Cluster` (allowed unauthenticated only while `needsSetup`) |
| `GET /api/clusters` | – | `[Cluster]` |
| `DELETE /api/clusters/{id}` | – | `204` |

`Probe` = `{"host","reachable":bool,"fingerprint":"AB:CD:…"(sha256 of leaf cert),"trustedBySystem":bool,"error"?}`

`Cluster` = `{"id","name","endpoints":[{"host","fingerprint"}],"status":{"reachable","quorate","nodes","nodesOnline","activeEndpoint","lastPoll","error"?}}`

TLS: an endpoint is accepted if its certificate verifies against system roots **or** its
leaf SHA-256 fingerprint equals the pinned one. Requests fail over across endpoints in order.

## Session

| Method & path | Body | Response |
|---|---|---|
| `POST /api/login` | `{"clusterId","username":"root","realm":"pam","password","otp"?}` | `Me` + cookie. Tries the same credentials on every other cluster. |
| `POST /api/clusters/{id}/login` | `{"username","realm","password","otp"?}` | `Me` (adds a ticket for one more cluster) |
| `POST /api/logout` | – | `204` |
| `GET /api/me` | – | `Me` or `401` |

`Me` = `{"user":"root@pam","csrf","clusters":[{"id","name","authed":bool}]}`

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

`ClusterSummary` = `{"id","name","quorate","nodes":[Node],"ceph":Ceph|null,"storage":[Storage],"ha":{"quorum":bool,"resources":int,"errors":int},"backups":{"covered":int,"total":int,"unprotected":[vmid]}}`

`Node` = `{"name","online","cpu","maxcpu","mem","maxmem","uptime","guests","kernel"?,"pveversion"?}`

`Ceph` = `{"health":"HEALTH_OK","osdsUp","osdsIn","osdsTotal","usedBytes","totalBytes"}`

`Storage` = `{"id","node","type","shared":bool,"used","total","active":bool}`

`Finding` = `{"id","level":"INFO|WARN|CRIT","check","clusterId","where","message","fix"?:{"action","params":{},"label"}}`

`GET /api/guests?cluster=&q=&status=&type=` → `[Guest]`

`Guest` = `{"clusterId","vmid","name","type":"qemu|lxc","node","status","cpu","maxcpu","mem","maxmem","disk","maxdisk","uptime","tags":[],"template":bool,"hastate"?}`

`GET /api/tasks?cluster=&limit=50` → `[Task]` newest first

`Task` = `{"clusterId","upid","node","type","id","user","starttime","endtime"?,"status"?}`

`GET /api/nodes/{clusterId}/{node}/targets` → `["pve2","pve3"]` (migration targets, online nodes except source)

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

`POST /api/plans/{id}/run` `{"confirm"?: "destroy 120"}` → `{"auditId","results":[{"step":0,"ok":bool,"upid"?,"error"?}]}`

Plans expire after 10 minutes and run at most once.

## Audit

`GET /api/audit?limit=100` → `[{"id","at","user","clusterId","action","title","cli":["…"],"ok":bool,"results":[…]}]`

## Live events

`GET /api/events` — Server-Sent Events:

- `event: fleet` — full `/api/fleet` payload whenever the poller cache changes
- `event: tasks` — `[Task]` newest 50 across clusters, on change
- `event: audit` — the new audit entry after a plan runs
