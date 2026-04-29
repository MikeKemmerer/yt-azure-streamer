# yt-azure-streamer

A parameterized, prefix-driven Azure deployment for a YouTube streaming VM with:

- ARM template (parameterized with "namePrefix")
- cloud-init provisioning
- streamer + scheduler services
- schedule-sync automation
- blobfuse2 mount
- Web UI (frontend + backend)
- Caddy reverse proxy
- systemd service wiring

---

## Deployment


## 1. Create a resource group

``bash
az group create \
  --name <resource-group> \
  --location westus2
```


## 2. Deploy the ARM template

``bash
az deployment group create \
  --resource-group streamer-rg \
  --template-file arm/azuredeploy.json \
  --parameters namePrefix=<prefix> \
              adminPublicKey="$(cat ~/.ssh/id_rsa.pub)"
```


Example:

``bash
az deployment group create \
  --resource-group streamer-rg \
  --template-file arm/azuredeploy.json \
  --parameters namePrefix=stdemo \
             adminPublicKey="$(cat ~/.ssh/id_rsa.pub)"
```


---

## Log Automation Contributor role


```
.scripts/role-assign.sh <resource-group> <prefix>
```


Example:

``bash
.scripts/role-assign.sh streamer-rg stdemo
```


This grants the VM smanaged identity permission to update Azure Automation schedules.

---


## Schedule Sync

```
.scripts/schedule-sync.sh <resource-group> <prefix>

```


Inside the VM, schedule-sync runs automatically via:

- schedule-sync.service
- schedule-sync.timer

---


## Directory Layout


```
repo/
  arm/
    azuredeploy.json
  cloud-init/
    cloud-init.yaml
  scripts/
    role-assign.sh
    schedule-sync.sh
  services/
    streamer/
      streamer.sh
    scheduler/
      scheduler.sh
  systemd/
    streamer.service
    scheduler.service
    schedule-sync.service
    schedule-sync.timer
  caddy/
    Caddyfile
 blobfuse2/
    blobfuse2.yaml
  web/
    backend/
      server.js
        config.json
    frontend/
       index.html
       app.js
        style.css 
 caddy/
    Caddyfile
 install/
     install-services.sh
```


---


## Web UI


```
http://<vm-public-ip>/```


The UI will show you:

- prefix
- storage account name
- automation account name

---


## Notes

- All names derive from `namePrefix`
- Storage account name is lowercase prefix
- Automation account is `<prefix>-automation`
- VM is `<prefix>-vm`

