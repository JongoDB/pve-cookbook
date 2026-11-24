---
title: Keyboard and search
summary: Use the command palette to jump to anything, run guest commands, search the help, and ask the assistant, plus the keyboard shortcuts galley has.
order: 170
---

## Open the command palette

Press ⌘K on a Mac or Ctrl K elsewhere, or select **Ask, search or run a command** in the top bar. Press Esc to close it.

- Up and down arrow keys move through the results; Enter opens the selected one.
- With nothing typed, the palette lists galley's pages, then **What's new** and **Send feedback**.

## Search

Type part of a name or a VMID. With several words (`local pve3`), each word has to match. The palette finds:

- **guests** by name or VMID (with type, status, cluster and node);
- **nodes** by name;
- **storage** by name;
- **pages**, such as **Hardware** or **Audit log**;
- **help pages** of this guide, shown as **Help: <title>**;
- **What's new**, which shows the release notes of this galley version (see [Getting started](getting-started.md#whats-new-after-an-update));
- **Send feedback**, which opens the feedback dialog (see [Send feedback](feedback.md)). It is missing when a galley admin turned feedback off.

Select a result to open it.

## Run a guest command

Type a command and a guest (its VMID or name; a unique beginning of a name is enough):

- `start <guest>`
- `shutdown <guest>`
- `reboot <guest>`
- `stop <guest>`
- `migrate <guest> <node>`
- `snapshot <guest> [name]` (or `snap`). Without a name, galley uses `galley-<date>`, for example `galley-20261124`.
- `destroy <guest>`

The palette shows a preview of the commands. Press Enter to open the change in **Changes**, where you review and apply it. Nothing runs from the palette itself. See [How changes work](changes.md).

If the input is not valid, the palette says why, for example `no guest with VMID 999`, `"web" is ambiguous: web01, web02…` or `no node "pve9" in this cluster`. A VMID that exists in several clusters must be given by name.

A migration moves a running VM live, and restarts a running container on the target.

## Ask the assistant

Anything that is not a command can go to the assistant: choose **Ask the assistant: <your text>**. Questions (text ending in `?`, starting with words such as "why", "how", "what", "show" or "list", or longer than three words) put this choice first. The answer appears in the drawer's **Assistant** tab. See [Assistant](assistant.md).

## Other keyboard shortcuts

- **Drawer tabs**: with focus on the tab row, left and right arrow keys switch between **Assistant**, **Changes** and **Activity**.
- **Drawer**: Esc folds the drawer on narrow screens.
- **Assistant**: Enter sends a message; Shift+Enter starts a new line.
- **Tabs on a page** (such as a guest's **Summary**, **Hardware** and others): left and right arrow keys.
- **Account menu** and other menus: Esc closes them.
- **Dialogs** (What's new, Send feedback): Esc closes them; Tab stays inside the dialog until it is closed.
- **Skip to content**: the first Tab on a page offers a link that skips the navigation.
