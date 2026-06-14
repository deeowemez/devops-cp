# Observability stack (Prometheus + Loki + Promtail + Tempo)

Version-controlled definition of the observability stack running in the
`observability` namespace. The intent: **delete the cluster, run one command,
get the same stack back.** Git holds *how to rebuild* the stack — not the
metrics/logs/traces data inside it (that's retention/backup, a separate concern).

## Layout

| File                       | What it is                                          |
|----------------------------|-----------------------------------------------------|
| `helmfile.yaml`            | Declares all 4 releases + pinned chart versions     |
| `loki-values.yaml`         | Loki overrides — **captured, complete**             |
| `prometheus-values.yaml`   | Prometheus overrides — **PLACEHOLDER, capture me**  |
| `tempo-values.yaml`        | Tempo overrides — **PLACEHOLDER, capture me**       |
| `promtail-values.yaml`     | Promtail overrides — **PLACEHOLDER, confirm me**    |

Pinned versions (from `helm list -n observability`):

| Release    | Chart                            | Version  | App      |
|------------|----------------------------------|----------|----------|
| prometheus | grafana/kube-prometheus-stack    | 86.1.0   | v0.91.0  |
| loki       | grafana/loki                     | 7.0.0    | 3.6.7    |
| promtail   | grafana/promtail                 | 6.17.1   | 3.5.1    |
| tempo      | grafana/tempo                    | 1.24.4   | 2.9.0    |

## Dependencies

To deploy from this folder you need:

1. **kubectl** — configured to point at the target cluster (`kubectl get nodes` works).
2. **helm** 3.x — https://helm.sh/docs/intro/install/
3. **helmfile** — https://github.com/helmfile/helmfile/releases
   ```bash
   # example (linux/arm64 for the Pi — pick the asset matching your arch)
   curl -L https://github.com/helmfile/helmfile/releases/download/v1.5.3/helmfile_1.5.3_linux_arm64.tar.gz \
     | tar xz helmfile && sudo mv helmfile /usr/local/bin/
   ```
4. **helm-diff plugin** — required by `helmfile apply` / `helmfile diff`
   (not strictly needed for `helmfile sync`, but install it — `apply` is the safer verb):
   ```bash
   helm plugin install https://github.com/databus23/helm-diff
   ```

The `grafana` Helm repo does **not** need to be added manually — `helmfile.yaml`
declares it and helmfile adds/updates it automatically.

## First: finish capturing the placeholders (run on the Pi)

`loki-values.yaml` is done. The other three still hold `{}`. Capture the real
overrides and paste them in below each file's marker line:

```bash
helm get values prometheus -n observability -o yaml
helm get values tempo      -n observability -o yaml
helm get values promtail   -n observability -o yaml
```

A release left as `{}` deploys with **chart defaults** — fine for promtail if it
was never customized, but wrong for prometheus/tempo (revisions 4 and 2 = they
were changed). Don't commit until those two are filled in.

## Deploy / reproduce on another machine

```bash
cd observability

helmfile diff      # preview what would change vs the live cluster (needs helm-diff)
helmfile apply     # converge the cluster to match these files (diff + sync)
# or, first-time / force:
helmfile sync      # install/upgrade every release unconditionally
```

`apply` is idempotent — safe to run repeatedly; it only changes what drifted.

## Secrets

Do **not** commit plaintext secrets. Chart can generate a random password, readable later via
`kubectl get secret prometheus-grafana -n observability -o jsonpath='{.data.admin-password}' | base64 -d`
or move it into a Kubernetes Secret / sealed-secret and reference it from values.

Consider a `.gitignore` / pre-commit check so a password can't be committed by accident.

## What this does NOT capture

- **Grafana dashboards built in the UI** live in Grafana's database, not here.
  Export them (Share -> Export -> Save to file) into a `dashboards/` folder and
  provision them, or they'll be lost on rebuild.
- **The actual metrics/logs/traces data** — that's persistent-volume / retention
  territory, intentionally out of scope for git.
