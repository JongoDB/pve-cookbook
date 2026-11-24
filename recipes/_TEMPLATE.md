---
id: area/short-name            # stable ID agents reference, e.g. cluster/04-ceph
title: Human title
tested: "PVE 9.2 · Ceph 19.2 (squid) · 3-node HCI · 2026-11"   # or: untested
risk: low | medium | high       # high = can destroy data or cut off access
runs_on: operator | node | any  # where commands execute
automated_by: scripts/pvecb <step>   # optional
---

# Title

One paragraph: what this recipe produces and when to use it.

## Preconditions

- Facts that must be true before starting, each with a command that proves it.

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|

## Steps

1. Exact commands. Idempotent where possible. Explain *why* only when non-obvious.

## Verify

Commands with the expected output. An agent must not report success until these pass.

## Rollback

How to undo each step, or why it cannot be undone.

## Gotchas

Failure modes seen in the field, symptoms, and the fix.
