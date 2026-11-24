---
title: Assistant
summary: Ask galley's assistant about your clusters and let it draft changes, what it can and cannot do, its limits, and how an admin sets it up.
order: 110
---

galley's assistant is a chat in the **Assistant** tab of the drawer. It answers questions about your clusters by reading their real state, and it can draft changes for you to review. It works with a model provider that a galley admin connects: Anthropic, or any OpenAI-compatible API, including a model server you run yourself.

## What the assistant can do

- **Read, as you.** It looks things up with your own PVE permissions: guests, nodes and storage with live usage, health findings, recent tasks, metrics history, any PVE API path you can read (configurations, HA state, PCI devices, SDN, ACLs), and the API schema of your cluster's PVE version. If PVE refuses a read, it tells you which permission is missing.
- **Draft anything galley can do.** It can draft every action the galley interface offers: start, shut down, reboot, stop, migrate, snapshot or destroy guests; add guests to a backup job; change galley's own settings for a cluster or your preferences (see [How changes work](changes.md#changes-to-galleys-own-settings)); and any create, update or delete in the PVE API, such as attaching a GPU or changing a guest's settings. The draft appears in the conversation and in **Changes**. Nothing runs until you apply it.
- **Draft host commands**, if you are a host administrator on that cluster (`Sys.Modify`, `Sys.Console` and `Permissions.Modify` on `/`). For everyone else it gives you the command to pass on to an administrator. See [Host commands](hosts.md).
- **Explain galley.** When you ask how to do something in galley, or where something is, it searches and reads this user guide and answers with short steps and the labels you see on screen. It links to the guide's pages (they open under **Help**) and to galley pages, such as a guest or the Create page.
- **Follow up on changes.** It can list your pending changes and check the outcome of a change in the audit log.

It cannot apply changes, run commands, or see anything your PVE account cannot see.

## Ask a question

1. Open the drawer's **Assistant** tab, or press ⌘K (Ctrl K), type your question and choose **Ask the assistant: …**.
2. Type in **Message the assistant**. Enter sends; Shift+Enter starts a new line. In a new conversation, the examples under **Try** send a ready-made question.
3. Watch the answer. While it works, the assistant shows a line for each lookup, for example **Read /nodes/pve1/qemu/120/config**, **Checked metrics for node pve1, last day**, **Checked findings**, **Read the task log**, **Searched the docs for “…”** or **Read help: <page>** (select the page name to open it). A failed lookup is marked with its error.
4. Select **Stop** to end an answer early.

Examples:

- "What needs my attention right now?"
- "What failed in the last hour, and why?"
- "Which VMs on pve2 use the most memory this week?"
- "Attach the second A2 GPU to llm-vllm."
- "How do changes work?"
- "Where do I map a GPU?"

The conversation stays while you switch drawer tabs, fold the drawer or move between pages. It is lost when you reload the page. **New conversation** starts over.

## Review a change the assistant drafted

When the assistant drafts a change, a card labelled **Assistant draft** appears in its answer with the title, cluster, number of steps and the exact commands.

1. Select **Review in Changes**. The draft opens in the **Changes** tab, titled **Assistant draft: …**.
2. Read every step and command. The assistant drafted it from what it read in the cluster, and text in the cluster (a VM's notes, a name) could try to mislead it.
3. Type the confirmation text, for example `apply 3 steps`. Assistant drafts always need a typed confirmation, even for changes that would otherwise need none.
4. Select **Apply change**.

The change runs as you, like any other. Each call was checked against your cluster's API schema when the draft was made, and PVE checks your permissions when it runs. See [How changes work](changes.md).

The Changes tab holds one change at a time. If you open a draft while another change is waiting, the draft replaces it.

## What leaves galley

Your questions, and the cluster data the assistant reads to answer them (guest and node names, configurations, health findings, task logs and metrics), are sent to the model provider. The assistant panel names the destination at the top of each conversation. PVE logins and galley's own credentials are never sent.

galley does not store conversations on disk. They are kept in galley's memory and are dropped when idle for 2 hours or when galley restarts.

## Limits

- A message can be up to 20,000 characters.
- A conversation holds about 400 KB of history. When it is full, the assistant says **This conversation is full.** Select **New conversation**.
- One answer at a time per conversation. Sending while it answers gives **The assistant is still answering in this conversation.**
- About 30 messages per minute per session. Beyond that: **Too many messages.** Wait, then send again.
- Each session keeps up to 20 conversations; the oldest is dropped.
- A single answer can take up to 10 minutes.
- Large API results are shortened before the model sees them.

For error messages, see [Troubleshooting](troubleshooting.md#assistant-errors).

## Set up the assistant (galley admins)

The assistant is off until a galley admin connects a provider on the **Settings** page. Until then the Assistant tab says **The assistant is not set up yet.** Galley admins see a **Set up the assistant** link there.

1. Open **Settings**.
2. Tick **Turn on the assistant for every galley user**.
3. Choose the **Provider**:
   - **Anthropic**: enter the **Model** (default `claude-opus-5-5`), choose the **Effort** (`low` to `max`; `medium` suits most clusters) and paste an Anthropic **API key**. Leave **Refusal fallback** on: when the model declines a request, Anthropic retries it on a fallback model instead of returning the refusal.
   - **OpenAI-compatible**: enter the **Base URL** of the `/v1` endpoint and the **Model** name. Examples: `https://api.openai.com/v1` (OpenAI), `https://api.x.ai/v1` (xAI), `https://openrouter.ai/api/v1` (OpenRouter), `http://<gpu-host>:8000/v1` (vLLM on your own GPU host), `http://<host>:11434/v1` (Ollama). Leave the API key empty if your endpoint needs none.
4. Read **What leaves galley**: it names where data will go.
5. Select **Save assistant settings**.

Details:

- The API key is write-only. galley stores it encrypted and never shows it again. **Remove key** deletes it.
- If you change the provider or the endpoint's host, galley will not send the saved key to the new destination. Paste the key for the new one.
- An endpoint with plain `http://` sends traffic unencrypted; galley warns you. Use it only on a network you trust, such as a local vLLM or Ollama server.
- A local model server keeps all cluster data on your own network.
- **Undo changes** restores the saved settings.
- Every change to these settings is recorded in the audit log (`settings.assistant`).

See [Settings](settings.md).
