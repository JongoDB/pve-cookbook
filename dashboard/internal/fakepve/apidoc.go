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
            "memory":{"type":"string","optional":1,"description":"Memory properties."},
            "cores":{"type":"integer","optional":1,"minimum":1,"default":1},
            "ostype":{"type":"string","optional":1,"enum":["other","wxp","w2k","w2k3","w2k8","wvista","win7","win8","win10","win11","l24","l26","solaris"]},
            "net[n]":{"type":"string","optional":1,"format":"pve-qm-net"},
            "scsi[n]":{"type":"string","optional":1},
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
              "cores":{"type":"integer","optional":1,"minimum":1,"maximum":1024},
              "memory":{"type":"string","optional":1},
              "balloon":{"type":"integer","optional":1,"minimum":0},
              "hostpci[n]":{"type":"string","optional":1},
              "net[n]":{"type":"string","optional":1},
              "delete":{"type":"string","optional":1,"format":"pve-configid-list"},
              "digest":{"type":"string","optional":1,"maxLength":64}}}}}}
        ]}
      ]}
    ]}
  ]}
];
let method2cmd = { GET: 'get', POST: 'create', PUT: 'set', DELETE: 'delete' };
`
