---
title: API explorer
summary: Browse every path of your cluster's PVE API, read anything live, and create, change or delete anything the API offers, through a reviewed change.
order: 120
route: /api-explorer
---

The **API** page is an explorer for the PVE API of one cluster. It covers everything the API offers, so you can do things galley has no dedicated page for: firewall rules, SDN, users and ACLs, HA rules, storage configuration, snapshot rollbacks, and more.

galley loads the API schema from the cluster itself, so the explorer always matches that cluster's PVE version.

## Find a path

1. Open **API** in the navigation. With several clusters, choose one under **Cluster**.
2. Type in **Search paths and descriptions**, for example `qemu config`, `firewall` or `ha`. The list shows matching paths with their methods (**GET**, **POST**, **PUT**, **DELETE**).
3. Select a path.

The path's page shows:

- the method buttons: choose **GET**, **POST**, **PUT** or **DELETE**;
- PVE's description of the method;
- **Permissions**: what PVE requires, in PVE's own terms, for example `["perm","/vms/{vmid}",["VM.Config.Disk"]]`;
- fields for the path's variables, such as `{node}` (a list of the cluster's nodes) and `{vmid}`;
- what the method returns.

The selected path and method are kept in the address, so you can bookmark them.

## Read something

1. Choose a path and **GET**, and fill in the path variables.
2. Optionally open **Query parameters** and fill some in.
3. Check the `pvesh get …` line; it is the same read from a shell.
4. Select **Read it now**.

The answer appears as JSON, with **Copy JSON**. A read runs with your PVE login and changes nothing. If PVE refuses, galley shows **PVE answered with an error:** and the reason.

## Create, change or delete something

1. Choose a path and **POST** (create), **PUT** (change) or **DELETE**, and fill in the path variables.
2. Fill in the form. It is the resource editor, built from the schema:
   - For **PUT** on something that exists, the form is filled with the current values, and only what you change is sent.
   - For **POST**, the required fields are shown; add others with **Add a setting**.
   - See [Guests](guests.md#the-resource-editor) for how the editor works.
3. Check the **Preview** (`pvesh create`, `pvesh set` or `pvesh delete`).
4. Select **Review change**. The change opens in **Changes**.
5. Review it, type the confirmation text if asked, and select **Apply change**.

## How validation works

Before a change reaches **Changes**, the form checks each field's type, range and allowed values, and that required fields are filled in. On the server, galley checks the call again against the cluster's schema:

- the method exists for that path;
- every parameter exists for that method (numbered families such as `net0` and `net1` match `net[n]`);
- types, ranges, formats and allowed values are right;
- required parameters are present;
- the path is plain: no trailing slash and no percent-encoding.

PVE then checks your permissions when the change runs.

A call is destructive, and asks for typed confirmation, when it deletes something, stops or resets a guest, rolls back, wipes or initializes disks, changes a password, removes settings, and in a few other cases. See [How changes work](changes.md#typed-confirmation).

## Examples

### Set the number of cores of VM 120

1. Search `qemu config` and choose `/nodes/{node}/qemu/{vmid}/config`.
2. Choose **PUT**. Set `{node}` to the VM's node and `{vmid}` to `120`.
3. Change `cores` to `4`.
4. **Review change**, then apply it. The command is `pvesh set /nodes/pve1/qemu/120/config --cores 4 --digest …`.

### Roll back a snapshot

1. Choose `/nodes/{node}/qemu/{vmid}/snapshot/{snapname}/rollback` and **POST**.
2. Fill in the node, VMID and snapshot name.
3. **Review change**. A rollback is destructive: type `confirm <snapshot>/rollback`, then apply it.

### Add a firewall rule to a VM

1. Choose `/nodes/{node}/qemu/{vmid}/firewall/rules` and **POST**.
2. Fill in `type` (`in` or `out`) and `action` (`ACCEPT`, `DROP`, `REJECT` or a security group), then add `proto`, `dport` and `source` with **Add a setting**.
3. **Review change**, then apply it.

### Delete a PCI mapping

1. Choose `/cluster/mapping/pci/{id}` and **DELETE**, and fill in the mapping id.
2. **Review change**. Type `delete pci/<id>`, then apply it.

## Tips

- Ask the [assistant](assistant.md) to draft a change if you are not sure which path or parameters to use. It looks up the same schema.
- For a read that you want to repeat, copy the `pvesh get` line.
- Some settings PVE allows only for `root@pam`, for example raw PCI devices on a VM. The **Permissions** section names such rules.
