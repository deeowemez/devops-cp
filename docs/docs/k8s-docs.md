---
sidebar_position: 2
---

# Kubernetes Deployment Documentation

**Environment:** Raspberry Pi (local) · **Cluster:** Kind · **Package Manager:** Helm

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Prerequisites](#3-prerequisites)
4. [Creating the Kind Cluster](#4-creating-the-kind-cluster)
5. [Namespace Setup](#5-namespace-setup)
6. [Loading Local Docker Images into Kind](#6-loading-local-docker-images-into-kind)
7. [Database Initialization](#7-database-initialization)
8. [Helm Deployment](#8-helm-deployment)
9. [Operations Quick Reference](#9-operations-quick-reference)
10. [Troubleshooting](#10-troubleshooting)
11. [Full Recreation Checklist](#11-full-recreation-checklist)

---

## 1. Project Overview

The Task Manager app runs on a local Kubernetes cluster provisioned with Kind (Kubernetes in Docker) on a Raspberry Pi. The stack has three components — a frontend web app, a backend API, and a PostgreSQL database — all managed by Helm inside the `task-app` namespace.

| Component | Details |
|-----------|---------|
| Cluster tool | Kind (Kubernetes in Docker) |
| Package manager | Helm |
| Namespace | `task-app` |
| Frontend | `app-frontend:latest` — ClusterIP `:8080` |
| Backend | `app-backend:latest` — ClusterIP `:3000` |
| Database | PostgreSQL — ClusterIP `:5432` |
| Ingress | ingress-nginx controller |
| GitOps | ArgoCD (documented separately) |

---

## 2. Architecture

All application workloads live in the `task-app` namespace. Ingress-nginx handles external HTTP routing. The frontend communicates with the backend internally, and the backend connects to PostgreSQL.

### Traffic flow

```
External request (:80 / :443)
  └── ingress-nginx controller          [namespace: ingress-nginx]
        └── Ingress resource            [namespace: task-app]
              └── svc/frontend :8080
                    └── frontend pod
                          └── svc/backend :3000
                                └── backend pod
                                      └── svc/db :5432
                                            └── postgres pod
```

### Namespaces

| Namespace | Purpose |
|-----------|---------|
| `ingress-nginx` | Nginx ingress controller |
| `task-app` | All app workloads — frontend, backend, db, Helm release |
| `argocd` | GitOps controller (separate documentation) |
| `kube-system` | Core cluster components |

### Current running resources (`task-app`)

```
NAME                                     READY   STATUS    RESTARTS
pod/task-app-backend-8f87d7bf8-p84v4     1/1     Running   5
pod/task-app-db-749f67698f-qbltf         1/1     Running   5
pod/task-app-frontend-7c9bdd5695-45dw5   1/1     Running   1

NAME               TYPE        CLUSTER-IP      PORT(S)
service/backend    ClusterIP   10.96.155.162   3000/TCP
service/db         ClusterIP   10.96.105.23    5432/TCP
service/frontend   ClusterIP   10.96.171.58    8080/TCP

NAME                                READY   UP-TO-DATE   AVAILABLE
deployment.apps/task-app-backend    1/1     1            1
deployment.apps/task-app-db         1/1     1            1
deployment.apps/task-app-frontend   1/1     1            1
```

---

## 3. Prerequisites

Install the following tools before running any setup commands.

| Tool | Purpose |
|------|---------|
| `docker` | Container runtime — Kind runs K8s nodes as Docker containers |
| `kind` | Kubernetes in Docker — creates local clusters |
| `kubectl` | Kubernetes CLI |
| `helm` | Kubernetes package manager — manages the app release |
| `kubens` / `kubectx` | Fast namespace and context switching (optional but recommended) |

---

## 4. Creating the Kind Cluster

### 4.1 Cluster configuration file

Kind clusters are configured with a YAML file. The config for this project lives at:

```
~/repos/devops-tuto/app/kind-config.yaml
```

This file defines the cluster name, node roles, and port mappings for ingress (port 80 and 443 on the host).

### 4.2 Create the cluster

```bash
# Linux / macOS
kind create cluster --name task-manager --config ~/repos/devops-tuto/app/kind-config.yaml

# Windows
kind create cluster --name task-manager --config "C:\Users\Admin\repos\devops-tuto\app\kind-config.yaml"
```

### 4.3 Install ingress-nginx

Kind does not include an ingress controller by default. Install the official ingress-nginx manifest for Kind:

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml

# Wait for the controller pod to be ready (up to 120s)
kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=120s

# Verify
kubectl get pods -n ingress-nginx
```

> **Note:** The ingress controller must be ready before applying application manifests, otherwise ingress rules will not be processed.

---

## 5. Namespace Setup

All application resources live in the `task-app` namespace. Apply the namespace manifest first, then switch to it.

```bash
# Apply the namespace manifest
kubectl apply -f ../ns-ta.yaml

# Switch to the namespace (with kubens)
kubens task-app

# Or without kubens
kubectl config set-context --current --namespace=task-app
```

---

## 6. Loading Local Docker Images into Kind

Kind nodes are isolated containers and cannot access the host Docker daemon directly. Local images must be explicitly loaded into the cluster before deployments can pull them.

```bash
kind load docker-image app-frontend:latest --name task-manager
kind load docker-image app-backend:latest  --name task-manager
```

> **Note:** Re-run these commands every time you rebuild an image locally. The cluster caches the image by tag — rebuilding the same tag requires reloading and restarting the relevant pods.

### Verify images are loaded inside the cluster node

```bash
docker exec -it task-manager-control-plane crictl images
```

### Restart pods to pick up a reloaded image

```bash
kubectl rollout restart deployment frontend -n task-app
kubectl rollout restart deployment backend  -n task-app
```

---

## 7. Database Initialization

The PostgreSQL database is initialized using a SQL script mounted as a ConfigMap.

### 7.1 Generate the ConfigMap YAML

```bash
# Generate and save to file (recommended — keeps it in version control)
kubectl create configmap db-config \
  --from-file=../database/init.sql \
  --dry-run=client -o yaml > db-config.yaml

# Or apply directly without saving
kubectl create configmap db-config --from-file=../database/init.sql
```

### 7.2 Apply the ConfigMap

```bash
kubectl apply -f db-config.yaml
```

> **Note:** When using Helm, the ConfigMap is typically defined in the chart templates and applied automatically on `helm install`. Manual creation is only needed for raw `kubectl` workflows.

---

## 8. Helm Deployment

The application is packaged as a Helm chart. Helm manages all Kubernetes resources (Deployments, Services, Ingress, ConfigMaps) as a single versioned release named `my-release`.

### 8.1 Install the release

```bash
# Install into the task-app namespace
helm install my-release . -n task-app

# Verify the release
helm list -n task-app
```

### 8.2 Upgrade after changes

```bash
# Apply chart changes
helm upgrade my-release . -n task-app

# Preview what will change before upgrading (requires helm-diff plugin)
helm diff upgrade my-release . -n task-app
```

### 8.3 Uninstall

```bash
helm uninstall my-release -n task-app
```

### 8.4 Helm Diff plugin

The `helm-diff` plugin shows a diff of what will change before upgrading — useful for reviewing changes safely.

```bash
# Install
helm plugin install https://github.com/databus23/helm-diff

# List installed plugins
helm plugin list
```

---

## 9. Operations Quick Reference

### 9.1 Cluster health

```bash
kubectl get all                     # All resources in current namespace
kubectl get pods -n ingress-nginx   # Check ingress controller
kubectl get all -n task-app         # All resources in task-app
kubectl describe pod <pod-name>     # Detailed info for a specific pod
helm list -n task-app               # Helm release status
```

### 9.2 Logs

```bash
# Stream logs from all pods under a deployment
kubectl logs deployment/backend  -f
kubectl logs deployment/frontend -f
```

### 9.3 Port forwarding

Access services locally without going through ingress:

```bash
kubectl port-forward svc/frontend 8080:8080   # localhost:8080
kubectl port-forward svc/backend  3000:3000   # localhost:3000
kubectl port-forward svc/db       5432:5432   # localhost:5432
```

### 9.4 Image management

```bash
# Load a local image into the cluster
kind load docker-image <image>:<tag> --name task-manager

# List images inside the cluster node
docker exec -it task-manager-control-plane crictl images

# Restart a deployment to pull the newly loaded image
kubectl rollout restart deployment/<name> -n task-app
```

### 9.5 Namespace switching

```bash
kubens task-app                                          # with kubens
kubectl config set-context --current --namespace=task-app  # without kubens
```

---

## 10. Troubleshooting

### 10.1 Shell into a running pod

```bash
# Open an interactive shell
kubectl exec -it pod/<pod-name> -- sh

# Example: inspect the database tables
kubectl exec -it pod/db-749f67698f-cl84k -- sh
# Inside the pod:
psql -U postgres -d taskdb -c "\dt"
```

### 10.2 Common issues

| Symptom | Likely cause and fix |
|---------|---------------------|
| `ImagePullBackOff` | Image not loaded into Kind — run `kind load docker-image` |
| `CrashLoopBackOff` | Check pod logs (`kubectl logs <pod>`) for startup errors |
| Ingress not routing | Ensure ingress-nginx controller is Ready and IngressClass is set correctly |
| DB connection refused | Verify `svc/db` ClusterIP and that the `db-config` ConfigMap is applied |
| Helm release failed | Run `helm uninstall` then re-install; check `values.yaml` for misconfigurations |
| Changes not reflected | Rebuild image → `kind load` → `kubectl rollout restart` |

---

## 11. Full Recreation Checklist

Follow these steps in order to recreate the cluster from scratch.

- [ ] Build Docker images locally (`docker build -t app-frontend:latest .` etc.)
- [ ] Create Kind cluster with config file (`kind create cluster --name task-manager --config ...`)
- [ ] Install ingress-nginx and wait for the controller pod to reach `Ready`
- [ ] Apply the namespace manifest (`kubectl apply -f ns-ta.yaml`)
- [ ] Switch to `task-app` namespace (`kubens task-app`)
- [ ] Load images into Kind (`kind load docker-image` for frontend and backend)
- [ ] Install Helm release (`helm install my-release . -n task-app`)
- [ ] Verify all pods are `Running` (`kubectl get all`)

> ArgoCD setup and GitOps workflow are covered in a separate document.

---

*Task Manager DevOps Documentation · Kubernetes Section · ArgoCD covered separately*
