---
id: admin/notifications
title: Notifications — targets and matchers
tested: "PVE 9.2 · 2026-11 (syntax verified; delivery untested)"
risk: low
runs_on: node
---

# Notifications

PVE 8.1+ routes events (backups, fencing, replication, package updates, system mail) through
**targets** (where to send) and **matchers** (which events go where). Out of the box everything goes
to `mail-to-root`, which only works if root has an email address and the node can deliver mail.

Event `type` values: `vzdump`, `fencing`, `replication`, `package-updates`, `system-mail`.
Matcher fields: `type`, `hostname`, `job-id`. Severities: `info`, `notice`, `warning`, `error`.

## Preconditions

- Outbound access from the nodes to your SMTP server, Gotify, or webhook endpoint.

## Inputs

| Variable | Meaning | Example |
|---|---|---|
| `SMTP` | Relay, port, credentials | `smtp.example.internal:587` |
| `TO` | Recipients | `ops@example.internal` |
| `GOTIFY` | Server + app token | `https://gotify.example.internal` |
| `WEBHOOK` | Chat/incident webhook URL | Slack/Teams/ntfy/Matrix bridge |

## Steps

### 1. Give root an address (for the built-in sendmail target)

```bash
pveum user modify root@pam --email ops@example.internal
```

### 2. SMTP target (works without a local MTA)

```bash
pvesh create /cluster/notifications/endpoints/smtp --name ops-mail \
  --server smtp.example.internal --port 587 --mode starttls \
  --username pve-alerts --password '<secret>' \
  --from-address pve@example.internal --mailto ops@example.internal --author "PVE pve-lab"
```

### 3. Gotify and webhook targets

```bash
pvesh create /cluster/notifications/endpoints/gotify --name phone \
  --server https://gotify.example.internal --token '<app-token>'

# Generic webhook (example: ntfy). Body and headers support templating ({{ title }}, {{ message }}, {{ severity }}).
pvesh create /cluster/notifications/endpoints/webhook --name ntfy --method post \
  --url 'https://ntfy.example.internal/pve-lab' \
  --body "$(echo -n '{{ message }}' | base64)"
```

### 4. Matchers (routing)

```bash
# Errors of any kind → phone + mail
pvesh create /cluster/notifications/matchers --name errors-to-oncall \
  --match-severity error --target phone --target ops-mail --comment "All errors"

# Fencing is always urgent
pvesh create /cluster/notifications/matchers --name fencing \
  --match-field exact:type=fencing --target phone --target ops-mail

# Backup results (success and failure) → mail only
pvesh create /cluster/notifications/matchers --name backups \
  --match-field exact:type=vzdump --target ops-mail

# Package updates, weekdays only → mail
pvesh create /cluster/notifications/matchers --name updates \
  --match-field exact:type=package-updates --match-calendar 'mon..fri 08:00-18:00' --target ops-mail
```

Keep or disable the builtin `default-matcher` (`pvesh set /cluster/notifications/matchers/default-matcher --disable 1`)
so you don't get duplicates.

### 5. Make backup jobs use the notification system

```bash
pvesh set /cluster/backup/nightly-all --notification-mode notification-system
```

## Verify

```bash
pvesh create /cluster/notifications/targets/ops-mail/test
pvesh create /cluster/notifications/targets/phone/test
pvesh get /cluster/notifications/matchers --output-format json-pretty
```

Each test call delivers a test message to that target.

## Rollback

```bash
pvesh delete /cluster/notifications/matchers/errors-to-oncall
pvesh delete /cluster/notifications/endpoints/smtp/ops-mail
pvesh set /cluster/notifications/matchers/default-matcher --disable 0
```

## Gotchas

- Secrets for endpoints are stored in `/etc/pve/priv/notifications.cfg` (root only), not in the readable config.
- A matcher with no `match-*` options matches **everything**.
- `--mode all` (default) needs every condition to match; use `--mode any` for OR.
- Webhook bodies must be passed base64-encoded via the API/CLI.
- `pve-health.sh` findings are not PVE notification events. Wire the health timer to the journal or a webhook yourself.
