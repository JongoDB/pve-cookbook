import { useEffect, useState } from 'react';
import type { Api, Guest } from '../api/types';
import { useApp } from '../state/app';
import { hostpciRefs, type PciMapping } from './pci';

export interface GpuUser { guest: Guest; key: string; mapping?: string; host?: string }

export interface ClusterGpus {
  clusterId: string;
  mappings: PciMapping[];
  /** VMs with a hostpciN (running ones only, unless includeStopped), by what they reference */
  users: GpuUser[];
  error?: string;
}

const CONFIG_TTL = 60_000;
const MAX_CONFIGS = 60;
const cache = new Map<string, { at: number; cfg: Record<string, unknown> }>();

async function configOf(api: Api, g: Guest): Promise<Record<string, unknown> | null> {
  const k = `${g.clusterId}:${g.vmid}:${g.node}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CONFIG_TTL) return hit.cfg;
  try {
    const cfg = await api.pve<Record<string, unknown>>(g.clusterId, `nodes/${g.node}/qemu/${g.vmid}/config`);
    cache.set(k, { at: Date.now(), cfg });
    return cfg;
  } catch { return null; }
}

/** Run tasks with at most n in flight. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const j = i++; out[j] = await fn(items[j]); }
  }));
  return out;
}

/**
 * PCI mappings and which running VMs use passthrough, per cluster. A mapping counts as assigned
 * when a running VM's config has a hostpciN with mapping=<id>. includeStopped also reads the
 * configs of stopped VMs (Hardware lists them, e.g. to pin them to their GPU's nodes). Reads at
 * most 60 VM configs per cluster (cached for a minute), through the user's own PVE session.
 */
export function useGpuUsage(clusterIds: string[], refresh = '', includeStopped = false): ClusterGpus[] | null {
  const { api, guests } = useApp();
  const [data, setData] = useState<ClusterGpus[] | null>(null);
  const running = (guests ?? []).filter((g) => g.type === 'qemu' && !g.template && (includeStopped || g.status === 'running') && clusterIds.includes(g.clusterId))
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));
  const key = `${clusterIds.join(',')}|${running.map((g) => `${g.clusterId}:${g.vmid}@${g.node}:${g.status}`).join(',')}|${refresh}`;
  const ready = guests !== null;
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const vms = running;
    void Promise.all(clusterIds.map(async (cid): Promise<ClusterGpus> => {
      try {
        const mappings = await api.pve<PciMapping[]>(cid, 'cluster/mapping/pci').catch((e) => {
          if ((e as { status?: number }).status === 403) return [] as PciMapping[];
          throw e;
        });
        const list = vms.filter((g) => g.clusterId === cid).slice(0, MAX_CONFIGS);
        const cfgs = await pool(list, 6, (g) => configOf(api, g));
        const users: GpuUser[] = [];
        list.forEach((g, i) => { for (const r of hostpciRefs(cfgs[i] ?? {})) users.push({ guest: g, ...r }); });
        return { clusterId: cid, mappings, users };
      } catch (e) {
        return { clusterId: cid, mappings: [], users: [], error: e instanceof Error ? e.message : String(e) };
      }
    })).then((r) => { if (alive) setData(r); });
    return () => { alive = false; };
    // `running` is captured through `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, ready]);
  return data;
}

export const usersOf = (c: ClusterGpus, mappingId: string) => c.users.filter((u) => u.mapping === mappingId);
/** Users of a mapping whose VM is running (the one holding the card). */
export const runningUsersOf = (c: ClusterGpus, mappingId: string) => usersOf(c, mappingId).filter((u) => u.guest.status === 'running');
