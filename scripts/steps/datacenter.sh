# summary: datacenter options (migration net, HA/CRS policy, console) + nightly backup job
# shellcheck shell=bash

step_datacenter() {
  local f; f="$(founder)"
  on "$f" "pvesh set /cluster/options \
    --migration type=secure,network=$(q network.backend.cidr) \
    --ha shutdown_policy=$(q ha.shutdown_policy migrate) \
    --crs ha=$(q ha.crs static),ha-rebalance-on-start=1 \
    --console xtermjs --next-id lower=100,upper=999999"
  local sched store; sched="$(q backups.schedule '')"; store="$(q backups.storage '')"
  if [[ -n "$sched" && -n "$store" ]]; then
    on "$f" "pvesh get /cluster/backup --output-format json | grep -q '\"id\":\"nightly-all\"' || \
      pvesh create /cluster/backup --id nightly-all --schedule '$sched' --storage $store --all 1 --mode snapshot \
        --compress zstd --enabled 1 --repeat-missed 1 --notes-template '{{guestname}} on {{node}}' \
        --comment 'Nightly snapshot backup of all guests'"
  fi
  [[ "$PVECB_DRY_RUN" == "1" ]] || peek "$f" 'pvesh get /cluster/options --output-format json' | sed 's/^/    /'
}
