// Demo-mode fixtures. These identities and ids come from internal/fakepve
// (the in-process fake cluster that `galley --demo` registers as demo-lab).
export const CLUSTER = 'demo-lab';
export const USERS = {
  root: { username: 'root', realm: 'pam', password: 'secret', id: 'root@pam' }, // galley admin, Sys.Modify on /
  dev: { username: 'dev', realm: 'pve', password: 'devpass', id: 'dev@pve' }, // restricted: sees only guest 121
  ops: { username: 'ops', realm: 'pve', password: 'opspass', id: 'ops@pve' }, // Sys.Audit, not an admin
} as const;
export type Role = keyof typeof USERS;
export const STATE = (role: Role) => `.auth/${role}.json`;

/** Demo guests (fakepve.New). */
export const GUEST = {
  web01: { vmid: 120, node: 'pve1', type: 'qemu' }, // running, HA
  web02: { vmid: 121, node: 'pve2', type: 'qemu' }, // running; the only guest dev@pve may see
  grafana: { vmid: 131, node: 'pve2', type: 'lxc' }, // running, not in a backup job
  llm: { vmid: 300, node: 'pve1', type: 'qemu' }, // stopped, GPU mapping
} as const;

export const baseURL = () => `http://127.0.0.1:${process.env.GALLEY_E2E_PORT}`;
