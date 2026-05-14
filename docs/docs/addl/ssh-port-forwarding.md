---
sidebar_position: 3
---

# Raspberry Pi Remote Access
## SSH Port Forwarding

**Setup:** Desktop PC (Windows) → SSH → Raspberry Pi · **Goal:** Open Pi-hosted services in the local browser on the desktop

---

## Table of Contents

1. [How This Works](#1-how-this-works)
2. [SSH Config File](#2-ssh-config-file)
3. [Hosts File](#3-hosts-file)
4. [Opening Tunnels](#4-opening-tunnels)
5. [Managing Active Tunnels](#5-managing-active-tunnels)
6. [Quick Reference](#6-quick-reference)

---

## 1. How This Works

Because the cluster runs on a Raspberry Pi and is only accessible over SSH, the services are not directly reachable from the desktop browser. SSH port forwarding solves this by creating an encrypted tunnel: a local port on the desktop is bound to a port on the Pi, so any browser request to `localhost:<port>` is transparently forwarded through SSH and delivered to the Pi.

```
Desktop browser
  └── localhost:8080
        └── SSH tunnel (pc.key)
              └── Raspberry Pi (100.104.202.56)
                    └── app.task.local:80
                          └── ingress-nginx → frontend pod
```

There are two tunnels configured for this project:

| SSH Host alias | Local port (desktop) | Destination on Pi | Service |
|---------------|---------------------|-------------------|---------|
| `app.pi` | `8080` | `app.task.local:80` | Task Manager frontend |
| `argo.pi` | `8090` | `argocd.task.local:80` | ArgoCD dashboard |

---

## 2. SSH Config File

The SSH config file stores the tunnel definitions so you don't have to type the full command every time. On Windows, open it with:

```powershell
notepad ~/.ssh/config
```

Add the following entries:

```
Host app.pi
    HostName 100.104.202.56
    User pi
    IdentityFile ~/.ssh/pc.key
    LocalForward 8080 app.task.local:80
    ExitOnForwardFailure yes
    RequestTTY no

Host argo.pi
    HostName 100.104.202.56
    User pi
    IdentityFile ~/.ssh/pc.key
    LocalForward 8090 argocd.task.local:80
    ExitOnForwardFailure yes
    RequestTTY no
```

### What each option does

| Option | Purpose |
|--------|---------|
| `HostName` | The actual IP address of the Raspberry Pi |
| `User` | SSH username on the Pi |
| `IdentityFile` | Private key used to authenticate |
| `LocalForward` | Binds a local port on the desktop to a host:port reachable from the Pi |
| `ExitOnForwardFailure yes` | Kills the tunnel if the port forward fails instead of staying open silently |
| `RequestTTY no` | Skips allocating a terminal — this is a background tunnel, not an interactive session |

> **Note:** `LocalForward 8080 app.task.local:80` means "on the Pi side, resolve `app.task.local:80`". The hostname resolution happens on the Pi, not on your desktop. This is why `app.task.local` only needs to exist in the Pi's DNS or your desktop's hosts file — see Section 3.

---

## 3. Hosts File

The hostnames `app.task.local` and `argocd.task.local` are not real DNS entries. They are mapped locally on the desktop so the browser sends requests to `localhost`, which SSH then picks up and forwards.

On Windows, open the hosts file as Administrator:

```
C:\Windows\System32\drivers\etc\hosts
```

Add these lines:

```
127.0.0.1 task.local
127.0.0.1 app.task.local
127.0.0.1 argocd.task.local
```

After saving, the browser will resolve `app.task.local` to `127.0.0.1` (your own machine), where the SSH tunnel is listening and forwarding traffic to the Pi.

> **Note:** You need to open Notepad (or any editor) as Administrator to save changes to the hosts file.

---

## 4. Opening Tunnels

### Windows (recommended — background process, no terminal window)

```powershell
# Task Manager app
Start-Process ssh -ArgumentList "-N app.pi" -WindowStyle Hidden

# ArgoCD dashboard
Start-Process ssh -ArgumentList "-N argo.pi" -WindowStyle Hidden
```

`-WindowStyle Hidden` keeps the SSH process running silently in the background with no visible terminal window. `-N` tells SSH not to execute any remote command — it only forwards ports.

### Linux / macOS

```bash
# Task Manager app
ssh -fN app.pi

# ArgoCD dashboard
ssh -fN argo.pi
```

`-f` backgrounds the process after authentication. `-N` forwards only, no remote command.

### Manual one-off (without SSH config)

If you haven't set up the config file yet or want to test a specific port:

```bash
ssh -i ~/.ssh/pc.key -L 8080:localhost:8080 pi@100.104.202.56 -N -f
```

### Accessing in the browser

Once the tunnel is open:

| URL | Service |
|-----|---------|
| `http://app.task.local:8080` | Task Manager frontend |
| `http://argocd.task.local:8090` | ArgoCD dashboard |

---

## 5. Managing Active Tunnels

### Check if a tunnel is running (Windows)

```powershell
# List all SSH processes
Get-Process ssh

# Check if a specific port is in use
netstat -ano | findstr :8080
netstat -ano | findstr :8090
```

The output of `netstat` shows the PID in the last column.

### Kill a tunnel by PID (Windows)

```powershell
# Using Stop-Process (PowerShell)
Stop-Process -Id <PID>

# Using taskkill (Command Prompt or PowerShell)
taskkill /PID <PID> /F
```

### Kill a tunnel by port (Linux)

```bash
# Find and kill the process holding port 8080
kill $(lsof -ti:8080)
```

---

## 6. Quick Reference

### Full setup sequence (first time)

```
1. Add host entries to C:\Windows\System32\drivers\etc\hosts
2. Add Host blocks to ~/.ssh/config
3. Start tunnels with Start-Process ssh -ArgumentList "-N app.pi" -WindowStyle Hidden
4. Open http://app.task.local:8080 in the browser
```

### Daily workflow

```powershell
# Start both tunnels
Start-Process ssh -ArgumentList "-N app.pi"   -WindowStyle Hidden
Start-Process ssh -ArgumentList "-N argo.pi"  -WindowStyle Hidden

# Check tunnels are alive
Get-Process ssh

# Stop all tunnels
Get-Process ssh | Stop-Process
```

### Port map summary

| Alias | Local (desktop) | Forwarded to (Pi) | Opens |
|-------|----------------|-------------------|-------|
| `app.pi` | `:8080` | `app.task.local:80` | Task Manager |
| `argo.pi` | `:8090` | `argocd.task.local:80` | ArgoCD |

---

*Task Manager DevOps Documentation · SSH Access Section*
