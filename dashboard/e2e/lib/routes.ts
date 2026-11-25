import { CLUSTER, GUEST } from './env';

/**
 * Every route in web/src/App.tsx, with real demo ids for the parameters.
 * `h1` is the heading the page must show.
 */
export const ROUTES: { path: string; h1: RegExp }[] = [
  { path: '/', h1: /^Overview$/ },
  { path: '/guests', h1: /^Guests$/ },
  { path: `/guests/${CLUSTER}/${GUEST.web01.vmid}`, h1: /^web01/ },
  { path: `/guests/${CLUSTER}/${GUEST.grafana.vmid}`, h1: /^grafana/ },
  { path: `/guests/${CLUSTER}/${GUEST.llm.vmid}`, h1: /^llm-vllm/ },
  { path: '/nodes', h1: /^Nodes$/ },
  { path: `/nodes/${CLUSTER}/pve1`, h1: /^pve1$/ },
  { path: '/storage', h1: /^Storage$/ },
  { path: `/storage/${CLUSTER}/vm-pool`, h1: /^vm-pool$/ },
  { path: `/storage/${CLUSTER}/local%40pve1`, h1: /^local/ },
  { path: '/protection', h1: /^Protection$/ },
  { path: '/activity', h1: /^Activity$/ },
  { path: '/audit', h1: /^Audit log$/ },
  { path: '/clusters', h1: /^Clusters$/ },
  { path: '/create', h1: /^Create$/ },
  { path: '/create?kind=ct', h1: /^Create$/ },
  { path: '/hardware', h1: /^Hardware$/ },
  { path: '/hosts', h1: /^Hosts$/ },
  { path: '/api-explorer', h1: /^API$/ },
  { path: '/settings', h1: /^Settings$/ },
  { path: '/agents', h1: /^Agents$/ },
  { path: '/help', h1: /^Help$/ },
  { path: '/help/guests', h1: /^Guests$/ },
  { path: `/console/${CLUSTER}/node/pve1`, h1: /^pve1 shell$/ },
  { path: `/console/${CLUSTER}/qemu/pve1/${GUEST.web01.vmid}`, h1: /^web01 console$/ },
  { path: `/console/${CLUSTER}/lxc/pve2/${GUEST.grafana.vmid}`, h1: /^grafana console$/ },
];

/** Paths that are redirects by design (App.tsx). */
export const REDIRECTS: { from: string; to: string }[] = [
  { from: '/operations', to: '/activity' },
  { from: '/no-such-page', to: '/' },
];

/** The SPA's catch-all sends unknown paths to "/": a link that lands there from elsewhere is broken. */
export function routeKnown(pathname: string): boolean {
  const pats = [
    /^\/$/, /^\/guests$/, /^\/guests\/[^/]+\/\d+$/, /^\/nodes$/, /^\/nodes\/[^/]+\/[^/]+$/, /^\/storage$/, /^\/storage\/[^/]+\/[^/]+$/,
    /^\/protection$/, /^\/activity$/, /^\/operations$/, /^\/audit$/, /^\/clusters$/, /^\/create$/, /^\/hardware$/, /^\/hosts$/,
    /^\/api-explorer$/, /^\/settings$/, /^\/agents$/, /^\/help$/, /^\/help\/[^/]+$/, /^\/console\/[^/]+\/[^/]+\/[^/]+(\/[^/]+)?$/,
  ];
  return pats.some((p) => p.test(pathname));
}
