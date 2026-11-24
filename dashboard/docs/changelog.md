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
- **Consoles and host commands.** Open VM displays and terminals in galley; administrators can run reviewed commands on nodes. [Consoles](/help/consoles)
- **Help, What's new and feedback.** The full user guide is built in (**Help**), this dialog shows what changed after each update, and **Send feedback** files an issue on GitHub.
- **Safer logins.** Stored PVE logins are encrypted with a key only your browser holds, and lapse when you stop using galley. [Security](/help/security)

## 0.1.0 — 2026-11-10

- First release: fleet overview, guest list with bulk actions, ⌘K command palette, change review with CLI equivalents, task and audit logs, multiple clusters with pinned certificates.
