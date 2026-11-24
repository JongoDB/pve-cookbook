const e = encodeURIComponent;

export const guestPath = (clusterId: string, vmid: number | string) => `/guests/${e(clusterId)}/${e(String(vmid))}`;
export const nodePath = (clusterId: string, node: string) => `/nodes/${e(clusterId)}/${e(node)}`;
/** Shared storage is one resource per cluster; local storage is per node (id@node). */
export const storageKey = (id: string, node: string, shared: boolean) => (shared ? id : `${id}@${node}`);
export const storagePath = (clusterId: string, id: string, node: string, shared: boolean) => `/storage/${e(clusterId)}/${e(storageKey(id, node, shared))}`;
