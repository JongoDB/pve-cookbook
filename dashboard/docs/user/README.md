# galley user guide: contributor notes

This directory is galley's user guide. It is not documentation about the code: it tells people how to use galley. This README is for contributors and is not served.

The pages are embedded in the galley binary (`docs/embed.go`) and used in three places:

- the in-app **Help** page (`/help`, `/help/<slug>`), and the **Help** link next to page titles, which opens the page whose `route` matches;
- galley's built-in assistant, which searches and reads them (`search_docs`, `read_doc`) to tell users how to do things, and links to them as `/help/<slug>`;
- MCP clients, as resources `galley://docs/<slug>`, and the REST API (`GET /api/docs`, `GET /api/docs/<slug>`).

Because the assistant repeats what these pages say, **a wrong page becomes a wrong answer**. Accuracy matters more than completeness.

## The rule

Every change to galley's UI or behaviour updates these pages in the same change:

- a new, renamed or removed button, label, page, route, tab or field;
- a changed permission, limit, default, confirmation text or error message;
- a new action or workflow.

New UI actions must also be added to the assistant's tools (`internal/server/tools.go`, `propose_action`), so the assistant and agents can do everything the UI can.

## Format

The parser (`docs/embed.go`, and `web/src/lib/docs.ts`) depends on this format.

- One Markdown file per topic. The file name is the slug: lowercase words joined by hyphens, for example `hardware-and-gpus.md`. The slug is the page's URL (`/help/hardware-and-gpus`); do not rename files without a reason, since links and the assistant use slugs.
- Every file starts with front matter, exactly like this:

  ```
  ---
  title: Hardware and GPUs
  summary: One sentence: what this page helps with.
  order: 80
  route: /hardware
  ---
  ```

  - `title`: sentence case. Shown as the page heading, so do not repeat it as a `#` heading in the body.
  - `summary`: one sentence. Shown in the Help index and given to the assistant as the page's description.
  - `order`: integer; the Help index is sorted by it. Leave gaps (10, 20, …) so pages can be inserted.
  - `route`: optional. The galley route the page documents. `:param` segments match anything (`/console/:cluster/:type/:node`); a route also covers longer paths below it (`/guests` covers `/guests/<cluster>/<vmid>`). One page per route.
- The body uses `##` for sections and `###` for subsections. Search splits pages at these headings, and each section should make sense on its own, because the assistant often reads a single section.
- Supported Markdown: paragraphs, headings, bullet and numbered lists, fenced code blocks, inline code, bold, links, simple pipe tables, blockquotes. Nothing else (no HTML, no images).
- Links between pages are relative: `[Changes](changes.md)` or `[Changes](changes.md#typed-confirmation)`. Anchors are GitHub-style heading slugs. Links to galley pages use routes, such as `/hardware`.

## Style

- Task-oriented sections, titled with what the reader wants to do: "## Take a snapshot".
- Numbered steps for procedures; one action per step.
- UI labels in **bold**, exactly as on screen (check the `.tsx` source, not memory). Values the user types, commands, paths and API names in `code`.
- Second person, plain words, short sentences. Sentence case headings. No marketing, no emojis.
- Name the PVE privilege when something depends on it (`VM.Console`, `Sys.Audit` on `/`), and say when something needs a galley admin.
- CLI or `pvesh` only where it helps the reader.
- Keep each page focused: roughly 100 to 400 lines.
- Describe only what galley does today. Do not document planned features.

## Pages

| File | Route | Topic |
|---|---|---|
| getting-started.md | | What galley is, logging in, the layout, permissions |
| install-and-upgrade.md | | Installer, first cluster, options, upgrade, backup |
| overview.md | `/` | Dashboard widgets, layout, metric charts, stale data |
| changes.md | | How every change is reviewed, confirmed and run |
| activity.md | `/activity` | Running tasks and changes |
| audit-log.md | `/audit` | The audit log |
| guests.md | `/guests` | Guest list, guest page, actions, resource editor |
| create.md | `/create` | VM and container wizards, GPU, LLM preset |
| nodes.md | `/nodes` | Nodes and node pages |
| storage.md | `/storage` | Storage and storage pages |
| hardware-and-gpus.md | `/hardware` | PCI devices, mappings, GPU passthrough |
| protection.md | `/protection` | Backup coverage and jobs |
| consoles.md | `/console/:cluster/:type/:node` | VM, container and node consoles |
| assistant.md | | The assistant, and setting it up |
| agents-and-mcp.md | `/agents` | Agent tokens, MCP, REST for agents |
| api-explorer.md | `/api-explorer` | The API explorer |
| hosts.md | `/hosts` | Host commands and transports |
| clusters-and-access.md | `/clusters` | Clusters, logins, sessions, galley admins |
| settings.md | `/settings` | Galley-wide settings |
| security.md | | What galley stores and who can do what |
| keyboard-and-search.md | | Command palette and shortcuts |
| feedback.md | | Send feedback as a GitHub issue |
| troubleshooting.md | | Error messages and fixes |
