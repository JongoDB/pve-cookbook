---
title: Settings
summary: What the Settings page holds (the assistant, agent approval and feedback), who can change it, and what data leaves galley when the assistant is on.
order: 150
route: /settings
---

The **Settings** page holds galley-wide settings. Only galley admins see it in the navigation; anyone else who opens it sees **Settings need a galley admin**. See [Clusters and access](clusters-and-access.md#galley-admins) for who is a galley admin.

Every change to these settings is recorded in the audit log.

Settings that belong to one cluster (credential mode, host transport, shared logins, endpoints) are on the [Clusters](clusters-and-access.md) page. Startup options (session lifetime, public URL, extra admins) are command-line options; see [Install and upgrade](install-and-upgrade.md#set-startup-options).

## Assistant

The **Assistant** section connects galley's assistant to a model provider. The heading shows whether it is **On** (with the provider and model) or **Off**.

- **Turn on the assistant for every galley user**: the assistant is on or off for everyone.
- **Provider**: **Anthropic** or **OpenAI-compatible**.
- **Base URL** (OpenAI-compatible only): the provider's `/v1` endpoint. Select one of the examples to fill it in.
- **Model**: the model name. For Anthropic the default is `claude-opus-5-5`.
- **Effort** (Anthropic only): `low`, `medium`, `high`, `xhigh` or `max`. Higher effort answers harder questions better and takes longer.
- **Refusal fallback** (Anthropic only): when the model declines a request, Anthropic retries it on a fallback model instead of returning the refusal.
- **API key**: write-only. **A key is saved** shows that one is stored; galley never shows it again. **Remove key** deletes it when you save. Paste a new key to replace it. For a local vLLM or Ollama server, leave it empty.

Select **Save assistant settings** to save, or **Undo changes** to go back to the saved settings. Changes apply to new conversations.

Step-by-step setup: [Assistant](assistant.md#set-up-the-assistant-galley-admins).

## Agent approval

The **Agent approval** section sets what agent tokens with the **apply** scope need a person for. See [Agents and MCP](agents-and-mcp.md#what-needs-a-person).

- **Every change**: a person applies everything, so apply tokens work like draft tokens.
- **Everything but routine guest work** (default): agents apply only routine guest work.
- **Host commands and access changes**: a person applies these; agents apply everything else, including destroying guests.
- **Nothing, always allow**: agents apply every change themselves.

The list goes from strictest to loosest. Choosing one of the last two to loosen the setting asks you to tick that you understand.

Select **Save agent approval**. The setting applies at once to every agent token on this galley, and the change is recorded in the audit log (`settings.agents`). Agent tokens can never change it. The assistant can draft the change for you to apply.

## Feedback

The **Feedback** section controls **Send feedback** (see [Send feedback](feedback.md)). The heading shows **On** with the repository, or **Off**.

- **Let users send feedback**: when off, **Send feedback** is hidden everywhere in galley.
- **GitHub repository**: where new issues are opened, as `owner/name`. The default is `JongoDB/pve-cookbook`, galley's own repository. Point it at your own repository, for example an internal fork, to collect feedback there.

Select **Save feedback settings** to save, or **Undo changes** to go back to the saved settings. The change is recorded in the audit log (`settings.feedback`).

galley holds no GitHub credential and sends nothing to GitHub itself: users submit each issue from their own GitHub account.

## What leaves galley

When the assistant is on, the **What leaves galley** box names the destination. Sent there:

- each question a user asks;
- the cluster data the assistant reads to answer it: guest and node names, configurations, health findings, task logs and metrics, read with the asking user's PVE permissions;
- pages of this user guide the assistant reads.

Never sent: PVE tickets and tokens, galley's service tokens, or any other galley credential. The API key goes only to the provider it was entered for, to authenticate. galley does not store conversations.

If you change the provider or the endpoint's host, galley does not send the saved API key to the new destination; paste the key for the new one. If the base URL uses plain `http://`, galley warns that anyone on the network path can read the traffic.

To keep all data on your own network, use an OpenAI-compatible model server you run yourself, such as vLLM or Ollama.
