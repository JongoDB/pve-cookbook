---
title: Create a VM or container
summary: Use the Create wizards to build a new VM or container, attach a GPU and pin the VM to its nodes with HA, share a GPU with a container, use the LLM server preset, and boot from a cloud image.
order: 60
route: /create
---

The **Create** page builds a new VM or container step by step. It does not create anything itself: it builds the exact PVE API call, shows it as a `pvesh` command, and opens it in **Changes**, where you apply it. The guest is created with your PVE permissions.

## Before you start

- Log in to the cluster you want to create on. With several clusters, choose it under **Cluster** at the top.
- You need `VM.Allocate` (on `/vms` or the target pool), `Datastore.AllocateSpace` on the storages you choose, and the right to use the bridge or VNet (`SDN.Use`). For a GPU through a PCI mapping you need `Mapping.Use` on that mapping.
- Choose **Virtual machine** or **Container** with the tabs at the top.
- The wizard builds the request for a node you can see. If your PVE account sees no online node of the cluster, the page says so instead; ask a PVE administrator for `Sys.Audit` on `/nodes`.

## How the wizard works

- The steps are listed on the left. Select any step to jump to it, or use **Back** and **Next: <step>**.
- The **Preview** panel on the right always shows the command that will run, and **Request body (JSON)** shows the API call. **Copy** copies the command.
- Under the preview, galley lists anything that must be fixed first, for example **Choose a storage for the disk.** **Review change** is available once the list is empty.
- Select **Review change**. The change opens in **Changes**. Apply it there. See [How changes work](changes.md).

## Create a VM

1. **General**: choose the **Node**. galley fills in the next free **VMID**; change it if you like. Enter a **Name** (a DNS name: letters, digits, dots and hyphens) and optional **Tags**. Tick **Start after it is created** and **Start when <node> boots** as needed.
2. **OS and media**: choose the **Guest OS** and the **Boot media**:
   - **Install from an ISO**: choose an **ISO image** from the node's storages.
   - **Cloud image with cloud-init**: see [Boot from a cloud image](#boot-from-a-cloud-image).
   - **No media**.
3. **System**: **Machine** (**q35 (PCIe, recommended)** or **i440fx (legacy)**) and **Firmware** (**OVMF (UEFI)** or **SeaBIOS (legacy BIOS)**). With OVMF, choose the **EFI disk storage** or keep the boot disk's storage. The SCSI controller is VirtIO SCSI single, and the QEMU guest agent is enabled.
4. **Disk**: the **Storage** and **Size (GiB)** of the boot disk (`scsi0`). **I/O thread**, **Discard (TRIM)** and **Show as SSD** are on by default.
5. **CPU and memory**: **Cores**, **Sockets**, **CPU type**, **Memory (MiB)** and **Balloon minimum (MiB)**. CPU type `host` is fastest, but live migration then needs identical CPUs on every node; `x86-64-v2-AES` migrates anywhere. A balloon minimum of 0 turns ballooning off; empty keeps PVE's default.
6. **Network**: the **Bridge or VNet** (bridges on the node and SDN VNets), the **Model** (VirtIO, Intel E1000E or VMware vmxnet3), an optional **VLAN tag**, and **PVE firewall on this interface**.
7. **GPU**: optional. See [Attach a GPU](#attach-a-gpu).

Defaults: 2 cores, 1 socket, CPU type `host`, 4096 MiB memory, q35 with OVMF, a 32 GiB disk, and a VirtIO network device on `vmbr0` with the firewall on.

The result is a single call, `POST /nodes/<node>/qemu` (`pvesh create /nodes/<node>/qemu …`). If you ticked **Start after it is created**, the same call starts the VM. With a mapped GPU and **Keep this VM on nodes that have this GPU** on, two HA calls follow; see [Keep a GPU VM on the nodes with its card](#keep-a-gpu-vm-on-the-nodes-with-its-card).

## Boot from a cloud image

Choose **Cloud image with cloud-init** on the **OS and media** step.

1. **Boot disk image (optional)**: choose a disk image stored on a storage with the **Import** content type, for example `debian-13-genericcloud-amd64.qcow2` or Ubuntu's `noble-server-cloudimg-amd64.img`. galley copies it as the boot disk (`import-from=`), so the disk size comes from the image; grow the disk after creation if you need more. Or choose **Empty disk: I will import an image later** and run `qm disk import <vmid> <image> <storage>` afterwards.
2. **Cloud-init user**: the user to create, for example `debian`.
3. **Address**: **DHCP** or **Static**. For static, enter the **Address/prefix** (for example `192.0.2.50/24`) and the **Gateway**.
4. **SSH public keys**: one OpenSSH public key per line.

galley adds a cloud-init drive on the boot disk's storage. galley does not set passwords; log in with your SSH key.

## Attach a GPU

The **GPU** step lists the cluster's **PCI mappings** and the **Display controllers on <node>**.

- **PCI mappings** are the safe choice. A mapping names a card cluster-wide, so PVE knows which nodes have it. Mappings that do not cover the chosen node are shown but cannot be selected. To create a mapping, see [Hardware and GPUs](hardware-and-gpus.md).
- A display controller without a mapping is attached as a raw device. That ties the VM to the node: HA and migration cannot move it. PVE allows raw devices only for `root@pam`, and only with a login ticket, not with personal API tokens.
- Each entry shows its PCI address, IOMMU group and whether the group is isolated or shared with other devices.
- Listing the node's PCI devices needs `Sys.Audit` on `/`. Without it you can still choose a mapping.

Choosing a GPU:

- attaches it as `hostpci0` with `pcie=1`;
- switches the VM to q35 and OVMF (and locks those fields);
- turns ballooning off, because a passed-through device pins all guest memory;
- sets CPU type `host`.

Choose **No GPU** to remove the GPU again.

### Keep a GPU VM on the nodes with its card

When you choose a PCI mapping, the GPU step shows **Keep this VM on nodes that have this GPU**, on by default. It pins the VM with HA, so HA never moves or recovers it to a node without the card. The change then has three calls:

1. `POST /nodes/<node>/qemu`: creates the VM.
2. `POST /cluster/ha/resources` with `sid=vm:<vmid>`: adds the VM to HA, with state `started` if you ticked **Start after it is created**, otherwise `stopped`. With the option on, HA starts the VM, so the create call does not.
3. `POST /cluster/ha/rules`: a strict node-affinity HA rule named `gpu-<vmid>` (`type=node-affinity`, `resources=vm:<vmid>`, `nodes=` the nodes the mapping covers, `strict=1`, comment `galley: <mapping> only exists on these nodes`).

HA then restarts the VM only on those nodes if its node fails. Live migration is not possible with passthrough. HA rules need PVE 9 and `Sys.Console` on `/`. Turn the option off to create the VM without HA; you can pin it later from the [Hardware](hardware-and-gpus.md#pin-a-gpu-vm-with-ha) page.

A raw device (no mapping) has no HA option: HA only knows where a card is through a mapping.

## Use the LLM server preset

**Use the LLM server preset** (on the **General** step, and on the **GPU** step) prepares a VM for running a language model server:

- the first PCI mapping that covers the node, if there is one, attached as described above;
- at least 16 cores, 64 GiB memory and a 200 GiB disk;
- name `llm-server` if you have not entered one, and tags `gpu` and `ai`;
- boot media switched to **Cloud image with cloud-init**, for a Debian or Ubuntu cloud image.

The preset only sets the VM's hardware. It does not install a model server; install your engine (for example vLLM, Ollama or llama.cpp) in the VM afterwards.

## Create a container

1. **General**: **Node**, **CT ID** (galley fills in the next free ID) and **Hostname**. **Unprivileged (recommended)** and **Nesting** are on by default; nesting is needed by systemd in recent distributions. Enter **SSH public keys for root**, one per line; this is required, because galley never sets a root password. Tick **Start after it is created** (on by default) and **Start when <node> boots** as needed.
2. **Template**: choose a container template from the node's storages. To get more templates, run `pveam update && pveam available` on the node, or download them in the PVE interface.
3. **Root disk**: **Storage** and **Size (GiB)**.
4. **CPU and memory**: **Cores**, **Memory (MiB)** and **Swap (MiB)**.
5. **Network**: **Bridge or VNet**, optional **VLAN tag**, **IPv4** (**DHCP** or **Static**, with **Address/prefix** and **Gateway**), and **PVE firewall on this interface**.
6. **GPU**: optional. See [Share a GPU with a container](#share-a-gpu-with-a-container).

Defaults: unprivileged with nesting, 1 core, 1024 MiB memory, 512 MiB swap, an 8 GiB root disk, DHCP on `vmbr0` with the firewall on.

The result is a single call, `POST /nodes/<node>/lxc`. galley refuses private keys in the SSH key field; paste the public key (`.pub`). To set a root password later, run `pct enter <id>` on the node and use `passwd`.

## Share a GPU with a container

A container does not take a GPU over like a VM does: the node keeps its driver, and the container gets the device nodes. Several containers can share one card. A card passed through to a VM (on `vfio-pci`) cannot be shared. The container wizard's **GPU** step offers:

- **No GPU** (the default).
- **Share an NVIDIA GPU (host driver)**: adds `dev0: /dev/nvidiaN`, `dev1: /dev/nvidiactl`, `dev2: /dev/nvidia-uvm` and `dev3: /dev/nvidia-uvm-tools`. **NVIDIA GPU number** is N: it counts the GPUs on the NVIDIA host driver of the node in PCI order (cards on `vfio-pci` do not count). Check with `nvidia-smi -L` on the node; host administrators can select **Check on <node>** to draft that command.
- **Share an Intel/AMD GPU (/dev/dri)**: adds `dev0: /dev/dri/renderD128` (change the **Render node** if the node has several) with an optional **Group id in the container**, usually the container's `render` group.

The container needs the GPU's userland: for NVIDIA, the same driver version as the node, without the kernel module. See [Share a GPU with containers](hardware-and-gpus.md#share-a-gpu-with-containers). A shared GPU has no PCI mapping, so galley does not pin the container with HA.

## After you apply

The new guest appears on the [Guests](guests.md) page as soon as PVE reports it. The task is in the drawer's **Activity** tab, and the change is in the audit log.
