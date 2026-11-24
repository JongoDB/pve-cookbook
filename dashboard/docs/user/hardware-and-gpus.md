---
title: Hardware and GPUs
summary: Find PCI devices and GPUs, check IOMMU groups, create PCI mappings, and pass a GPU through to a VM safely.
order: 80
route: /hardware
---

The **Hardware** page shows the PCI devices of every node in a cluster, GPUs first, with their IOMMU groups, and the cluster's PCI mappings. With several clusters, choose one under **Cluster**.

## PCI mappings

A PCI mapping gives a device a cluster-wide name, such as `gpu-a2-0`, and lists which node has it at which address. A VM then refers to the mapping (`hostpci0: mapping=gpu-a2-0`) instead of a slot on one node. That has two benefits:

- PVE knows which nodes have the card, so it can refuse to migrate or recover the VM to a node without it.
- A mapping can list the same model of card on several nodes, so the VM can run on any of them.

The **PCI mappings** table lists each mapping, its devices (node, address and IOMMU group) and **Used by**: the VMs whose configuration refers to it, or **Free**.

If any VM uses a raw device without a mapping, the page says so under the table: **Raw devices (no mapping): …** These VMs cannot move to another node.

The **GPUs** widget on the [Overview](overview.md) shows the same information in brief: how many mapped GPUs are free, and which VM uses each.

## PCI devices per node

Below the mappings there is one table per node:

- **Address**: the PCI address, for example `0000:16:00.0`.
- **Device**: vendor and model, the PCI class and vendor:device IDs, and a **GPU** badge for graphics cards.
- **IOMMU group**: the group number. For GPUs it also says **isolated**, or which other devices share the group.
- **Mapping**: the mapping that covers this device, **Create mapping** for an unmapped GPU, or **none**.

Bridges and chipset devices are hidden; **Show N bridges and chipset devices** shows them.

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

## GPU passthrough checklist

Check these before you start a VM with a GPU:

- **IOMMU is on.** The node's firmware has VT-d (Intel) or AMD-Vi (AMD) enabled, and the device has an IOMMU group number. A group of **none** means IOMMU is off.
- **The group is isolated.** Ideally the GPU shares its IOMMU group only with its own functions (such as its audio device). Every device in the group goes to the VM.
- **Machine q35.** PCIe passthrough (`pcie=1`) needs the q35 machine type.
- **Firmware OVMF (UEFI).** Modern GPUs need UEFI. OVMF also needs an EFI disk.
- **Ballooning off.** A passed-through device pins all of the VM's memory, so the balloon cannot reclaim any. Set the balloon minimum to 0.
- **CPU type host** is recommended for GPU workloads.
- **Use a mapping, not a raw device**, so PVE knows where the card is.
- **Pin it under HA.** If the VM is managed by HA, add a node-affinity rule in PVE's HA settings that limits it to the nodes the mapping covers (HA groups on PVE versions before 9). Otherwise HA may try to recover it to a node without the card. galley does not create this rule for you; the assistant can draft it.
- **One VM per card at a time.** Check **Used by** before you attach a card that is already in use.

The VM wizard and the assistant follow this checklist. You can also ask the [assistant](assistant.md), for example "Attach the second A2 GPU to llm-vllm"; it drafts the calls for you to review.
