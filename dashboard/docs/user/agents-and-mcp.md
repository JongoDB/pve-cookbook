---
title: Agents and MCP
summary: Let AI agents and scripts use galley as you, with agent tokens, galley's MCP endpoint or its REST API, and choose how much they may do.
order: 115
route: /agents
---

galley is built to be used by AI agents as well as people. An agent, such as Claude Code or another MCP client, or a plain script, connects to galley with an **agent token** that you create. It then works as you: it sees what your PVE account can see, and its changes run with your PVE permissions and appear in the audit log.

## What an agent token can do

When you create a token you choose its scope:

- **read**: query only. List guests, nodes and storage, read findings, tasks and metrics, read any PVE API path you can read, look up the API schema, and read this user guide.
- **draft**: everything in **read**, plus drafting changes. A draft waits for a person to review and apply it in **Changes**, like the assistant's drafts. Drafts are titled **Agent draft (<token name>): …** and always need typed confirmation.
- **apply**: everything in **draft**, plus applying changes itself. The agent passes the change's confirmation text, then follows the change until it finishes. Use this scope only for agents you trust to act without review: they act as you.

Whatever the scope, an agent token can never:

- add, change or remove clusters, or change galley's settings — not even by drafting or applying a galley setting change;
- create or revoke agent tokens;
- log in, log out, or open consoles;
- use the in-app assistant.

Each agent can have at most 10 drafts waiting for you. Changes an agent applied show **via agent <name>** below the user in the [audit log](audit-log.md) and on [Activity](activity.md).

Host commands drafted or applied by an agent follow the same rules as yours: they need host administrator rights on the cluster. See [Host commands](hosts.md).

## How a token acts as you

When you create a token, galley creates a PVE API token for you on every cluster you are logged in to at that moment, named `galley-agent-…`, with your own permissions and the same expiry as the agent token. The agent uses those PVE tokens, so it keeps working when you are logged out. You can see these tokens in PVE under your user's API tokens.

Because the agent uses PVE API tokens, not a login ticket, operations PVE reserves for a `root@pam` ticket fail for agents, for example raw PCI devices without a mapping, and host commands through PVE's node terminal. See [Clusters and access](clusters-and-access.md#how-galley-keeps-your-login).

Clusters you were not logged in to when you created the token are not available to it. Create a new token after logging in to them.

## Create an agent token

1. Log in to every cluster the agent should reach.
2. Open the **Agents** page.
3. Enter a name for the token (letters, digits, `.`, `_` and `-`), choose the scope (**read**, **draft** or **apply**) and how many days it is valid (1 to 90).
4. Create the token. galley shows it once: a string starting with `glly_`. Copy it now and store it like a password; galley cannot show it again.

If a cluster refuses to create a PVE token for you, galley lists it as a warning and creates the agent token for the other clusters. If no cluster accepts, no agent token is created.

Your tokens are listed under **Your agent tokens** with their scope, when they were created and expire, and when an agent last used them (**Never** until the first use).

Creating and revoking tokens is recorded in the audit log (`agent.create`, `agent.revoke`).

## Revoke an agent token

On the **Agents** page, revoke the token. galley deletes it and the PVE API tokens it created. If galley cannot delete a PVE token right away, it deletes it the next time you log in to that cluster; it also expires on its own. The agent is cut off at once.

Tokens also stop working when they expire.

## Connect an MCP client

galley's MCP endpoint is `https://<galley>/mcp` (streamable HTTP, stateless, JSON responses). Authenticate with the header `Authorization: Bearer glly_…`.

### Claude Code

```bash
claude mcp add --transport http galley https://galley.example.com:8443/mcp \
  --header "Authorization: Bearer glly_…"
```

### Clients that only speak stdio

The galley binary doubles as a stdio bridge. Run it on the machine where the agent runs:

```bash
GALLEY_TOKEN=glly_… galley mcp --url https://galley.example.com:8443 --fingerprint AB:CD:…
```

- `--url` (or `GALLEY_URL`): galley's address.
- `--fingerprint` (or `GALLEY_FINGERPRINT`): the SHA-256 fingerprint of galley's TLS certificate. Use it when galley has its self-signed certificate; the installer printed it as **TLS (sha256)**. Without it, the certificate must be trusted by the system.
- The token comes from the `GALLEY_TOKEN` environment variable, never from the command line.

Configure your MCP client to start that command.

### Tools

The tools depend on the token's scope:

- read: `list_resources`, `get_findings`, `list_tasks`, `pve_get`, `get_metrics`, `api_schema`, `search_docs`, `read_doc`, `list_changes`, `get_change`;
- draft adds: `propose_action` (any galley action: guest power, migrate, snapshot, destroy, backup protection, host commands, galley's own settings), `propose_change` (any PVE create, update or delete) and `propose_host_command`;
- apply adds: `apply_change`. Pass the change's id and, if it has one, its confirmation text; then poll `get_change` until the change is no longer running.

This user guide is available to MCP clients as resources named `galley://docs/<page>`, for example `galley://docs/changes`.

## Use the REST API with a token

Scripts can call galley's REST API with the same header, `Authorization: Bearer glly_…`. No CSRF header is needed. What a token may call:

- every read (`GET`), and metric queries (`POST /api/metrics`);
- with **draft**: create and discard changes (`POST /api/plans`, `DELETE /api/plans/{id}`);
- with **apply**: also apply them (`POST /api/plans/{id}/run`).

Anything else answers `403` with code `agent_scope`. The API is described in galley's `docs/api.md`.

## Keep agents safe

- Give each agent its own token, with the smallest scope that does the job, and the shortest validity.
- Prefer **draft**: you see every change before it runs.
- Remember that an agent reads cluster data, including VM notes and names that anyone with access could have written. A malicious text there can try to steer the agent. With **draft** you still review the result.
- Revoke tokens you no longer use.
