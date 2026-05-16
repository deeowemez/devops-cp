---
sidebar_position: 4
---

# Sealed Secrets — Encrypted Kubernetes Secrets

**Reference:** [bitnami-labs/sealed-secrets](https://github.com/bitnami-labs/sealed-secrets)

---

## Table of Contents

1. [How This Works](#1-how-this-works)
2. [Install the Controller](#2-install-the-controller)
3. [Install kubeseal CLI](#3-install-kubeseal-cli)
4. [Creating Sealed Secrets](#4-creating-sealed-secrets)
5. [Registry Secret (GitLab Container Registry)](#5-registry-secret-gitlab-container-registry)
6. [Git Secret (Image Updater)](#6-git-secret-image-updater)
7. [Verifying Registry Access](#7-verifying-registry-access)
8. [Quick Reference](#8-quick-reference)

---

## 1. How This Works

Kubernetes Secrets are only base64-encoded, not encrypted. Committing a raw `secret.yaml` to Git exposes credentials in plain text. Sealed Secrets solves this by encrypting secrets with a public key so only the controller running inside the cluster can decrypt them.

```
kubectl create secret ... --dry-run -o yaml > secret.yaml   ← plain secret (never commit)
        │
        ▼
kubeseal < secret.yaml > secret-sealed.yaml                 ← encrypted SealedSecret (safe to commit)
        │
        ▼
kubectl apply -f secret-sealed.yaml                         ← controller decrypts → creates real Secret
```

**Key components:**

| Component | Role |
|-----------|------|
| `sealed-secrets-controller` | Runs in `kube-system`, holds the private key, decrypts SealedSecrets into real Secrets |
| `kubeseal` | CLI tool — encrypts plain Secrets into SealedSecrets using the controller's public key |
| `SealedSecret` | The encrypted object — safe to store in Git |

**Secrets used in this project:**

| Secret name | Namespace | Purpose |
|-------------|-----------|---------|
| `gitlab-registry-secret` | `task-app` | Pulls private images from GitLab Container Registry |
| `image-updater-git` | `argocd` | Allows ArgoCD Image Updater to write back to the Git repo |

---

## 2. Install the Controller

The controller runs in `kube-system` and is installed once per cluster.

```bash
kubectl apply -f https://github.com/bitnami-labs/sealed-secrets/releases/latest/download/controller.yaml

# Verify the controller is running
kubectl get deployment -n kube-system | grep sealed-secrets
```

> **Note:** The controller generates a public/private key pair on first start and stores the private key as a Secret in `kube-system`. All `kubeseal` encryption uses the public key from this controller. If the controller is deleted and recreated, it generates a new key pair and existing SealedSecrets can no longer be decrypted — back up the key if needed.

---

## 3. Install kubeseal CLI

`kubeseal` is the client-side tool that encrypts plain Secrets. Install it on the Raspberry Pi.

### Option A — apt (simplest)

```bash
sudo apt install kubeseal
```

### Option B — build from source

Use this if the apt package is outdated or unavailable for ARM64.

```bash
sudo apt update && sudo apt install golang git

git clone https://github.com/bitnami-labs/sealed-secrets.git
cd sealed-secrets
go build ./cmd/kubeseal
sudo mv kubeseal /usr/local/bin/
```

### Verify

```bash
kubeseal --version
```

---

## 4. Creating Sealed Secrets

The general workflow is the same for every secret:

```bash
# Step 1 — generate the plain Secret (dry-run, never applied directly)
kubectl create secret <type> <name> \
  <flags> \
  --dry-run=client -o yaml > secret.yaml

# Step 2 — encrypt it into a SealedSecret
kubeseal --format yaml < secret.yaml > secret-sealed.yaml

# Step 3 — apply the SealedSecret to the cluster
kubectl apply -f secret-sealed.yaml

# Step 4 — commit secret-sealed.yaml to Git, delete secret.yaml
```

> **Note:** Never commit the plain `secret.yaml` to Git. Only `secret-sealed.yaml` is safe to commit. Add `*secret.yaml` (but not `*sealed.yaml`) to `.gitignore` as a safeguard.

---

## 5. Registry Secret (GitLab Container Registry)

This secret allows Kubernetes to pull private images from `registry.gitlab.com`. It is needed in the `task-app` namespace so deployments can pull `frontend` and `backend` images.

### 5.1 Generate the plain secret

```bash
kubectl create secret docker-registry gitlab-registry-secret \
  --docker-server=registry.gitlab.com \
  --docker-username=<your-gitlab-username> \
  --docker-password=<your-access-token> \
  --docker-email=<your-email> \
  --namespace task-app \
  --dry-run=client -o yaml > registry-secret.yaml
```

This produces a `kubernetes.io/dockerconfigjson` secret. The structure of the `.dockerconfigjson` it generates looks like:

```json
{
  "auths": {
    "registry.gitlab.com": {
      "username": "<your-gitlab-username>",
      "password": "<your-access-token>",
      "email": "<your-email>",
      "auth": "<base64(username:token)>"
    }
  }
}
```

### 5.2 Seal the secret

```bash
kubeseal --format yaml < registry-secret.yaml > registry-secret-sealed.yaml
```

### 5.3 Apply the SealedSecret

```bash
kubectl apply -f registry-secret-sealed.yaml
```

The controller decrypts it and creates the real `gitlab-registry-secret` Secret in the `task-app` namespace automatically.

### 5.4 Reference the secret in a Deployment or Helm values

```yaml
imagePullSecrets:
  - name: gitlab-registry-secret
```

---

## 6. Git Secret (Image Updater)

ArgoCD Image Updater needs credentials to write updated image tags back to the GitLab repo. This secret lives in the `argocd` namespace.

### 6.1 Generate the plain secret

```bash
kubectl create secret generic image-updater-git \
  --namespace argocd \
  --from-literal=username=<your-gitlab-username> \
  --from-literal=password=<your-access-token> \
  --dry-run=client -o yaml > git-secret.yaml
```

### 6.2 Seal the secret

The controller namespace must be specified explicitly here because the secret targets the `argocd` namespace, not the default.

```bash
kubeseal \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=kube-system \
  --format yaml < git-secret.yaml > git-secret-sealed.yaml
```

### 6.3 Apply the SealedSecret

```bash
kubectl apply -f git-secret-sealed.yaml
```

> **Note:** The `--controller-namespace` flag tells `kubeseal` which controller to fetch the public key from. If omitted, `kubeseal` defaults to `kube-system`, which is correct here. Specify it explicitly to avoid ambiguity.

---

## 7. Verifying Registry Access

Before relying on `imagePullSecrets` in production deployments, verify the secret works by running a temporary test pod that pulls a private image.

### 7.1 Test pod manifest

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: test-gitlab
  namespace: task-app
spec:
  containers:
  - name: test-container
    image: registry.gitlab.com/deeowemez/task-app/backend:7e7710c6
    command: ["sleep", "3600"]   # keep the pod alive for inspection
  imagePullSecrets:
  - name: gitlab-registry-secret
  restartPolicy: Never
```

```bash
kubectl apply -f test-pod.yaml

# Watch the pod status — it should reach Running, not ImagePullBackOff
kubectl get pod test-gitlab -n task-app -w
```

If the pod reaches `Running`, the secret is working. Clean up after:

```bash
kubectl delete pod test-gitlab -n task-app
```

### 7.2 Inspect an image without pulling it

Useful for confirming a tag exists in the registry before deploying:

```bash
docker manifest inspect registry.gitlab.com/deeowemez/task-app/backend:7e7710c6
```

### 7.3 Common failure — ImagePullBackOff

```bash
# Check the exact error
kubectl describe pod test-gitlab -n task-app
```

Common causes:

| Symptom | Cause |
|---------|-------|
| `unauthorized` | Wrong username or token, or token lacks `read_registry` scope |
| `not found` | Image tag does not exist in the registry |
| `secret not found` | SealedSecret not applied, or controller hasn't decrypted it yet |

---

## 8. Quick Reference

### Seal any secret

```bash
kubeseal --format yaml < secret.yaml > secret-sealed.yaml
kubectl apply -f secret-sealed.yaml
```

### Check what the controller decrypted

```bash
# List all real Secrets in task-app (created by the controller)
kubectl get secrets -n task-app

# List in argocd namespace
kubectl get secrets -n argocd
```

### Check controller logs

```bash
kubectl logs -n kube-system -l app.kubernetes.io/name=sealed-secrets -f
```

### .gitignore recommendation

```gitignore
# Plain secrets — never commit
*secret.yaml
*secrets.yaml

# Sealed secrets are safe to commit
!*sealed.yaml
```

---

*Task Manager DevOps Documentation · Sealed Secrets Section*
