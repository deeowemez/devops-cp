---
sidebar_position: 4
---

# GitLab CI

### Continuous Integration Pipeline

---

## Table of Contents

1. [How This Works](#1-how-this-works)
2. [Pipeline Stages](#2-pipeline-stages)
3. [Variables](#3-variables)
4. [Shared Configuration — `.default-docker`](#4-shared-configuration--default-docker)
5. [Build Jobs](#5-build-jobs)
6. [Update Helm Jobs](#6-update-helm-jobs)
7. [CI/CD Variables Setup](#7-cicd-variables-setup)
8. [Full Pipeline Flow](#8-full-pipeline-flow)

---

## 1. How This Works

The pipeline automates two things: building Docker images and updating the Helm chart so ArgoCD picks up the change.

```
Developer pushes to main
  └── GitLab CI detects changed files
        ├── changed app/frontend/** → build-frontend → update-helm-frontend
        └── changed app/backend/**  → build-backend  → update-helm-backend
              │
              ▼
        Docker image built for linux/arm64
        Tagged with the commit short SHA (e.g. 7e7710c)
        Pushed to GitLab Container Registry
              │
              ▼
        CI Bot updates fe_tag / be_tag in app/helm/values.yaml
        Commits and pushes back to main
              │
              ▼
        ArgoCD detects the values.yaml change
        Syncs the cluster → rolling update
```

This is a **GitOps push model**: the pipeline never touches the cluster directly. It only updates Git, and ArgoCD handles the actual deployment.

---

## 2. Pipeline Stages

```yaml
stages:
  - build
  - update-helm
```

Stages run sequentially. All `build` jobs run first (and can run in parallel with each other), then all `update-helm` jobs run after every build job in the prior stage has succeeded.

| Stage | Jobs | Purpose |
|-------|------|---------|
| `build` | `build-frontend`, `build-backend` | Build and push ARM64 Docker images |
| `update-helm` | `update-helm-frontend`, `update-helm-backend` | Update image tags in `values.yaml` and push back to Git |

---

## 3. Variables

```yaml
variables:
  DOCKER_TLS_CERTDIR: ""
  FRONTEND_IMAGE: $CI_REGISTRY_IMAGE/frontend:$CI_COMMIT_SHORT_SHA
  BACKEND_IMAGE: $CI_REGISTRY_IMAGE/backend:$CI_COMMIT_SHORT_SHA
```

| Variable | Value | Meaning |
|----------|-------|---------|
| `DOCKER_TLS_CERTDIR` | `""` | Disables TLS for the Docker-in-Docker service. Required for `docker:dind` to work without certificate setup |
| `FRONTEND_IMAGE` | `registry.gitlab.com/deeowemez/task-app/frontend:7e7710c` | Full image reference for the frontend, tagged with the short commit SHA |
| `BACKEND_IMAGE` | `registry.gitlab.com/deeowemez/task-app/backend:7e7710c` | Full image reference for the backend |

**GitLab predefined variables used:**

| Variable | Example value | Source |
|----------|--------------|--------|
| `$CI_REGISTRY_IMAGE` | `registry.gitlab.com/deeowemez/task-app` | GitLab — the registry path for this project |
| `$CI_COMMIT_SHORT_SHA` | `7e7710c` | GitLab — first 7 characters of the commit hash |
| `$CI_REGISTRY` | `registry.gitlab.com` | GitLab — the registry hostname |
| `$CI_REGISTRY_USER` | `gitlab-ci-token` | GitLab — ephemeral token username for registry auth |
| `$CI_REGISTRY_PASSWORD` | `<token>` | GitLab — ephemeral token password for registry auth |
| `$CI_COMMIT_BRANCH` | `main` | GitLab — the branch that triggered the pipeline |

> **Note:** Using the commit short SHA as the image tag means every build produces a uniquely tagged image. This is intentional — it makes rollbacks trivial (just point to an older SHA tag) and avoids the `latest` tag problem where you can't tell which version is actually running.

---

## 4. Shared Configuration — `.default-docker`

```yaml
.default-docker:
  image: docker:24
  services:
    - docker:24-dind
  before_script:
    - docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"
    - docker buildx create --use
```

This is a [YAML anchor / extends template](https://docs.gitlab.com/ee/ci/yaml/#extends). The leading `.` tells GitLab it is not a real job — it is a reusable block. Both build jobs inherit it via `extends: .default-docker`.

| Part | Purpose |
|------|---------|
| `image: docker:24` | The CI runner uses a Docker image that has the Docker CLI installed |
| `services: docker:24-dind` | Starts a Docker-in-Docker sidecar so the runner can actually build and push images |
| `docker login` | Authenticates to the GitLab registry using GitLab's ephemeral CI credentials |
| `docker buildx create --use` | Initialises Docker Buildx, which is required for cross-platform (`--platform`) builds |

> **Note:** Docker-in-Docker (dind) runs a full Docker daemon inside the CI container. It is needed because the runner itself is a container and doesn't have access to a host Docker socket. `DOCKER_TLS_CERTDIR: ""` disables the TLS handshake that dind requires by default, which simplifies the setup at the cost of encryption inside the CI network (acceptable for a local/internal setup).

---

## 5. Build Jobs

Both jobs follow the same structure. They only run on `main` when specific paths change.

### build-frontend

```yaml
build-frontend:
  stage: build
  extends: .default-docker
  script:
    - docker buildx build --no-cache --platform linux/arm64 -t $FRONTEND_IMAGE ./app/frontend --push
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
      changes:
        - app/frontend/**/*
```

### build-backend

```yaml
build-backend:
  stage: build
  extends: .default-docker
  script:
    - docker buildx build --platform linux/arm64 -t $BACKEND_IMAGE ./app/backend --push
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
      changes:
        - app/backend/**/*
```

### Build flags explained

| Flag | Purpose |
|------|---------|
| `--platform linux/arm64` | Builds the image for ARM64, which is the Raspberry Pi's architecture. Without this, the default `amd64` image would fail to run on the Pi |
| `--no-cache` | Forces a full rebuild on every run (frontend only). Ensures no stale layers are used — useful when the build context changes frequently |
| `--push` | Pushes directly to the registry after building, without needing a separate `docker push` step |
| `-t $FRONTEND_IMAGE` | Tags the image with the full registry path and commit SHA |

> **Note:** `--no-cache` is only on the frontend job. This is a deliberate choice — if the backend dependencies rarely change, allowing cache speeds up builds significantly. The frontend, being more frequently updated, benefits from always building fresh.

### Rules — path-based triggers

```yaml
rules:
  - if: '$CI_COMMIT_BRANCH == "main"'
    changes:
      - app/frontend/**/*
```

This job only runs when both conditions are true: the commit is on `main` **and** at least one file under `app/frontend/` changed. If you push a backend change only, the frontend job is skipped entirely. This keeps the pipeline fast and avoids unnecessary image builds.

---

## 6. Update Helm Jobs

After an image is built and pushed, the corresponding Helm job updates `values.yaml` with the new image tag and pushes the change back to Git. ArgoCD then detects the commit and syncs the cluster.

### update-helm-frontend

```yaml
update-helm-frontend:
  stage: update-helm
  image: bitnami/git:latest
  script:
    - git config --global user.email "ci-bot@example.com"
    - git config --global user.name "CI Bot"
    - git remote set-url origin https://$CI_USERNAME:$CI_PASSWORD@gitlab.com/deeowemez/task-app.git
    - git checkout main
    - sed -i "s|^\(\s*fe_tag:\s*\).*|\1$CI_COMMIT_SHORT_SHA|" app/helm/values.yaml
    - git add app/helm/values.yaml
    - git commit -m "Update frontend image"
    - git push origin main
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
      changes:
        - app/frontend/**/*
```

### What each script line does

| Line | Purpose |
|------|---------|
| `git config user.email / user.name` | Sets the identity for the commit. GitLab requires a name and email to create a commit |
| `git remote set-url origin https://...` | Injects `$CI_USERNAME` and `$CI_PASSWORD` into the remote URL so the push is authenticated. These are custom CI variables, not GitLab's built-in ones |
| `git checkout main` | Ensures the job is on the `main` branch before making changes |
| `sed -i "s|..."` | Finds the `fe_tag:` line in `values.yaml` and replaces the value with the current commit SHA. See below for a breakdown |
| `git add / commit / push` | Commits the updated `values.yaml` and pushes back to `main` |

### The `sed` command broken down

```bash
sed -i "s|^\(\s*fe_tag:\s*\).*|\1$CI_COMMIT_SHORT_SHA|" app/helm/values.yaml
```

| Part | Meaning |
|------|---------|
| `-i` | Edit the file in place |
| `s|...|...|` | Substitute pattern with replacement |
| `^\(\s*fe_tag:\s*\)` | Match the start of a line, capture any indentation + `fe_tag:` + trailing space |
| `.*` | Match the rest of the line (the old tag value) |
| `\1$CI_COMMIT_SHORT_SHA` | Replace with the captured group (preserving indentation) + the new SHA |

In practice this turns a line like:

```yaml
  fe_tag: a1b2c3d
```

into:

```yaml
  fe_tag: 7e7710c
```

> **Note:** `$CI_USERNAME` and `$CI_PASSWORD` in the `git remote set-url` line are **custom variables** you define in GitLab under **Settings → CI/CD → Variables**. They are not the same as `$CI_REGISTRY_USER` / `$CI_REGISTRY_PASSWORD`, which are only scoped for registry access. The Git push requires a Personal Access Token with `write_repository` scope.

---

## 7. CI/CD Variables Setup

Go to **GitLab → Project → Settings → CI/CD → Variables** and add:

| Variable | Value | Notes |
|----------|-------|-------|
| `CI_USERNAME` | Your GitLab username | Used for git push authentication |
| `CI_PASSWORD` | A Personal Access Token | Must have `write_repository` scope. Mark as **Masked** |

GitLab's built-in variables (`CI_REGISTRY_USER`, `CI_REGISTRY_PASSWORD`, `CI_REGISTRY`, `CI_REGISTRY_IMAGE`, `CI_COMMIT_SHORT_SHA`, `CI_COMMIT_BRANCH`) are available automatically — no setup needed.

> **Note:** Always mark sensitive variables (tokens, passwords) as **Masked** in GitLab so they are redacted from job logs. Mark them as **Protected** if you only want them available on protected branches like `main`.

---

## 8. Full Pipeline Flow

```
git push → main (frontend file changed)
  │
  ├── [stage: build]
  │     └── build-frontend
  │           ├── docker login to registry.gitlab.com
  │           ├── docker buildx create --use
  │           └── docker buildx build --platform linux/arm64 ... --push
  │                 └── image pushed: registry.gitlab.com/.../frontend:7e7710c
  │
  └── [stage: update-helm]
        └── update-helm-frontend
              ├── git checkout main
              ├── sed replaces fe_tag: → 7e7710c in values.yaml
              └── git push → main
                    │
                    ▼
              ArgoCD detects values.yaml changed
                    │
                    ▼
              ArgoCD syncs → helm upgrade
                    │
                    ▼
              Rolling update: frontend pod pulls new image
```

---

*Task Manager DevOps Documentation · GitLab CI Section*
