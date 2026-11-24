---
id: admin/monitoring
title: Metrics and monitoring (InfluxDB / Prometheus / Grafana)
tested: untested
risk: low
runs_on: node
---

# Metrics and monitoring

PVE keeps only short RRD graphs. For history and alerting, ship metrics out. There are two routes,
and you can run both:

| Route | How | Good for |
|---|---|---|
| **Built-in metric server** | PVE pushes to InfluxDB (v1/v2), Graphite or OpenTelemetry | Zero agents, every node/guest/storage |
| **Prometheus** | `prometheus-pve-exporter` scrapes the API; Ceph mgr `prometheus` module; node_exporter | Alerting with Alertmanager, PromQL |

Run the monitoring stack **in guests on the `infra` vnet**, ideally with a copy outside the cluster,
so you can still see what broke when the cluster is down.

## Preconditions

- A target reachable from every node, e.g. an InfluxDB/Prometheus guest at `10.10.40.10`.
- The host firewall allows the exporter ports from that network (see [firewall](firewall.md)).

## Inputs

| Variable | Meaning | Example |
|---|---|---|
| `INFLUX_URL` / `BUCKET` / `ORG` / `TOKEN` | InfluxDB v2 target | `10.10.40.10:8086`, `pve`, `ops` |
| `PROM_HOST` | Prometheus server | `10.10.40.10` |

## Steps

### 1. Built-in metric server → InfluxDB v2

```bash
pvesh create /cluster/metrics/server/influx --type influxdb --server 10.10.40.10 --port 8086 \
  --influxdbproto https --organization ops --bucket pve --token '<influx-token>' --verify-certificate 0
pvesh get /cluster/metrics/server
```

Graphite: `--type graphite --server 10.10.40.10 --port 2003`. OpenTelemetry (PVE 9): `--type opentelemetry`.

### 2. Prometheus exporter with a least-privilege token

```bash
pveum user add prometheus@pve --comment "metrics scraper"
pveum user token add prometheus@pve exporter --privsep 1      # save the secret
pveum acl modify / --tokens 'prometheus@pve!exporter' --roles PVEAuditor
```

In a container on `infra` (e.g. `scripts/pve-app.sh deploy prometheus-pve-exporter ...` if the catalog
has it, or `pip install prometheus-pve-exporter`):

```yaml
# /etc/prometheus/pve.yml
default:
  user: prometheus@pve
  token_name: exporter
  token_value: "<secret>"
  verify_ssl: false
```

```yaml
# prometheus.yml scrape job
- job_name: pve
  metrics_path: /pve
  params: { module: [default], cluster: ["1"], node: ["1"] }
  static_configs: [{ targets: ["192.0.2.11", "192.0.2.12", "192.0.2.13"] }]
  relabel_configs:
    - { source_labels: [__address__], target_label: __param_target }
    - { source_labels: [__param_target], target_label: instance }
    - { target_label: __address__, replacement: "10.10.40.11:9221" }
```

### 3. Ceph metrics

```bash
ceph mgr module enable prometheus
ceph config get mgr mgr/prometheus/server_port      # 9283 on the active mgr
```

Scrape every mgr host on 9283 (only the active one answers with data).

### 4. Grafana

Import community dashboards for "Proxmox via Prometheus" (pve-exporter), "Ceph – Cluster" (mgr
prometheus) and "Proxmox [Flux]" (InfluxDB v2). Pin dashboard versions in your Grafana provisioning.

### 5. What to alert on

| Signal | Threshold |
|---|---|
| Node down / not quorate | immediately |
| `ceph_health_status` | ≥ 1 for 5 min (WARN), 2 immediately |
| OSD down | any for 5 min |
| Pool / OSD fill | > 75% warn, > 85% critical |
| Storage (`pve_disk_usage_bytes / pve_disk_size_bytes`) | > 80% |
| Guest down that should be up (`pve_up{...}==0` with onboot) | 5 min |
| Backup task failed | any (use [notifications](notifications.md)) |
| Corosync retransmits / link down | any sustained (journal-based, or `pve-health` timer) |
| NVMe wear | > 80% |

## Verify

```bash
curl -sk "http://10.10.40.11:9221/pve?target=192.0.2.11&cluster=1&node=1" | grep -m3 pve_up
curl -s http://192.0.2.11:9283/metrics | grep -m1 ceph_health_status
```

In InfluxDB, the `system` measurement has points from every node within a minute.

## Rollback

```bash
pvesh delete /cluster/metrics/server/influx
ceph mgr module disable prometheus
pveum user delete prometheus@pve
```

## Gotchas

- InfluxDB over UDP (`--influxdbproto udp`, the default) silently drops on MTU problems; prefer HTTP(S).
- Scraping via a single node's API still returns cluster-wide data (`cluster=1`). Point Prometheus at all nodes for redundancy and deduplicate in queries.
- The exporter token needs only `PVEAuditor`. Never use `root@pam`.
- Do not host the only copy of monitoring on the cluster it monitors.
