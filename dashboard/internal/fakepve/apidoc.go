package fakepve

// APIDoc is a small excerpt in the shape of PVE's api-viewer apidoc.js
// (written for tests; real clusters serve their full, version-matched schema).
const APIDoc = `// generated
const apiSchema = [
 {"path":"/nodes","text":"nodes","leaf":0,"info":{"GET":{"method":"GET","name":"index","description":"Cluster node index.","parameters":{"type":"object","properties":{}}}},
  "children":[
   {"path":"/nodes/{node}","text":"{node}","leaf":0,"info":{"GET":{"method":"GET","description":"Node index.","parameters":{"type":"object","properties":{"node":{"type":"string","format":"pve-node"}}}}},
    "children":[
     {"path":"/nodes/{node}/qemu","text":"qemu","leaf":0,"info":{
        "GET":{"method":"GET","description":"Virtual machine index (per node).","parameters":{"type":"object","properties":{"node":{"type":"string"}}}},
        "POST":{"method":"POST","description":"Create or restore a virtual machine.","protected":1,"permissions":{"description":"You need 'VM.Allocate' permissions on /vms/{vmid}"},
          "parameters":{"type":"object","properties":{
            "node":{"type":"string","format":"pve-node"},
            "vmid":{"type":"integer","minimum":100,"maximum":999999999,"description":"The (unique) ID of the VM."},
            "name":{"type":"string","optional":1,"maxLength":128},
            "memory":{"type":"string","optional":1,"description":"Memory in MiB."},
            "balloon":{"type":"integer","optional":"1","minimum":"0"},
            "cores":{"type":"integer","optional":1,"minimum":1,"default":1},
            "sockets":{"type":"integer","optional":1,"minimum":1,"default":1},
            "cpu":{"type":"string","optional":1,"description":"Emulated CPU type."},
            "machine":{"type":"string","optional":1},
            "bios":{"type":"string","optional":1,"enum":["seabios","ovmf"],"default":"seabios"},
            "scsihw":{"type":"string","optional":1,"enum":["lsi","lsi53c810","virtio-scsi-pci","virtio-scsi-single","megasas","pvscsi"]},
            "agent":{"type":"string","optional":1},
            "boot":{"type":"string","optional":1},
            "onboot":{"type":"boolean","optional":1},
            "description":{"type":"string","optional":1,"maxLength":8192},
            "tags":{"type":"string","optional":1},
            "efidisk0":{"type":"string","optional":1},
            "ostype":{"type":"string","optional":1,"enum":["other","wxp","w2k","w2k3","w2k8","wvista","win7","win8","win10","win11","l24","l26","solaris"]},
            "net[n]":{"type":"string","optional":1,"format":"pve-qm-net"},
            "scsi[n]":{"type":"string","optional":1},
            "ide[n]":{"type":"string","optional":1},
            "hostpci[n]":{"type":"string","optional":1},
            "ipconfig[n]":{"type":"string","optional":1},
            "ciuser":{"type":"string","optional":1},
            "sshkeys":{"type":"string","optional":1},
            "start":{"type":"boolean","optional":1,"default":0}}}}},
      "children":[
       {"path":"/nodes/{node}/qemu/{vmid}","text":"{vmid}","leaf":0,"info":{
          "GET":{"method":"GET","description":"Directory index","parameters":{"type":"object","properties":{"node":{"type":"string"},"vmid":{"type":"integer","minimum":100}}}},
          "DELETE":{"method":"DELETE","description":"Destroy the VM and all used/owned volumes.","protected":1,"parameters":{"type":"object","properties":{"node":{"type":"string"},"vmid":{"type":"integer","minimum":100},"purge":{"type":"boolean","optional":1},"destroy-unreferenced-disks":{"type":"boolean","optional":1}}}}},
        "children":[
         {"path":"/nodes/{node}/qemu/{vmid}/config","text":"config","leaf":1,"info":{
            "GET":{"method":"GET","description":"Get the virtual machine configuration.","parameters":{"type":"object","properties":{"node":{"type":"string"},"vmid":{"type":"integer","minimum":100}}}},
            "PUT":{"method":"PUT","description":"Set virtual machine options (synchronous API).","protected":1,"parameters":{"type":"object","properties":{
              "node":{"type":"string"},"vmid":{"type":"integer","minimum":100},
            "name":{"type":"string","optional":1,"maxLength":128},
            "memory":{"type":"string","optional":1,"description":"Memory in MiB."},
            "balloon":{"type":"integer","optional":1,"minimum":0},
            "cores":{"type":"integer","optional":1,"minimum":1,"default":1},
            "sockets":{"type":"integer","optional":1,"minimum":1,"default":1},
            "cpu":{"type":"string","optional":1,"description":"Emulated CPU type."},
            "machine":{"type":"string","optional":1},
            "bios":{"type":"string","optional":1,"enum":["seabios","ovmf"],"default":"seabios"},
            "scsihw":{"type":"string","optional":1,"enum":["lsi","lsi53c810","virtio-scsi-pci","virtio-scsi-single","megasas","pvscsi"]},
            "agent":{"type":"string","optional":1},
            "boot":{"type":"string","optional":1},
            "onboot":{"type":"boolean","optional":1},
            "description":{"type":"string","optional":1,"maxLength":8192},
            "tags":{"type":"string","optional":1},
            "efidisk0":{"type":"string","optional":1},
            "ostype":{"type":"string","optional":1,"enum":["other","wxp","w2k","w2k3","w2k8","wvista","win7","win8","win10","win11","l24","l26","solaris"]},
            "net[n]":{"type":"string","optional":1,"format":"pve-qm-net"},
            "scsi[n]":{"type":"string","optional":1},
            "ide[n]":{"type":"string","optional":1},
            "hostpci[n]":{"type":"string","optional":1},
            "ipconfig[n]":{"type":"string","optional":1},
            "ciuser":{"type":"string","optional":1},
            "sshkeys":{"type":"string","optional":1},

              "delete":{"type":"string","optional":1,"format":"pve-configid-list"},
              "digest":{"type":"string","optional":1,"maxLength":64}}}}}}
        ]}
      ]}
,
     {"path":"/nodes/{node}/lxc","text":"lxc","leaf":0,"info":{
        "GET":{"method":"GET","description":"LXC container index (per node).","parameters":{"type":"object","properties":{"node":{"type":"string"}}}},
        "POST":{"method":"POST","description":"Create or restore a container.","protected":1,"parameters":{"type":"object","properties":{
          "node":{"type":"string"},"vmid":{"type":"integer","minimum":100},"ostemplate":{"type":"string","maxLength":255},
          "hostname":{"type":"string","optional":1},"unprivileged":{"type":"boolean","optional":1},"features":{"type":"string","optional":1},
          "cores":{"type":"integer","optional":1,"minimum":1},"memory":{"type":"integer","optional":1,"minimum":16},"swap":{"type":"integer","optional":1,"minimum":0},
          "rootfs":{"type":"string","optional":1},"net[n]":{"type":"string","optional":1},"ssh-public-keys":{"type":"string","optional":1},
          "password":{"type":"string","optional":1},"start":{"type":"boolean","optional":1},"onboot":{"type":"boolean","optional":1},"tags":{"type":"string","optional":1}}}}},
      "children":[
       {"path":"/nodes/{node}/lxc/{vmid}","text":"{vmid}","leaf":0,"info":{
          "DELETE":{"method":"DELETE","description":"Destroy the container (also delete all uses files).","protected":1,"parameters":{"type":"object","properties":{"node":{"type":"string"},"vmid":{"type":"integer","minimum":100},"purge":{"type":"boolean","optional":1}}}}},
        "children":[
         {"path":"/nodes/{node}/lxc/{vmid}/config","text":"config","leaf":1,"info":{
            "GET":{"method":"GET","description":"Get container configuration.","parameters":{"type":"object","properties":{"node":{"type":"string"},"vmid":{"type":"integer","minimum":100}}}},
            "PUT":{"method":"PUT","description":"Set container options.","protected":1,"parameters":{"type":"object","properties":{
              "node":{"type":"string"},"vmid":{"type":"integer","minimum":100},"cores":{"type":"integer","optional":1,"minimum":1},"memory":{"type":"integer","optional":1,"minimum":16},
              "swap":{"type":"integer","optional":1,"minimum":0},"hostname":{"type":"string","optional":1},"onboot":{"type":"boolean","optional":1},"features":{"type":"string","optional":1},
              "net[n]":{"type":"string","optional":1},"mp[n]":{"type":"string","optional":1},"tags":{"type":"string","optional":1},"description":{"type":"string","optional":1},
              "delete":{"type":"string","optional":1},"digest":{"type":"string","optional":1,"maxLength":64}}}}}}
        ]}
      ]},
     {"path":"/nodes/{node}/status","text":"status","leaf":1,"info":{
        "GET":{"method":"GET","description":"Read node status","parameters":{"type":"object","properties":{"node":{"type":"string"}}}},
        "POST":{"method":"POST","description":"Reboot or shutdown a node.","protected":1,"parameters":{"type":"object","properties":{"node":{"type":"string"},"command":{"type":"string","enum":["reboot","shutdown"]}}}}}}
    ]}
  ]},
 {"path":"/cluster","text":"cluster","leaf":0,"info":{"GET":{"method":"GET","description":"Cluster index.","parameters":{"type":"object","properties":{}}}},
  "children":[
   {"path":"/cluster/nextid","text":"nextid","leaf":1,"info":{"GET":{"method":"GET","description":"Get next free VMID.","parameters":{"type":"object","properties":{"vmid":{"type":"integer","optional":1}}}}}},
   {"path":"/cluster/mapping","text":"mapping","leaf":0,"info":{"GET":{"method":"GET","description":"List resource types.","parameters":{"type":"object","properties":{}}}},
    "children":[
     {"path":"/cluster/mapping/pci","text":"pci","leaf":0,"info":{
        "GET":{"method":"GET","description":"List PCI Hardware Mapping","parameters":{"type":"object","properties":{}}},
        "POST":{"method":"POST","description":"Create a new hardware mapping.","protected":1,"permissions":{"description":"Only admins can create mappings"},"parameters":{"type":"object","properties":{
          "id":{"type":"string","maxLength":128},"map":{"type":"array","items":{"type":"string"}},"description":{"type":"string","optional":1},"mdev":{"type":"boolean","optional":1}}}}}}
    ]}
  ]}
];
let method2cmd = { GET: 'get', POST: 'create', PUT: 'set', DELETE: 'delete' };
`
