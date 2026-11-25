<!--
Release notes shown in galley's "What's new" dialog (newest first).
Every change users can notice adds a bullet under the next version in the
same change. Format: "## <version> — <YYYY-MM-DD>", then short bullets in
plain words, written for the person using galley. Link help pages as
/help/<slug>.
-->

## 0.2.0 — 2026-11-24

- **A new look and detail pages.** Every guest, node and storage has its own page with live charts, configuration, snapshots, backups and task history.
- **Build your own overview.** Choose **Edit layout** to add, remove and resize widgets, including charts of any metric. [Overview](/help/overview)
- **Change anything PVE allows.** Edit hardware and options with checked forms, create VMs and containers with wizards (GPU and LLM server presets included), or call any PVE API path from the **API** page. Every change is reviewed in **Changes** first. [Changes](/help/changes)
- **The assistant.** Ask about your clusters, or how to do something in galley. It reads with your permissions and drafts changes for you to review; it never applies them. Suggested follow-ups appear under its latest answer, and a new conversation offers questions for the page you are on. [Assistant](/help/assistant)
- **Agents and MCP.** AI agents and scripts can use galley without the browser, as you, with a token you control. What they apply shows **via agent <name>** in the audit log. [Agents and MCP](/help/agents-and-mcp)
- **Hardware and GPUs.** See PCI devices and IOMMU groups, create PCI mappings and attach GPUs. [Hardware and GPUs](/help/hardware-and-gpus)
- **GPU VMs stay with their card.** When a new VM gets a mapped GPU, galley adds it to HA with a strict node-affinity rule for the nodes that have the card (on by default). **Pin to GPU nodes** on the Hardware page does the same for existing VMs, and **Check driver** shows which kernel driver a GPU uses. [Hardware and GPUs](/help/hardware-and-gpus)
- **Share a GPU with containers.** The container wizard has a **GPU** step: share an NVIDIA GPU that runs the host driver, or an Intel/AMD GPU through /dev/dri. [Share a GPU with containers](/help/hardware-and-gpus)
- **Consoles and host commands.** Open VM displays and terminals in galley; administrators can run reviewed commands on nodes. [Consoles](/help/consoles)
- **Help, What's new and feedback.** The full user guide is built in (**Help**), this dialog shows what changed after each update, and **Send feedback** files an issue on GitHub.
- **Fixes found by the new end-to-end tests.** The Clusters page no longer goes blank while you are not yet logged in to a newly added cluster; a removed cluster's history stays in the audit log for galley admins; searches with several words (`qemu config`) match each word; the **API** page opened from a link fills in `{node}`; **Create** says so when your account sees no node; new agent tokens show **Never** as last used; the Changes count updates as soon as the assistant drafts a change; and a page that fails to show says so instead of blanking galley. [Troubleshooting](/help/troubleshooting)
- **Safer logins.** Stored PVE logins are encrypted with a key only your browser holds, and lapse when you stop using galley. [Security](/help/security)
- **Fixes from validating on real PVE.** Switching host commands from SSH back to the PVE node terminal, or removing a cluster, now also deletes its pinned host keys. A login revoked in PVE says it lapsed. Agent tokens explain why PVE refuses them on clusters that keep personal API tokens. [Agents and MCP](/help/agents-and-mcp)
- **A person stays in the loop for agents.** Agents with the apply scope no longer apply host commands or access changes themselves: they wait in **Changes** for you, for 24 hours. Admins choose what needs a person, or always allow, in **Settings**. [What needs a person](/help/agents-and-mcp)

## 0.1.0 — 2026-11-10

- First release: fleet overview, guest list with bulk actions, ⌘K command palette, change review with CLI equivalents, task and audit logs, multiple clusters with pinned certificates.
