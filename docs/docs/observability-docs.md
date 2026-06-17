---
sidebar_position: 6
---

# Observability

**Environment:** Raspberry Pi (local) · **Cluster:** Kind · **Namespace:** `observability` · **Package Manager:** Helmfile

**Reference:** [kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack) · [Prometheus Operator](https://prometheus-operator.dev/) · [Alertmanager](https://prometheus.io/docs/alerting/latest/alertmanager/) · [Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/)

This page covers the running observability stack, how it is defined as code, and — most importantly — the non-obvious gotchas hit while wiring up Slack alerting. It complements the step-by-step guides under **Instructions** ([Observability Setup](./Instructions/06-observability-setup.md), [Grafana Dashboards](./Instructions/07-grafana-dashboards.md), [Alerting Setup](./Instructions/08-alerting-setup.md)); this is the consolidated reference and troubleshooting record.

---

## Table of Contents

1. [How This Works](#1-how-this-works)
2. [The Stack](#2-the-stack)
3. [Deploying with Helmfile](#3-deploying-with-helmfile)
4. [Grafana: Access & Dashboards as Code](#4-grafana-access--dashboards-as-code)
5. [Alerting Model: Two Halves](#5-alerting-model-two-halves)
6. [Alert Rules as Code](#6-alert-rules-as-code)
7. [Alertmanager → Slack](#7-alertmanager--slack)
8. [The Deep-Merge Gotcha](#8-the-deep-merge-gotcha)
9. [Testing Alerts](#9-testing-alerts)
10. [Troubleshooting](#10-troubleshooting)
11. [Quick Reference](#11-quick-reference)

---

## 1. How This Works

The observability stack is **defined as code** in the `observability/` folder and applied with **helmfile**. The intent: *delete the cluster, run one command, get the same stack back.* Git holds **how to rebuild** the stack — not the metrics/logs/traces data inside it.

```
observability/
  ├── helmfile.yaml            ← declares all releases + pinned chart versions
  ├── prometheus-values.yaml   ← kube-prometheus-stack overrides (Grafana, Prometheus, Alertmanager)
  ├── loki-values.yaml         ← Loki overrides
  ├── promtail-values.yaml     ← Promtail overrides
  ├── tempo-values.yaml        ← Tempo overrides
  ├── ingress.yaml             ← ingress for the UIs
  └── alerts/                  ← PrometheusRule CRDs (alert rules as code)
        ├── app-alerts.yaml
        └── infrastructure.yaml
```

**Key principle:** anything created by clicking in a UI (Grafana dashboards, Grafana-managed alerts) lives in an application database — not in git — and is lost on a rebuild. Everything that should survive must be expressed as code.

---

## 2. The Stack

All releases live in the `observability` namespace and are pinned to exact chart versions in `helmfile.yaml`.

| Release    | Chart                                        | Version | Purpose                          |
|------------|----------------------------------------------|---------|----------------------------------|
| prometheus | `prometheus-community/kube-prometheus-stack` | 86.1.0  | Metrics, Grafana, Alertmanager, Prometheus Operator |
| loki       | `grafana/loki`                               | 7.0.0   | Log aggregation                  |
| promtail   | `grafana/promtail`                           | 6.17.1  | Ships pod logs → Loki            |
| tempo      | `grafana/tempo`                              | 1.24.4  | Distributed tracing              |

`kube-prometheus-stack` is the big one — it bundles Prometheus, Grafana, Alertmanager, node-exporter, kube-state-metrics, and the **Prometheus Operator** (which turns CRDs like `PrometheusRule` into live config).

> **Note:** `promtail` declares `needs: observability/loki` in helmfile — Loki must exist before Promtail starts shipping logs to it.

---

## 3. Deploying with Helmfile

All commands run from the `observability/` folder. The `helm-diff` plugin is required for `diff`/`apply`.

```bash
cd observability

helmfile diff      # preview what would change vs the live cluster
helmfile apply     # converge: diff, then upgrade only what changed (idempotent)
helmfile sync      # install/upgrade EVERY release unconditionally (first-time / force)
```

### `apply` vs `sync`

| | `helmfile apply` | `helmfile sync` |
|---|---|---|
| Diff first? | Yes | No |
| Skips unchanged releases? | Yes | No |
| Bumps Helm revision on no-op? | No | Yes |
| Typical use | Routine convergence | Fresh-machine bootstrap / force reconcile |

**Use `apply` day-to-day.** Reach for `sync` only when bootstrapping a new machine or forcing a re-push of state.

> **Note — phantom Grafana diff:** if `grafana.admin` is not pinned, the chart mints a *new random admin password on every render*, and `helmfile diff` shows a perpetual phantom change (the secret + a pod-restart checksum). The fix is to pin the admin credentials to a `Secret` (see below), which also gets you off any default password.

---

## 4. Grafana: Access & Dashboards as Code

### Admin credentials

Grafana's admin login is pinned to a Kubernetes Secret (managed via sealed-secrets, see [Sealed Secrets](./addl/sealed-secrets.md)) rather than a chart-generated password:

```yaml
# prometheus-values.yaml
grafana:
  admin:
    existingSecret: grafana-admin
    userKey: admin-user
    passwordKey: admin-password
```

### ⚠️ Grafana storage is ephemeral

Grafana's database runs on an **`emptyDir` volume** (the chart default). That means **everything created in the Grafana UI — dashboards, UI-managed alerts, users, preferences — is lost on every pod restart**, not just on a cluster rebuild.

This is a deliberate design fork, not a bug:

| Model | Storage | Source of truth | Fits our repo? |
|---|---|---|---|
| **Stateless / as-code** | `emptyDir` | git (provisioned files) | ✅ matches "rebuild from git" |
| **Stateful / UI-driven** | PVC | the running DB | ❌ ties state to one cluster |

We use the **as-code model**, so `emptyDir` is correct — *provided* dashboards are provisioned as code.

### Dashboards as code

`kube-prometheus-stack` runs a **sidecar** (`grafana-sc-dashboard`) that watches the whole cluster for **ConfigMaps labelled `grafana_dashboard=1`** and loads their JSON into Grafana automatically. The GitOps flow:

```
build in UI → export JSON → commit to git → wrap in labelled ConfigMap → apply
                                                      ↑ sidecar auto-loads it, survives restarts
```

A UI-built dashboard is **not** as-code until you export it. To check what is currently provisioned vs UI-only:

```bash
# dashboards provisioned via ConfigMaps (all chart-shipped ones are prefixed prometheus-kube-prometheus-)
kubectl get cm -n observability -l grafana_dashboard=1

# is a given dashboard UI-created (ephemeral) or provisioned? "provisioned": false = at risk
POD=$(kubectl get pod -n observability -l app.kubernetes.io/name=grafana -o jsonpath="{.items[0].metadata.name}")
PW=$(kubectl get secret grafana-admin -n observability -o jsonpath="{.data.admin-password}" | base64 -d)
kubectl exec -n observability $POD -c grafana -- \
  wget -qO- "http://admin:$PW@localhost:3000/api/search?type=dash-db"
```

**For a POC**, the pragmatic minimum is to export the JSON and commit it (manual re-import on rebuild):

```bash
mkdir -p observability/dashboards
POD=$(kubectl get pod -n observability -l app.kubernetes.io/name=grafana -o jsonpath="{.items[0].metadata.name}")
PW=$(kubectl get secret grafana-admin -n observability -o jsonpath="{.data.admin-password}" | base64 -d)
kubectl exec -n observability $POD -c grafana -- \
  wget -qO- "http://admin:$PW@localhost:3000/api/dashboards/uid/<UID>" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['dashboard']; d.pop('id',None); print(json.dumps(d,indent=2))" \
  > observability/dashboards/<name>.json
```

> **Note:** Stripping the top-level `id` is important — it is cluster-local and causes import conflicts on a rebuilt cluster.

---

## 5. Alerting Model: Two Halves

Prometheus alerting is **two independent halves**. Most alerting confusion comes from not knowing which half you are debugging.

| Half | Answers | Lives in |
|------|---------|----------|
| **PrometheusRule** | *"Is something wrong?"* — evaluate PromQL, **fire** an alert | `observability/alerts/*.yaml` (CRDs) |
| **Alertmanager** | *"Now what?"* — **route + deliver** firing alerts | `alertmanager.config` in `prometheus-values.yaml` |

```
PrometheusRule fires → Prometheus evaluates → Alertmanager (routes) → receiver → Slack
   (detection)                                   (delivery)
```

A rule can be firing perfectly while you get **zero** notifications — that's a delivery (Alertmanager) problem, not a rule problem. Always confirm which half is failing before changing anything.

---

## 6. Alert Rules as Code

Alert rules are `PrometheusRule` custom resources — natively as-code, no UI, no ephemeral database. They live in `observability/alerts/` and are applied with `kubectl apply -f observability/alerts/`.

```yaml
# observability/alerts/infrastructure.yaml (excerpt)
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: infrastructure-alerts
  namespace: observability
  labels:
    release: prometheus      # ← the matchmaker, see below
    role: alert-rules
spec:
  groups:
    - name: infrastructure.rules
      rules:
        - alert: HighNodeCPU
          expr: (100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)) > 80
          for: 5m
          labels: { severity: warning }
          annotations:
            summary: "High CPU usage on node"
            description: "CPU usage is {{ $value }}% on node {{ $labels.instance }}"
```

### ⚠️ The `release: prometheus` label is mandatory

The Prometheus Operator only adopts `PrometheusRule` objects whose labels match the Prometheus CR's `ruleSelector`. `kube-prometheus-stack` defaults that selector to **`release: <helm-release-name>`**, and our release is named `prometheus`. A rule with the wrong label (e.g. the `prometheus: kube-prometheus-stack-prometheus` shown in some guides) loads as an object but **never appears in Prometheus**.

Verify the selector and that rules were picked up:

```bash
# what label Prometheus selects rules by
kubectl get prometheus -n observability -o jsonpath='{.items[0].spec.ruleSelector}'; echo

# does the object exist, and did it reach Prometheus?
kubectl get prometheusrules -n observability
curl -s http://obs.task.local:8080/api/v1/rules | jq -r '.data.groups[].name'
```

> **Note:** A rule listed in `get prometheusrules` but **absent** from `:9090/rules` is the definitive sign of a label/selector mismatch.

> **Note — empty vector = no fire:** a Prometheus alert only fires when its expression **returns data**. Rules that depend on metrics that don't exist yet (e.g. `http_requests_total` before the app is scraped) stay silent regardless of the threshold. Node-level rules (`node_exporter` metrics) always have data and can be tested immediately; app-level rules cannot until the app exports metrics.

---

## 7. Alertmanager → Slack

Alertmanager routing lives under `alertmanager.config` in `prometheus-values.yaml` — **not** as a standalone Secret. (The chart owns the Alertmanager config secret; a hand-applied Secret of the same name gets clobbered on the next `helmfile apply`.)

```yaml
# prometheus-values.yaml
alertmanager:
  alertmanagerSpec:
    secrets:
      - alertmanager-slack            # mounts the webhook secret into the pod
  config:
    global:
      slack_api_url_file: /etc/alertmanager/secrets/alertmanager-slack/url
    route:
      receiver: slack
      group_by: ['alertname']
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 1h
      routes:
        - matchers: ['alertname = "Watchdog"']
          receiver: "null"            # silence the always-firing Watchdog
    receivers:
      - name: slack
        slack_configs:
          - channel: '#alerts'
            send_resolved: true
            title: '[{{ .Status | toUpper }}] {{ .CommonLabels.alertname }}'
            text: >-
              {{ range .Alerts }}*{{ .Annotations.summary }}*
              {{ .Annotations.description }}
              _severity:_ {{ .Labels.severity }}
              {{ end }}
      - name: "null"                  # MUST exist — see "The Deep-Merge Gotcha"
```

### The webhook secret

The Slack webhook URL is sensitive, so it is **not** inlined. It lives in a Kubernetes Secret (`alertmanager-slack`, key `url`, managed via [Sealed Secrets](./addl/sealed-secrets.md)), mounted into the pod via `alertmanagerSpec.secrets`, and referenced with `slack_api_url_file`.

```
alertmanager-slack (Secret, key: url)
  └── mounted at /etc/alertmanager/secrets/alertmanager-slack/url
        └── referenced by global.slack_api_url_file
```

---

## 8. The Deep-Merge Gotcha

> This is the single most important lesson from setting up alerting. Budget time for it.

**Symptom:** valid-looking `alertmanager.config`, `helmfile diff` clean, but Slack receives nothing and `config_out` shows the stock default.

**Root cause:** `kube-prometheus-stack` ships a *default* `alertmanager.config` containing a `Watchdog → null` route **and** a `null` receiver. When you supply your own config, **Helm deep-merges** it over the default — and merge semantics differ by type:

- `route` is a **map** → **deep-merged.** Your `receiver: slack` wins, but if you don't set `route.routes`, the default's `Watchdog → null` child route is **inherited**.
- `receivers` is an **array** → **replaced wholesale.** Your `[slack]` **deletes** the default's `[null]`.

Net result: a route that references a `null` receiver which no longer exists → dangling reference. The operator **rejects the entire config atomically** and silently keeps the last-good default:

```
provision alertmanager configuration: failed to initialize from secret:
  undefined receiver "null" used in route
```

**The fix** (already reflected in the config above): take explicit control of `route.routes`, and **define every receiver any route references** — including `null`.

### Why `helmfile diff` was clean — the three-secret pipeline

The rejection happens *one layer below* what helmfile sees. There are **three** secrets, not one:

```
1. SOURCE secret      alertmanager-prometheus-kube-prometheus-alertmanager  (key: alertmanager.yaml)
     └── written by Helm from your alertmanager.config  ← helmfile diff compares THIS
2. Operator validates it →
3. GENERATED secret   alertmanager-...-generated  (key: alertmanager.yaml.gz)  ← what the pod loads
     └── config-reloader writes → /etc/alertmanager/config_out/alertmanager.env.yaml
```

`helmfile diff` only compares Helm's rendered output to the **source** secret. If your YAML is valid, helmfile is happy — but the **operator** can still reject it at step 2, leaving the **generated** secret (and therefore `config_out`) frozen on the old default. So:

> **`helmfile diff` clean ≠ working.** Operator-side validation failures are invisible to helmfile. When `config_out` doesn't match your source secret, **read the operator logs** — they name the exact reason.

---

## 9. Testing Alerts

### The Watchdog (recommended pipeline test)

`kube-prometheus-stack` ships a `Watchdog` alert that is **always firing** by design (a dead-man's-switch). To verify the whole `rule → Alertmanager → Slack` path, temporarily route it to Slack instead of `null`:

```yaml
      routes:
        - matchers: ['alertname = "Watchdog"']
          receiver: slack        # TEST: flip back to "null" once confirmed
```

Apply, then within ~`group_wait` (30s) `[FIRING] Watchdog` should land in `#alerts`. **Switch it back to `receiver: "null"` afterwards** so it doesn't ping the channel hourly forever.

### Throwaway always-firing rule

Tests delivery without depending on any real metric:

```yaml
# observability/alerts/_test-firing.yaml — DELETE after testing, don't commit
- alert: TestAlwaysFiring
  expr: vector(1) > 0          # always true, no metric dependency
  for: 0m
  labels: { severity: warning }
  annotations: { summary: "Pipeline test" }
```

### Reverse the condition (node rules only)

Like Grafana's "reverse the condition" trick — relax the comparator and drop `for:` so a real rule fires on demand:

```yaml
- alert: HighNodeCPU
  expr: ... > 0    # was > 80
  for: 0m          # was 5m
```

Works for **node rules** (always have data). Does **not** work for app rules until the app is exporting metrics (empty vector = no fire).

---

## 10. Troubleshooting

### Decision flow

```
No notifications in Slack?
  │
  ├─ Is the rule firing?           curl .../api/v1/alerts        → no?  → rule/label problem (§6)
  │
  ├─ Is config_out your config?    kubectl exec ... cat config_out → no? → operator rejected it
  │     └─ why?                     kubectl logs <operator> | grep -i error   → names the cause (§8)
  │
  └─ Firing + config correct?      kubectl logs <alertmanager> | grep notify  → delivery error
        └─ channel_not_found / invalid_token → webhook/channel problem
```

### Commands

```bash
# 1. Are alerts firing? (use the API, NOT curling the /alerts page — that's an empty SPA shell)
curl -s http://obs.task.local:8080/api/v1/alerts \
  | jq -r '.data.alerts[] | "\(.labels.alertname)\t\(.state)"' | sort -u

# 2. What config is the Alertmanager pod actually running?
kubectl exec -n observability alertmanager-prometheus-kube-prometheus-alertmanager-0 -c alertmanager \
  -- cat /etc/alertmanager/config_out/alertmanager.env.yaml | grep -iE 'receiver|slack'

# 3. Does the SOURCE secret have your config? (proves Helm/chart did their job)
kubectl get secret alertmanager-prometheus-kube-prometheus-alertmanager -n observability \
  -o go-template='{{ index .data "alertmanager.yaml" | base64decode }}'

# 4. Did the OPERATOR accept it? (this is the gatekeeper; the error here is the answer)
kubectl logs deploy/prometheus-kube-prometheus-operator -n observability --tail=50 \
  | grep -iE 'alertmanager|error|invalid|undefined'

# 5. Did Alertmanager attempt delivery, and did Slack accept it?
kubectl logs statefulset/alertmanager-prometheus-kube-prometheus-alertmanager -n observability \
  | grep -i notify | tail
```

### Common causes seen

| Symptom | Cause | Fix |
|---|---|---|
| `config_out` is the default, operator logs `undefined receiver "null"` | Deep-merge dropped the `null` receiver (§8) | Set `route.routes` explicitly; define `null` receiver |
| Rule in `get prometheusrules` but not at `:9090/rules` | Label doesn't match `ruleSelector` | Use `release: prometheus` |
| `helmfile diff` clean but live config wrong | Operator rejected config below helmfile's view | Read operator logs |
| `connection refused` to `10.96.0.1:443` in operator logs | Transient API-server / control-plane blip (often node CPU saturation) | Check `kubectl top nodes`, node health; usually self-heals |
| Flood of control-plane `TargetDown` / `etcd…Down` / `Kube*InstanceUnreachable` | Kind/kubeadm false positives — those components bind to `127.0.0.1` and can't be scraped | Disable them (below) |
| Chart download fails: `lookup github.com … i/o timeout` | DNS/network blip on the Pi (e.g. Tailscale MagicDNS) | Retry; check `getent hosts github.com`, `tailscale status` |

### Silencing kind control-plane noise

On a kind cluster, the control-plane components aren't scrapeable, producing a flood of false `TargetDown`/`etcd`/`InstanceUnreachable` alerts. For a POC, stop monitoring what can't be scraped:

```yaml
# prometheus-values.yaml
kubeControllerManager: { enabled: false }
kubeScheduler:         { enabled: false }
kubeProxy:             { enabled: false }
kubeEtcd:              { enabled: false }
```

---

## 11. Quick Reference

### Deploy / reproduce

```bash
cd observability
helmfile diff                       # preview
helmfile apply                      # converge (idempotent)
kubectl apply -f alerts/            # PrometheusRule CRDs (not chart-managed)
```

### Health checks

```bash
kubectl get pods -n observability
kubectl get prometheusrules -n observability
curl -s http://obs.task.local:8080/api/v1/alerts | jq -r '.data.alerts[].labels.alertname' | sort -u
kubectl get --raw='/healthz'
```

### The five debug commands

```bash
curl -s http://obs.task.local:8080/api/v1/alerts | jq                                   # 1. firing?
kubectl exec -n observability alertmanager-...-0 -c alertmanager \
  -- cat /etc/alertmanager/config_out/alertmanager.env.yaml                             # 2. live config
kubectl get secret alertmanager-...-alertmanager -n observability \
  -o go-template='{{ index .data "alertmanager.yaml" | base64decode }}'                 # 3. source secret
kubectl logs deploy/prometheus-kube-prometheus-operator -n observability | grep -i err  # 4. operator verdict
kubectl logs statefulset/alertmanager-...-alertmanager -n observability | grep notify   # 5. delivery
```

### Golden rules

1. **Two halves** — rules *fire*, Alertmanager *delivers*. Diagnose the right one.
2. **`helmfile diff` clean ≠ working** — the operator validates one layer deeper; read its logs.
3. **Deep-merge: maps merge, arrays replace.** Override `receivers` → set `route.routes` explicitly and define every referenced receiver.
4. **Three secrets:** source → operator → generated (`config_out`). `config_out` is what's actually running.
5. **`emptyDir` Grafana** — anything built in the UI is ephemeral. If it must survive, express it as code.

---

*Task Manager DevOps Documentation · Observability Section*
