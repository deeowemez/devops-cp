---
sidebar_position: 3
---

# ArgoCD — GitOps Deployment Documentation

**Reference:** [ArgoCD Getting Started](https://argo-cd.readthedocs.io/en/stable/getting_started/) · [ArgoCD CLI Installation](https://argo-cd.readthedocs.io/en/stable/cli_installation/) · [Image Updater](https://argocd-image-updater.readthedocs.io/en/stable/install/installation/)

---

## Table of Contents

1. [How This Works](#1-how-this-works)
2. [Installation](#2-installation)
3. [ArgoCD CLI](#3-argocd-cli)
4. [Accessing the Dashboard](#4-accessing-the-dashboard)
5. [Login and Initial Setup](#5-login-and-initial-setup)
6. [Connecting a Git Repository](#6-connecting-a-git-repository)
7. [Creating an Application](#7-creating-an-application)
8. [ArgoCD Image Updater](#8-argocd-image-updater)
9. [Ingress Setup](#9-ingress-setup)
10. [Quick Reference](#10-quick-reference)

---

## 1. How This Works

ArgoCD is a GitOps continuous delivery tool for Kubernetes. Instead of manually running `helm upgrade` or `kubectl apply` after every change, ArgoCD watches a Git repository and automatically syncs the cluster state to match whatever is in the repo.

```
Git repository (GitLab)
  └── app/task-app/          ← Helm chart
        └── ArgoCD watches this path
              └── detects drift between Git and cluster
                    └── syncs → helm upgrade / kubectl apply
                          └── task-app namespace on the cluster
```

**Key concepts:**

| Term | Meaning |
|------|---------|
| **Application** | An ArgoCD object that links a Git repo path to a cluster namespace |
| **Sync** | ArgoCD applying Git state to the cluster |
| **Drift** | When the live cluster state no longer matches what's in Git |
| **Image Updater** | A companion tool that watches a container registry and updates image tags in Git automatically |

---

## 2. Installation

### 2.1 Create the namespace

```bash
kubectl create namespace argocd
kubens argocd
```

### 2.2 Install via Helm

```bash
# Add the Argo Helm repo
helm repo add argo https://argoproj.github.io/argo-helm

# Install ArgoCD into the argocd namespace
helm install argocd argo/argo-cd
```

> **Note:** This installs ArgoCD with its default values. For production use, you would customise `values.yaml` to configure ingress, TLS, resource limits, and so on. For this local setup the defaults are sufficient.

---

## 3. ArgoCD CLI

The ArgoCD CLI is used to log in, register repositories, and create applications from the terminal. Because the cluster runs on a Raspberry Pi (ARM64), the ARM64 binary must be downloaded explicitly.

### 3.1 Install on Raspberry Pi (ARM64)

```bash
# Fetch the latest stable version tag
VERSION=$(curl -L -s https://raw.githubusercontent.com/argoproj/argo-cd/stable/VERSION)

# Download the ARM64 binary
curl -sSL -o argocd-linux-arm64 \
  https://github.com/argoproj/argo-cd/releases/download/v$VERSION/argocd-linux-arm64

# Install to system path
sudo install -m 555 argocd-linux-arm64 /usr/local/bin/argocd

# Clean up the downloaded file
rm argocd-linux-arm64

# Verify
argocd version
```

> **Note:** The `install -m 555` command moves the binary to `/usr/local/bin` and sets it as executable by all users. This is equivalent to `cp` + `chmod`.

---

## 4. Accessing the Dashboard

ArgoCD's web UI runs inside the cluster. There are two ways to access it from the desktop.

### Option A — kubectl port-forward (quick, no ingress needed)

```bash
kubectl port-forward svc/argocd-server -n argocd 8090:443
```

Then open `https://localhost:8090` in the browser. You will get a TLS warning because ArgoCD uses a self-signed certificate by default — this is safe to bypass for local use.

### Option B — SSH tunnel via ingress (persistent, recommended)

Once ingress is configured (see Section 9), the tunnel defined in `~/.ssh/config` handles access:

```powershell
# Windows — background tunnel
Start-Process ssh -ArgumentList "-N argo.pi" -WindowStyle Hidden
```

Then open `http://argocd.task.local:8090` in the browser.

---

## 5. Login and Initial Setup

### 5.1 Retrieve the initial admin password

ArgoCD generates a random initial password stored in a Kubernetes secret:

```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d
```

### 5.2 Log in via CLI

```bash
# Using the initial password (one-liner)
argocd login localhost:8090 \
  --username admin \
  --password $(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d) \
  --insecure

# Or interactively (prompts for password)
argocd login localhost:8090 --username admin --insecure
```

`--insecure` skips TLS verification. Required here because ArgoCD is running without a valid certificate in the local setup.

### 5.3 Change the admin password

```bash
argocd account update-password
```

After changing the password, the initial secret can be deleted — ArgoCD no longer needs it:

```bash
kubectl -n argocd delete secret argocd-initial-admin-secret
```

---

## 6. Connecting a Git Repository

ArgoCD needs access to the GitLab repository that holds the Helm chart. Authentication uses an SSH key.

```bash
kubens argocd

argocd repo add git@gitlab.com:deeowemez/task-app.git \
  --ssh-private-key-path ~/.ssh/pi.key
```

Verify the repo is connected:

```bash
argocd repo list
```

The output should show the repo URL with a `Successful` connection status.

> **Note:** The SSH key used here (`pi.key`) must have read access to the GitLab repository. Add the corresponding public key (`pi.key.pub`) to the GitLab repo under **Settings → Repository → Deploy Keys**.

---

## 7. Creating an Application

An ArgoCD Application is the object that links a Git repo path to a destination namespace in the cluster.

```bash
kubens argocd

argocd app create task-app \
  --repo git@gitlab.com:deeowemez/task-app.git \
  --path app/task-app \
  --dest-server https://kubernetes.default.svc \
  --dest-namespace task-app
```

### What each flag means

| Flag | Value | Meaning |
|------|-------|---------|
| `--repo` | `git@gitlab.com:deeowemez/task-app.git` | Git repo ArgoCD watches |
| `--path` | `app/task-app` | Path inside the repo containing the Helm chart |
| `--dest-server` | `https://kubernetes.default.svc` | The cluster to deploy to (this cluster itself) |
| `--dest-namespace` | `task-app` | The namespace resources are deployed into |

> **Note:** `https://kubernetes.default.svc` is the internal address of the Kubernetes API server. Using this means ArgoCD deploys to the same cluster it is running on, which is the standard setup for a single-cluster GitOps workflow.

### Verify the application

```bash
argocd app list
argocd app get task-app
```

---

## 8. ArgoCD Image Updater

The Image Updater is a companion tool that watches a container registry for new image tags and automatically updates the running application — without requiring a manual Git commit or `helm upgrade`.

### 8.1 Install

```bash
kubens argocd

kubectl apply -n argocd \
  -f https://raw.githubusercontent.com/argoproj-labs/argocd-image-updater/stable/config/install.yaml

# Verify the pod is running
kubectl get pods -n argocd
```

### 8.2 How it fits into the workflow

```
New image pushed to registry
  └── Image Updater detects the new tag
        └── updates the image tag in Git (or as an override)
              └── ArgoCD detects the Git change
                    └── syncs the cluster → rolling update
```

> **Note:** Image Updater requires the ArgoCD application to have the correct annotations set in the app definition to specify which images to watch and what tag strategy to use (e.g. `semver`, `latest`). Refer to the [Image Updater docs](https://argocd-image-updater.readthedocs.io) for annotation configuration.

---

## 9. Ingress Setup

By default, ArgoCD's server uses HTTPS with a self-signed certificate. This conflicts with a plain HTTP ingress. The fix is to disable ArgoCD's internal TLS so ingress-nginx can handle TLS termination (or pass plain HTTP in a local setup).

### 9.1 Disable ArgoCD internal TLS

```bash
kubectl patch deployment argocd-server -n argocd \
  --type='json' \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args","value":["--insecure"]}]'
```

This adds the `--insecure` flag to the `argocd-server` container, telling it to serve plain HTTP instead of HTTPS. Ingress-nginx then handles the connection from the outside.

> **Note:** In a local setup this is fine. For a publicly exposed ArgoCD instance you would terminate TLS at the ingress level using a proper certificate (e.g. cert-manager + Let's Encrypt) rather than disabling TLS entirely.

### 9.2 Ingress resource

The ingress rule for ArgoCD uses the hostname `argocd.task.local`, which is mapped in the desktop's hosts file and forwarded via the `argo.pi` SSH tunnel on port 8090.

Refer to the **SSH Port Forwarding** documentation for the tunnel and hosts file configuration.

---

## 10. Quick Reference

### Installation sequence (first time)

```bash
kubectl create namespace argocd
kubens argocd
helm repo add argo https://argoproj.github.io/argo-helm
helm install argocd argo/argo-cd
# Install CLI (ARM64)
VERSION=$(curl -L -s https://raw.githubusercontent.com/argoproj/argo-cd/stable/VERSION)
curl -sSL -o argocd-linux-arm64 https://github.com/argoproj/argo-cd/releases/download/v$VERSION/argocd-linux-arm64
sudo install -m 555 argocd-linux-arm64 /usr/local/bin/argocd
rm argocd-linux-arm64
# Disable internal TLS for ingress compatibility
kubectl patch deployment argocd-server -n argocd \
  --type='json' \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args","value":["--insecure"]}]'
# Connect repo and create app
argocd repo add git@gitlab.com:deeowemez/task-app.git --ssh-private-key-path ~/.ssh/pi.key
argocd app create task-app --repo git@gitlab.com:deeowemez/task-app.git --path app/task-app --dest-server https://kubernetes.default.svc --dest-namespace task-app
```

### Common commands

```bash
argocd app list                     # List all applications
argocd app get task-app             # Detailed status of an app
argocd app sync task-app            # Manually trigger a sync
argocd app diff task-app            # Show diff between Git and live state
argocd repo list                    # List connected repositories
argocd account update-password      # Change admin password
```

### Port map

| Tunnel | Local (desktop) | Service |
|--------|----------------|---------|
| `argo.pi` | `:8090` | ArgoCD dashboard (`argocd.task.local:8090`) |

---

*Task Manager DevOps Documentation · ArgoCD Section*