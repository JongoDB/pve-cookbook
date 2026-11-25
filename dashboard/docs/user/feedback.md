---
title: Send feedback
summary: Report a bug, suggest an idea or ask a question about galley as a GitHub issue, and what the issue includes.
order: 175
---

**Send feedback** turns a bug report, an idea or a question into a new issue on GitHub. galley fills in the issue for you; you review it on GitHub and submit it from your own GitHub account. galley holds no GitHub credential and sends nothing itself.

## Send feedback

1. Choose **Send feedback** in the account menu (your user name in the top bar), at the top of **Help**, or in the command palette (⌘K or Ctrl K).
2. Choose the **Kind**: **Bug**, **Idea** or **Question**. It becomes the issue's label (`bug`, `enhancement` or `question`).
3. Enter a **Title**.
4. Describe it in **What happened** (a bug), **What you'd like** (an idea) or **Your question**.
5. Decide whether to keep **Include galley version and this page's address** ticked. The dialog lists exactly what it adds (see below).
6. Select **Continue on GitHub**. A new tab opens GitHub's new-issue form with your text filled in.
7. Read it on GitHub, change anything you like, and submit it. Nothing is filed until you do.

**Cancel**, Esc or the close button drop the draft.

You need a GitHub account to submit the issue. If you are not signed in to GitHub, it asks you to sign in first.

## Issues are public

Issues on a public repository can be read by anyone. The dialog reminds you: **Issues on <repository> are public. Don't include passwords, IPs or other private details.** Leave out host names, addresses, user names and configuration you would not publish. Describe the problem instead, or replace names with placeholders.

## What the issue includes

The issue holds your title and description, and, when **Include galley version and this page's address** is ticked, a **Details** section with:

- the galley version, for example `galley 0.2.0`;
- the page's path in galley, for example `/guests/lab/120`. It can contain a cluster's ID, a node or storage name or a VMID; untick the box if that is private;
- your browser's user agent (browser name, version and operating system).

Nothing else from galley or your clusters is included. The issue ends with *Sent from galley's feedback dialog.*

A very long description does not fit in a link: galley shortens it and says so. Add the rest on GitHub before you submit.

## Where feedback goes

By default issues go to galley's own repository, `JongoDB/pve-cookbook`. A galley admin can send them to another repository, or turn **Send feedback** off; it is then hidden everywhere. See [Settings](settings.md#feedback).
