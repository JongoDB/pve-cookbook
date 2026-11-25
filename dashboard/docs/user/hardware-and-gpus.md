---
title: Hardware and GPUs
summary: Find PCI devices and GPUs, check IOMMU groups and kernel drivers, create PCI mappings, pass a GPU through to a VM, pin GPU VMs with HA rules, and share a GPU with containers.
order: 80
route: /hardware
---

The **Hardware** page shows the PCI devices of every node in a cluster, GPUs first, with their IOMMU groups, and the cluster's PCI mappings. With several clusters, choose one under **Cluster**.

## PCI mappings

A PCI mapping gives a device a cluster-wide name, such as `gpu-a2-0`, and lists which node has it at which address. A VM then refers to the mapping (`hostpci0: mapping=gpu-a2-0`) instead of a slot on one node. That has two benefits:

- PVE knows which nodes have the card, so it can refuse to migrate or recover the VM to a node without it.
- A mapping can list the same model of card on several nodes, so the VM can run on any of them.

The **PCI mappings** table lists each mapping, its devices (node, address and IOMMU group) and **Used by**: the VMs whose configuration refers to it (stopped ones are marked **stopped**), and **Free** when no running VM holds the card. Each VM also shows whether HA keeps it on the card's nodes: **pinned to <nodes>**, or **Pin to GPU nodes**. See [Pin a GPU VM with HA](#pin-a-gpu-vm-with-ha).

If any VM uses a raw device without a mapping, the page says so under the table: **Raw devices (no mapping): …** These VMs cannot move to another node.

The **GPUs** widget on the [Overview](overview.md) shows the same information in brief: how many mapped GPUs are free, and which VM uses each.

## PCI devices per node

Below the mappings there is one table per node:

- **Address**: the PCI address, for example `0000:16:00.0`.
- **Device**: vendor and model, the PCI class and vendor:device IDs, and a **GPU** badge for graphics cards.
- **IOMMU group**: the group number. For GPUs it also says **isolated**, or which other devices share the group.
- **Mapping**: the mapping that covers this device, **Create mapping** for an unmapped GPU, or **none**.

Bridges and chipset devices are hidden; **Show N bridges and chipset devices** shows them.

### Check which driver a GPU uses

PVE's API does not say which kernel driver a device uses: `vfio-pci` (ready for VM passthrough) or the vendor's driver (for example `nvidia`, ready to share with containers). Host administrators (`Sys.Modify`, `Sys.Console` and `Permissions.Modify` on `/`) see **Check driver** on each GPU. It drafts the read-only host command `lspci -nnk -s <address>` on that node, with the reason **Show which kernel driver uses <device>**, and opens it in **Changes**. Apply it (type `run on <node>` to confirm); the output appears there and in the audit log. The line `Kernel driver in use:` names the driver. See [Hosts](hosts.md).

Listing PCI devices needs `Sys.Audit` or `Sys.Modify` on `/`. Without either, the node's table says **PCI devices not available**. PVE lists only the mappings you hold `Mapping.Audit`, `Mapping.Use` or `Mapping.Modify` on.

## Create a PCI mapping for a GPU

1. On the **Hardware** page, find the GPU in its node's table.
2. Select **Create mapping**. A form opens, filled in for this device:
   - **id**: a suggested name such as `gpu-a2-0`. Change it if you like.
   - **map**: the device on this node, as `node=…,path=…,id=<vendor>:<device>,iommugroup=…` (plus `subsystem-id` when known).
   - **description**: the device and where it is.
3. If the device shares its IOMMU group with other devices, the form warns you: passthrough hands the whole group to the VM.
4. Select **Review change**, then apply it in **Changes**. The call is `POST /cluster/mapping/pci`.

Creating mappings needs `Mapping.Modify` on `/mapping/pci`.

To add the same model of card on another node to an existing mapping, change the mapping's `map` list with the [API explorer](api-explorer.md) (`PUT /cluster/mapping/pci/{id}`), or in the PVE interface.

## Attach a GPU to a VM

For a new VM, use the **GPU** step of the VM wizard. See [Create a VM or container](create.md#attach-a-gpu). It sets everything in the checklist below except HA.

For an existing VM:

1. Open the VM and go to the **Hardware** tab.
2. Select **Add device**, then **PCI device or GPU**.
3. In the new `hostpci` field, set **mapping** to the mapping's id and turn on **pcie**. As text this is `mapping=gpu-a2-0,pcie=1`.
4. Select **Review change**, then apply it.
5. Restart the VM from galley with **Reboot**, or **Shut down** and **Start**. A reboot from inside the guest does not apply new hardware.

Using a mapping needs `Mapping.Use` on it. Raw devices (`hostpci0: 0000:16:00.0`) are allowed only for `root@pam` logged in with a ticket; they fail with personal API tokens.

## Pin a GPU VM with HA

A VM with a passed-through GPU can run only on a node that has the card, and it cannot live-migrate. If HA manages it, give it a strict node-affinity HA rule so HA never moves or recovers it to a node without the card.

- **New VMs**: the VM wizard does this by default when you choose a mapping (**Keep this VM on nodes that have this GPU**). See [Create a VM or container](create.md#keep-a-gpu-vm-on-the-nodes-with-its-card).
- **Existing VMs**: in **Used by**, select **Pin to GPU nodes** next to the VM. The change has up to two calls:
  1. `POST /cluster/ha/resources` with `sid=vm:<vmid>`, state `started` for a running VM or `stopped` for a stopped one. This is left out when the VM is already an HA resource.
  2. `POST /cluster/ha/rules`: `rule=gpu-<vmid>`, `type=node-affinity`, `resources=vm:<vmid>`, `nodes=` the nodes in the mapping's map entries, `strict=1`, comment `galley: <mapping> only exists on these nodes`.

Apply it in **Changes**. Afterwards the VM shows **pinned to <nodes>**. galley reads the rules with `GET /cluster/ha/rules`; a VM counts as pinned when an enabled node-affinity rule names it. HA rules need PVE 9; reading them needs `Sys.Audit` on `/`, creating them `Sys.Console` on `/`. On older PVE, use an HA group instead.

If you extend the mapping to another node later, add that node to the rule's `nodes` too (in PVE's HA settings, or with the [API explorer](api-explorer.md), `PUT /cluster/ha/rules/{rule}`).

## Share a GPU with containers

A container shares a GPU with its node instead of taking it over: the node runs the vendor driver, and the container gets the device nodes. Several containers can use one card at the same time. A card bound to `vfio-pci` for a VM cannot be shared; use **Check driver** to see which driver a card has.

To share an NVIDIA GPU:

1. **On the node**, install the NVIDIA driver (the kernel module and `nvidia-smi`). `nvidia-smi -L` lists the GPUs on the host driver; their order is the N of `/dev/nvidiaN`. Make sure `/dev/nvidia-uvm` exists (run `nvidia-modprobe -u -c=0` once, or start a CUDA program on the node).
2. **Create the container** with the container wizard's **GPU** step, **Share an NVIDIA GPU (host driver)**. It adds `dev0: /dev/nvidiaN`, `dev1: /dev/nvidiactl`, `dev2: /dev/nvidia-uvm` and `dev3: /dev/nvidia-uvm-tools` (PVE syntax `devN: <path>[,gid=…,mode=…]`). For an existing container, add the same `devN` entries on its **Hardware** tab.
3. **In the container**, install the NVIDIA userland of exactly the same driver version as the node, without the kernel module. For Debian, use NVIDIA's CUDA repository and install the driver's userland packages (for example `nvidia-driver-cuda` and its libraries) at the node's version, without `nvidia-kernel-dkms`; or run NVIDIA's `.run` installer with `--no-kernel-module`.
4. Run `nvidia-smi` inside the container. It should show the GPU and the same driver version as the node.

For Intel or AMD graphics, choose **Share an Intel/AMD GPU (/dev/dri)**: it adds `dev0: /dev/dri/renderD128`. Set **Group id in the container** to the container's `render` group id (`getent group render` inside it) so non-root users can use the device. Install the userland drivers (Mesa, VA-API or ROCm) in the container.

Shared GPUs have no PCI mapping, so galley does not pin such containers with HA. Keep them out of HA, or add a node-affinity rule yourself.

## GPU passthrough checklist

Check these before you start a VM with a GPU:

- **IOMMU is on.** The node's firmware has VT-d (Intel) or AMD-Vi (AMD) enabled, and the device has an IOMMU group number. A group of **none** means IOMMU is off.
- **The group is isolated.** Ideally the GPU shares its IOMMU group only with its own functions (such as its audio device). Every device in the group goes to the VM.
- **Machine q35.** PCIe passthrough (`pcie=1`) needs the q35 machine type.
- **Firmware OVMF (UEFI).** Modern GPUs need UEFI. OVMF also needs an EFI disk.
- **Ballooning off.** A passed-through device pins all of the VM's memory, so the balloon cannot reclaim any. Set the balloon minimum to 0.
- **CPU type host** is recommended for GPU workloads.
- **Use a mapping, not a raw device**, so PVE knows where the card is.
- **Pin it under HA.** If the VM is managed by HA, give it a strict node-affinity HA rule for the nodes the mapping covers (HA groups on PVE versions before 9). Otherwise HA may try to recover it to a node without the card. The VM wizard adds the rule by default, **Pin to GPU nodes** adds it for an existing VM (see [Pin a GPU VM with HA](#pin-a-gpu-vm-with-ha)), and the assistant can draft it.
- **One VM per card at a time.** Check **Used by** before you attach a card that is already in use.

The VM wizard and the assistant follow this checklist. You can also ask the [assistant](assistant.md), for example "Attach the second A2 GPU to llm-vllm"; it drafts the calls for you to review.
