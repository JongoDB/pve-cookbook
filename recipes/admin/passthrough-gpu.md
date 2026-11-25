---
id: admin/passthrough-gpu
title: Host resource passthrough & virtualization for GPU/LLM servers
tested: "PVE 9.2 · kernel 7.0 · 2026-11 (steps 1–6 verified on 2× A2: vfio-pci by address, mapping, q35/OVMF VM boots with the GPU, strict HA node-affinity rule, second GPU shared with an unprivileged LXC on NVIDIA 620.70.10 open modules)"
risk: high
runs_on: node
---

# Host resource passthrough for GPU/LLM servers

Give guests direct access to host hardware: full PCIe GPU passthrough to a VM (VFIO), one GPU shared by
several containers, cluster-wide resource mappings so guests reference a *name* instead of a PCI address,
HA rules that keep device-bound guests on the right node, USB mappings, and a worked LLM inference server.

Example hardware used below: **pve1 has 2× NVIDIA A2 16 GB (GA107GL, `10de:25b6`) at `0000:16:00.0`
and `0000:91:00.0`, IOMMU on; pve2/pve3 have no GPU.** All nodes have an Intel QAT co-processor.

**Choose a mode per GPU:** a GPU bound to `vfio-pci` (VM passthrough) cannot also be used by the host
driver for containers. With two GPUs, a common split is GPU 0 → VM, GPU 1 → shared by LXCs.

## Preconditions

- VT-d/AMD-Vi enabled in firmware, and IOMMU active:
  `dmesg | grep -E 'DMAR: IOMMU enabled|AMD-Vi|iommu: Default domain type: Translated'`
- Device present: `lspci -nnk | grep -A3 -i nvidia`
- No guests running that use the device; you can reboot the node (move guests away first, see [maintenance-mode](maintenance-mode.md)).

## Inputs

| Variable | Meaning | Example |
|---|---|---|
| `NODE` | Node with the device | `pve1` |
| `PCI` | Full PCI address | `0000:16:00.0` |
| `VENDOR_DEVICE` | `vendor:device` id | `10de:25b6` |
| `MAPPING` | Cluster-wide mapping name | `gpu-a2-0` |

## Steps

### 1. IOMMU and group isolation

Kernel 6.8+ enables Intel IOMMU by default. Add passthrough mode to cut DMA-translation overhead for host devices:

```bash
# GRUB-booted nodes (check: `proxmox-boot-tool status` errors / `ls /etc/kernel/cmdline` missing):
sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT="\(.*\)"/GRUB_CMDLINE_LINUX_DEFAULT="\1 intel_iommu=on iommu=pt"/' /etc/default/grub
update-grub
# systemd-boot / proxmox-boot-tool nodes (ZFS root):
#   append ' intel_iommu=on iommu=pt' to /etc/kernel/cmdline, then: proxmox-boot-tool refresh
# AMD: amd_iommu is on by default; use 'iommu=pt' only.
```

List IOMMU groups. A device passed to a VM takes **its whole group** with it:

```bash
for g in /sys/kernel/iommu_groups/*; do
  echo "group ${g##*/}:"; for d in "$g"/devices/*; do echo "   $(lspci -nns "${d##*/}")"; done
done | grep -B1 -A3 -iE 'nvidia|3d controller'
```

Good: the GPU (and its audio function, if any) alone in a group. If it shares a group with other
devices, try another slot; avoid the ACS-override patch on production hosts.

### 2. VFIO: bind the GPU to vfio-pci for a VM

```bash
cat >/etc/modprobe.d/vfio.conf <<'EOF'
options vfio-pci ids=10de:25b6 disable_vga=1
softdep nouveau pre: vfio-pci
softdep nvidia pre: vfio-pci
softdep nvidiafb pre: vfio-pci
EOF
cat >/etc/modprobe.d/blacklist-gpu.conf <<'EOF'
blacklist nouveau
blacklist nvidiafb
EOF
printf 'vfio\nvfio_iommu_type1\nvfio_pci\n' >/etc/modules-load.d/vfio.conf
update-initramfs -u -k all
reboot
```

`ids=` binds **every** device with that id. To pass one A2 to a VM and keep the other for the host
driver (LXC sharing), do not use `ids=`. Bind by address at boot instead:

```bash
cat >/etc/modprobe.d/vfio.conf <<'EOF'
install vfio-pci /usr/bin/bash -c 'echo vfio-pci > /sys/bus/pci/devices/0000:16:00.0/driver_override; /sbin/modprobe --ignore-install vfio-pci'
softdep nvidia pre: vfio-pci
softdep nouveau pre: vfio-pci
EOF
```

After reboot (verified on PVE 9.2 / kernel 7.0: the second A2 stays on the host driver):

```bash
lspci -nnk -s 16:00.0 | grep 'Kernel driver in use: vfio-pci'
```

### 3. Cluster-wide PCI resource mapping

Mappings let guest configs say `mapping=gpu-a2-0`, so a guest moved to another node with an
identical card keeps working, and non-root users can be granted the device by ACL:

```bash
pvesh create /cluster/mapping/pci --id gpu-a2-0 --description "NVIDIA A2 #0 (VM passthrough)" \
  --map node=pve1,path=0000:16:00.0,id=10de:25b6,iommugroup=10
# Add the same mapping name for another node that has an identical card:
#   --map node=pve1,path=...  --map node=pve2,path=...
pveum acl modify /mapping/pci/gpu-a2-0 --groups operators --roles PVEMappingUser
```

GUI equivalent: *Datacenter → Resource Mappings → PCI Devices → Add*.

### 4. VM with full GPU passthrough

```bash
qm create 300 --name llm01 --ostype l26 --machine q35 --bios ovmf \
  --efidisk0 vm-pool:1,efitype=4m,pre-enrolled-keys=0 \
  --cpu host --cores 8 --memory 49152 --balloon 0 \
  --scsihw virtio-scsi-single --scsi0 vm-pool:120,iothread=1,discard=on,ssd=1 \
  --net0 virtio,bridge=servers --agent enabled=1 \
  --hostpci0 mapping=gpu-a2-0,pcie=1
# x-vga=1 only for a GPU that drives the VM's display; compute cards (A2) do not need it.
# Optional hugepages: --hugepages 1024 --keephugepages 1 (reserve them at boot first).
```

Install the guest OS, then the NVIDIA datacenter driver and CUDA *inside the VM*. `nvidia-smi` should list the A2.

### 5. Pin device-bound guests with an HA node-affinity rule

On PVE 9, HA groups are replaced by rules. Keep `vm:300` on nodes that have the mapped device:

```bash
ha-manager add vm:300 --state started
ha-manager rules add node-affinity gpu-nodes --resources vm:300 --nodes pve1 --strict 1 \
  --comment "GPU guests only run where the A2 exists"
```

With `--strict 1` the guest stays stopped rather than starting on a node without the GPU. Live
migration of passthrough VMs is not possible; HA relocation is stop → start.

### 6. Share one GPU between containers (no passthrough)

Install the NVIDIA driver on the **host** (GPU 1 left bound to `nvidia`), then the **same driver
version without the kernel module** in each container:

Use NVIDIA's Debian apt repository (driver updates come through apt, and DKMS rebuilds the module
for every new PVE kernel). Open kernel modules support Turing and newer, including the A2:

```bash
# host (pve1): headers for the running kernel, and for future kernels
apt-get install -y proxmox-headers-$(uname -r) proxmox-default-headers dkms
cd /tmp && curl -fsSLO https://developer.download.nvidia.com/compute/cuda/repos/debian13/x86_64/cuda-keyring_1.1-1_all.deb
dpkg -i cuda-keyring_1.1-1_all.deb && apt-get update
apt-cache policy nvidia-driver-cuda          # pick a version; pin the same one in containers
apt-get install -y --no-install-recommends nvidia-kernel-open-dkms=<ver> nvidia-driver-cuda=<ver>
update-initramfs -u -k all                   # nouveau is blacklisted by the package
reboot                                       # set `ceph osd set noout` first on a Ceph node
dkms status                                  # nvidia/<ver>, <kernel>: installed
nvidia-smi                                   # lists only the host-driver A2 (91:00.0)
ls -l /dev/nvidia*                           # nvidia0, nvidiactl, nvidia-uvm, nvidia-uvm-tools

# container: unprivileged works; PVE 9 device syntax (galley's container wizard writes the same)
pct set 310 --dev0 /dev/nvidia0 --dev1 /dev/nvidiactl --dev2 /dev/nvidia-uvm --dev3 /dev/nvidia-uvm-tools
# inside the container: the same driver version's userland, no kernel module
cd /tmp && curl -fsSLO https://developer.download.nvidia.com/compute/cuda/repos/debian13/x86_64/cuda-keyring_1.1-1_all.deb
dpkg -i cuda-keyring_1.1-1_all.deb && apt-get update
apt-get install -y --no-install-recommends nvidia-driver-cuda=<ver>   # pulls no DKMS package
nvidia-smi
```

`/dev/nvidiaN` counts host-driver NVIDIA GPUs in PCI order, so with GPU 0 on `vfio-pci` the
shared A2 is `/dev/nvidia0`. Intel/AMD GPUs use `/dev/dri/renderD128` (add `,gid=<render gid>`).

Several containers can mount the same GPU. They share VRAM with no isolation, which suits
inference services you trust. Use `/dev/nvidia1` for the second card.

### 7. vGPU and MIG (optional, licensed)

- The NVIDIA A2/A16 support **NVIDIA vGPU** (time-sliced, mdev/SR-IOV) with the licensed NVIDIA vGPU
  host driver and a license server. PVE 8.3+/9 supports NVIDIA vGPU natively (`hostpci0: mapping=...,mdev=<type>`,
  mappings created with `--mdev 1`). Not covered or tested here.
- **MIG is not supported on A2** (only A30/A100/H100-class GPUs).

### 8. Worked example: LLM inference server

| Option | When | How |
|---|---|---|
| VM + full GPU | Strong isolation, vLLM/TensorRT, exclusive GPU | Step 4, then Ollama or vLLM inside the VM |
| LXC + shared GPU | Several small services on one card | Step 6, then `scripts/pve-app.sh deploy ollama` and set `--dev*` |

LXC via the helper catalog (`ollama`: Ubuntu 24.04, 4 vCPU, 4 GiB, 40 GiB, port 11434; `openwebui`: port 8080; `vllm`: port 8000):

```bash
pve-app deploy ollama --id 310 --vnet servers --ip 10.10.10.60/24 --gw 10.10.10.1 --dns 1.1.1.1 \
  --storage local-zfs --template-storage cephfs --cpu 8 --ram 32768 --disk 200
pct stop 310
pct set 310 --dev0 /dev/nvidia0 --dev1 /dev/nvidiactl --dev2 /dev/nvidia-uvm --dev3 /dev/nvidia-uvm-tools
pct start 310   # then install the matching NVIDIA userspace driver with --no-kernel-module
```

Sizing for a 16 GB card: 7–8B models at 8-bit or 13–14B at 4-bit fit with room for context; 30B+ needs
two cards (tensor parallel in vLLM, which in practice means passing both GPUs to one VM) or CPU offload.
Put model storage on `local-zfs` (fast, node-local). The guest is node-bound anyway.

### 9. USB passthrough via mappings

```bash
lsusb                                                   # e.g. Bus 001 Device 004: ID 10c4:ea60 ...
pvesh create /cluster/mapping/usb --id zigbee-stick --map node=pve1,id=10c4:ea60
qm set 120 --usb0 mapping=zigbee-stick
```

### 10. Intel QAT

QAT (`8086:18a0`, all nodes) accelerates compression and crypto. Pass a VF to a VM with SR-IOV via the
`qat_4xxx` driver and a PCI mapping like step 3, or use it on the host. Not covered here.

## Verify

```bash
lspci -nnk -s 16:00.0 | grep -E 'vfio-pci|nvidia'      # expected driver for the chosen mode
pvesh get /cluster/mapping/pci --output-format json-pretty
qm config 300 | grep hostpci0                           # mapping=gpu-a2-0
ha-manager rules config 2>/dev/null || pvesh get /cluster/ha/rules
qm guest exec 300 -- nvidia-smi -L                      # VM sees the GPU (needs guest agent)
pct exec 310 -- nvidia-smi -L                           # container sees the shared GPU
```

## Rollback

```bash
qm set 300 --delete hostpci0
ha-manager rules remove gpu-nodes
pvesh delete /cluster/mapping/pci/gpu-a2-0
rm -f /etc/modprobe.d/vfio.conf /etc/modprobe.d/blacklist-gpu.conf /etc/modules-load.d/vfio.conf
update-initramfs -u -k all && reboot
```

## Gotchas

- A VM with a passthrough device cannot live-migrate or be snapshotted with RAM state.
- `vfio-pci ids=` grabs every identical card. Use `driver_override` per address to split modes.
- Host and container NVIDIA driver versions must match exactly; a kernel update needs DKMS to rebuild
  the host module before containers work again.
- Container `devN` entries reference device nodes that must exist on the node at start; `nvidia-uvm`
  appears only after the module loads (run `nvidia-smi` once at boot or install `nvidia-persistenced`).
- `--balloon 0` is required with passthrough (DMA needs pinned memory); the VM reserves its full RAM.
- Resetting some GPUs (FLR) fails after a guest crash; the node may need a reboot to recover the card.
