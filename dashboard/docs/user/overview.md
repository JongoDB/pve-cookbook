---
title: Overview
summary: Use and customize the Overview dashboard, its widgets and metric charts, and understand stale and unknown data.
order: 30
route: /
---

The **Overview** page is a dashboard of widgets on a 12-column grid. Each user has their own layout; galley saves it with your account, so it follows you to other browsers.

## What the widgets show

The default layout has these widgets. You can add, remove, move and resize them.

- **Quorum**: nodes online across all clusters, and any cluster that is **Not quorate**.
- **Ceph**: health, OSDs up and in, and raw capacity for each cluster that runs Ceph.
- **Backup coverage**: how many guests are in a backup job, the first guests without a backup, and **Review fix** where galley can add a guest to a job. See [Protection](protection.md).
- **Guests**: running and total guests.
- **Node CPU** (a metric chart): CPU of every online node of your first cluster.
- **Needs attention**: health and drift findings, most severe first. A finding with a fix shows a button, such as **Add to nightly**, that opens the fix as a change. **Show all N** lists every finding.
- **Cluster network** (a metric chart): network traffic of the whole cluster.
- **Top guests by CPU**: the five busiest running guests right now.
- **Storage capacity**: used and free space per storage, unavailable storage first.
- **Recent changes**: the latest audit log entries, with who ran them.

More widgets are in the catalog:

- **GPUs**: PCI-mapped GPUs per cluster, which are **Free**, and which VM uses each. See [Hardware and GPUs](hardware-and-gpus.md).
- **Running tasks**: live PVE tasks across clusters.
- **Metric chart**: any metric of any cluster, node, guest or storage. You can add as many as you like.

## Change the time range

The time range buttons at the top (**1 h**, **24 h**, **7 d**, **30 d**, **1 y**) apply to every chart on the Overview. galley remembers your choice with the layout.

Charts show PVE's own history (RRD data). galley does not store metrics itself.

## Edit the layout

1. Select **Edit layout**. Each widget shows its tools, and the **Add a widget** catalog opens.
2. Arrange the widgets:
   - Drag a widget onto another to move it, or use **Move earlier** and **Move later** (the arrow buttons).
   - The width button cycles the widget through 3, 4, 6, 8 and 12 of 12 columns.
   - The close button removes the widget.
3. To add a widget, find it in **Add a widget** (search, or filter by **Health**, **Capacity**, **Performance**, **Protection** or **Activity**) and select **Add**. It appears at the end. Widgets that can appear only once show **Added** when they are already on the dashboard.
4. Select **Done**.

**Reset to default** restores the default widgets and keeps your time range. Changes are saved as you make them. If saving fails, galley says so; your changes stay on the page until you reload.

## Set up a metric chart

1. Select **Edit layout**.
2. On the chart, select the settings button (**Choose what <chart> shows**).
3. Fill in the form:
   - **Title**: leave empty for an automatic title, such as **Node CPU**.
   - **Cluster**: any cluster you are logged in to.
   - **Show**: **Whole cluster**, **Nodes**, **Guests** or **Storage**.
   - **Metric**: the choices depend on **Show**:
     - **CPU**, **Memory used**, **Network**, **Pressure (PSI)** and **Swap used**: cluster, nodes and guests.
     - **Disk I/O**: guests only.
     - **Load average**, **IO wait** and **Root disk used**: cluster and nodes.
     - **Storage used**: storage only.
   - Tick the nodes, guests or storages to plot. For nodes, ticking none plots every online node.
4. Select **Save chart**.

A chart draws at most five lines. If your selection makes more, pick fewer resources or a metric with fewer series.

**Whole cluster** adds up the cluster's online nodes and needs `Sys.Audit` on `/` of that cluster. Every chart shows only resources your PVE account can see.

A chart for a cluster you are not logged in to says **Log in to <cluster> to see its history.** Gaps in a line are missing samples, not zeros.

## Stale and unknown data

galley reads each cluster about every 5 seconds and keeps the last good data when a read fails. It never shows old data as current:

- A cluster is **stale** when galley could not read its status and resources on the latest attempt, or has not succeeded for three poll intervals. Widgets then show **Unknown** with the reason, for example **lab has not answered recently; last good data 2 min ago**. The navigation shows **stale** next to the cluster, and the Nodes page shows its nodes as **unknown**.
- One part of a cluster's data can fail on its own (Ceph, HA, backup jobs, backup coverage, storage configuration and others). The matching widget shows **Unknown** for that part, and **Needs attention** shows a finding such as "could not read …".
- **Backup coverage** that cannot be read is shown as **Unknown**, never as covered.

If a cluster stays stale, see [Troubleshooting](troubleshooting.md#a-cluster-is-stale-or-unreachable).

## The live indicator

The top bar shows **Live** while galley pushes updates to your browser. If the live stream drops, it shows **Polling every 5 s** and keeps retrying. The data stays current either way.
