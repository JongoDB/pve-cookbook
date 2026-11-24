---
id: admin/users-roles-tokens
title: Users, groups, roles, ACLs and API tokens
tested: "PVE 9.2 · 2026-11 (syntax verified; role sets reviewed by hand)"
risk: medium
runs_on: node
---

# Users, groups, roles, ACLs and API tokens

Set up least-privilege access for humans and automation: realms, groups, custom roles, ACLs on
precise paths, resource pools, API tokens with privilege separation, and enforced two-factor
authentication. Use this after the cluster exists and before handing out access.

## Preconditions

- Cluster quorate: `pvecm status | grep -q 'Quorate: *Yes'`
- You are `root@pam` or hold `Permissions.Modify` on `/`: `pveum user permissions root@pam --path / | grep -q Permissions.Modify`

## Inputs

| Variable | Meaning | Example |
|---|---|---|
| `REALM` | Realm for human users | `pve` (built-in) or an OIDC realm |
| `GROUP_ADMINS` / `GROUP_OPS` / `GROUP_AUDIT` | Group names | `admins`, `operators`, `auditors` |
| `POOL` | Resource pool for a team/app | `team-web` |
| `AUTOMATION_USER` | Service account for tools such as galley | `automation@pve` |

## Steps

### 1. Understand the model

- **Users** live in a **realm** (`pam` = Linux accounts, `pve` = PVE-internal, `ldap`/`ad`/`openid`).
- **Roles** are sets of privileges; **ACLs** grant a role to a user/group/token on a **path**.
- ACLs propagate down the tree unless `--propagate 0`. Most specific path wins; `NoAccess` overrides.
- Useful paths: `/` (everything), `/vms/<vmid>`, `/pool/<pool>`, `/storage/<id>`, `/nodes/<node>`,
  `/sdn/zones/<zone>/<vnet>`, `/mapping/...`, `/access`.
- Built-in roles: `Administrator`, `PVEAdmin`, `PVEAuditor`, `PVEVMAdmin`, `PVEVMUser`,
  `PVEDatastoreAdmin`, `PVEDatastoreUser`, `PVEPoolAdmin`, `PVEPoolUser`, `PVESDNAdmin`, `PVESDNUser`,
  `PVEUserAdmin`, `PVESysAdmin`, `PVETemplateUser`, `PVEMappingAdmin`, `PVEMappingUser`, `NoAccess`.

### 2. Groups (grant to groups, never to individual users)

```bash
pveum group add admins    --comment "Full cluster administrators"
pveum group add operators --comment "Day-to-day guest operations"
pveum group add auditors  --comment "Read-only visibility"
```

### 3. Custom least-privilege roles

```bash
# Operator: run, console, snapshot, backup and migrate guests; cannot change hardware or delete.
pveum role add Operator --privs "VM.Audit,VM.Console,VM.PowerMgmt,VM.Snapshot,VM.Snapshot.Rollback,VM.Backup,VM.Migrate,Datastore.Audit,Datastore.AllocateSpace,Sys.Audit,SDN.Audit,SDN.Use,Pool.Audit"

# Auditor+: PVEAuditor plus reading syslog/tasks of nodes.
pveum role add AuditorPlus --privs "VM.Audit,Datastore.Audit,Sys.Audit,Sys.Syslog,SDN.Audit,Pool.Audit,Mapping.Audit"
```

Change a role later with `pveum role modify <role> --privs "..."` (the list replaces the old one;
add `--append 1` to add instead).

### 4. ACLs

```bash
pveum acl modify / --groups admins    --roles Administrator
pveum acl modify / --groups auditors  --roles AuditorPlus
pveum acl modify / --groups operators --roles Operator
# Operators may only attach guests to the 'servers' and 'lab' vnets:
pveum acl modify /sdn/zones/evpn/servers --groups operators --roles PVESDNUser
pveum acl modify /sdn/zones/evpn/lab     --groups operators --roles PVESDNUser
```

### 5. Resource pools (delegate a team's guests and storage)

```bash
pvesh create /pools --poolid team-web --comment "Web team guests"
pvesh set /pools/team-web --vms 101,102 --storage vm-pool
pveum group add team-web
pveum acl modify /pool/team-web --groups team-web --roles PVEVMAdmin
```

### 6. Users

```bash
pveum user add alice@pve --email alice@example.internal --groups admins,operators --comment "Alice"
pveum passwd alice@pve            # interactive; or let them log in via OIDC instead
pveum user modify alice@pve --expire 0 --enable 1
```

### 7. Two-factor authentication

Per user, users enrol TOTP/WebAuthn themselves in the GUI (*Datacenter → Permissions → Two Factor*).
Enforce at the realm level so login is impossible without a second factor:

```bash
pveum realm modify pve --tfa type=oath        # TOTP required for every pve-realm user
# WebAuthn needs the cluster's public FQDN/origin configured first:
pvesh set /cluster/options --webauthn 'rp=pve.example.internal,origin=https://pve.example.internal:8006,id=pve.example.internal'
```

Keep `root@pam` with a strong password plus TOTP and use it only for break-glass.

### 8. API tokens with privilege separation (automation, galley, exporters)

```bash
pveum user add automation@pve --comment "Service account for automation (no password login)"
pveum user token add automation@pve galley --privsep 1 --comment "galley dashboard" --expire 0
# ^ prints the secret ONCE. Store it in a secret manager.
# With privsep=1 the token has NO rights until granted explicitly:
pveum acl modify / --tokens 'automation@pve!galley' --roles PVEAuditor
pveum acl modify / --tokens 'automation@pve!galley' --roles Operator
```

Use the token in API calls as header `Authorization: PVEAPIToken=automation@pve!galley=<secret>`.
Grant only what the tool needs; a monitoring exporter needs `PVEAuditor` and nothing else.

### 9. OIDC realm (single sign-on)

```bash
pveum realm add sso --type openid \
  --issuer-url https://idp.example.internal/realms/infra \
  --client-id proxmox --client-key '<secret>' \
  --username-claim preferred_username --autocreate 1 \
  --groups-claim groups --groups-autocreate 1 --comment "Company SSO"
```

Map IdP groups to PVE groups (with `--groups-autocreate`, groups appear as `<group>-sso`) and grant ACLs to those.
Keep the `pve`/`pam` realms for break-glass.

## Verify

```bash
pveum user list --output-format json-pretty | grep -E '"userid"|"enable"'
pveum acl list
pveum user permissions alice@pve --path /vms/101        # effective privileges on one guest
pveum user permissions 'automation@pve!galley'          # what the token can do
pveum user token list automation@pve
```

Expected: every human is in at least one group; no user ACLs except service accounts; the token has
`privsep 1`; `pveum user permissions` for an operator shows no `VM.Allocate`, `VM.Config.*` or
`Sys.Modify`.

## Rollback

```bash
pveum acl delete / --groups operators --roles Operator
pveum user token remove automation@pve galley
pveum user delete alice@pve
pveum role delete Operator
pveum realm modify pve --delete tfa
```

## Gotchas

- `pveum role modify --privs` **replaces** the privilege list unless `--append 1` is given.
- Tokens with `--privsep 0` inherit **all** of the user's rights; prefer `--privsep 1` and explicit ACLs.
- A token's effective permissions are the intersection of the user's and the token's ACLs.
- Enabling realm-level TFA locks out users who have not enrolled yet; enrol first, then enforce.
- `root@pam` cannot be restricted by ACLs. Do not use it for automation.
- Group names from OIDC are suffixed with the realm (`admins-sso`); ACLs must reference that name.
