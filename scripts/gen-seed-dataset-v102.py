#!/usr/bin/env python3
"""
NexTool v1.0.11 — seed dataset v1.0.2 generator (spec §44-§56).

Deterministic generator producing config/training/seed-dataset-v1.0.2.json:
- large Markdown-heavy task descriptions (§46) with the actionable objective
  at the BEGINNING, MIDDLE and END of the document (§47)
- more operational knowledge across NexTool's real domain (§48)
- hard examples: typos, synonyms, ambiguous wording, similar tools, same
  keywords with different intent, irrelevant context, failed previous
  attempts, state-after-action, conditional requirements (§49)
- pattern-aware recovery/verification/state-transition examples (§55)
- all 15 registered tools present in train AND test splits
- zero duplicate requests (deduped deterministically)
"""
import json, itertools, re

SERVERS = ["api-01", "api-02", "web-01", "web-02", "db-01"]
EXAMPLES = []

def add(category, request, tool, params=None, split=None):
    EXAMPLES.append({
        "category": category,
        "request": request,
        "expectedTool": tool,
        **({"expectedParams": params} if params is not None else {}),
        **({"split": split} if split else {}),
    })

# ---------- §46/§47: long Markdown templates ----------
def md_runbook(server):
    return f"""# Operational Runbook — Weekly Fleet Maintenance

## Scope
This runbook covers the Tuesday maintenance window for the virtual server
fleet managed by the NexTool runtime.

## Preconditions
1. On-call engineer acknowledged the page.
2. Change ticket CHG-4711 is in state "approved".
3. The maintenance window is 02:00-04:00 UTC.

## Preparation checklist
- [x] Snapshot the configuration directory
- [x] Notify stakeholders in the ops channel
- [ ] Drain traffic from the target node

## Maintenance procedure
| Step | Action        | Expected result          |
|------|---------------|--------------------------|
| 1    | drain traffic | load balancer weight = 0 |
| 2    | stop service  | exit code 0              |
| 3    | patch binary  | checksum matches         |
| 4    | start service | systemd active (running) |
| 5    | verify        | health probe returns ok  |

## Notes
- Rollback is manual; keep the previous binary for 48h.
- Escalate to the platform team if step 3 fails twice.

## Instruction for the runtime
Check the current health status of {server} now, before we start the window."""
def md_api_docs():
    return """# Internal Fleet API — Reference (excerpt)

## Endpoint: GET /v1/servers
Returns the fleet inventory.

```json
{ "servers": [ { "id": "api-01", "region": "blr-1" } ] }
```

## Endpoint: POST /v1/servers/{id}/restart
Schedules an asynchronous restart. Accepts query parameter `drain=true|false`.

## Rate limits
Requests are limited to 60/min per token.

## Runtime instruction (act on this)
Give me the current time in Asia/Kolkata."""
def md_incident(server):
    return f"""**INCIDENT REPORT — SEV-2 — ACTION REQUIRED FIRST**

At 03:12 UTC monitoring flagged repeated 5xx from the checkout path. The
timeline below is copied from the incident channel; the actionable request
for the runtime is the FIRST line of this document.

Requested action: list all servers in the environment with their health so
the incident commander can see the blast radius.

---
### Timeline
- 03:12 pager fired (checkout error budget burn)
- 03:14 deploy 4f2c1e suspected
- 03:15 cache flush attempted, no improvement
- 03:19 incident commander joined
- 03:21 status page updated to "degraded"

### Suspected factors
1. New deployment 4f2c1e (checkout service)
2. Cache node memory pressure
3. Upstream payment provider latency

### Error sample
```
CheckoutError: upstream timeout after 5000ms (attempt 2/3)
```
---"""
def md_checklist():
    return """# Release checklist — web console v2.4

1. Unit tests green
2. Lint clean
3. `npm run build` succeeds
4. Smoke test on staging
5. Changelog updated

Everything above is already done. What is the current host system
information of the machine running the runtime (platform, CPUs, memory)?"""
def md_config():
    return """# fleet.yaml (current configuration)

```yaml
fleet:
  region: blr-1
  nodes:
    - id: api-01
      role: api
      replicas: 3
    - id: db-01
      role: database
      replicas: 1
  alerts:
    cpu_threshold_pct: 90
    mem_threshold_pct: 85
    notify_level: warning
```

The configuration is loaded at boot. For the audit trail, store the alert
threshold block in persistent memory under the key `fleet-alert-thresholds`
with tags `audit` and `config`."""
def md_log_analysis():
    return """Captured access log tail (last hour, truncated to the interesting rows):

```
10.0.0.4 - - [09/Oct/2025:10:01:02] "GET /healthz" 200 2
10.0.0.7 - - [09/Oct/2025:10:01:05] "GET /api/cart" 500 1213
10.0.0.4 - - [09/Oct/2025:10:01:09] "GET /healthz" 200 2
10.0.0.9 - - [09/Oct/2025:10:01:14] "POST /api/checkout" 500 981
```

Two 5xx rows appear in the tail. For the incident notes I need the text
statistics (character, word and sentence counts) of this line:

CheckoutError: upstream timeout after 5000ms (attempt 2/3)"""
def md_table(server):
    return f"""## Maintenance window — node assignment

| Window (UTC) | Node       | Engineer |
|--------------|------------|----------|
| 02:00-02:30  | api-01     | A. Karim |
| 02:30-03:00  | web-01     | S. Nair  |
| 03:00-03:30  | db-01      | A. Karim |

During the {server} slot the engineer must verify the node recovered cleanly
after the earlier patch. Perform that verification now: check {server}'s
health status."""
def md_code():
    return """```js
// deploy/verify.js
import { execSync } from "node:child_process";

export function verifyDeploy(host) {
  const out = execSync(`curl -fsS https://${host}/healthz`).toString();
  return out.includes("ok");
}
```

The snippet above is part of the deploy tooling docs. In the description of
the release ticket, generate a fresh unique identifier (a single UUID) for
the audit reference field."""
def md_nested(server):
    return f"""# Change request CHG-4712

## Metadata
- requester: platform-oncall
- risk: low
- affected: {server}

## Description
Roll the node into the current release channel. The runbook is linked in the
references section; the health probe is expected to be green within 3
seconds of the service coming back up.

## Request
At the end of this document: restart {server} in the virtual environment so
the change can be executed and observed.

## References
- Runbook: RUN-118
- Previous change: CHG-4709 (reverted)"""
def md_middle(server):
    return f"""# Weekly operations digest

Section 1 — Deploys: three services shipped, zero rollbacks.

Section 2 — Capacity: headroom is stable across the fleet.

Section 3 — Follow-ups (actionable): the digest closes with the one
operation the runtime should perform today — check the health of {server}
and report the observed CPU and memory numbers."""

def md_block(server, tool, params, split=None):
    """Long-form Markdown examples with objective at beginning/middle/end."""
    add("markdown-long", md_runbook(server), tool, params, split)
    add("markdown-long", md_incident(server), "server.list" if tool == "server.health" else tool, params, split)
    add("markdown-long", md_middle(server), tool, params, split)

def md_mega(server):
    """A genuinely LARGE multi-section operational document (§45/§46)."""
    return f"""# Platform Operations — Quarterly Maintenance Pack (Q4)

You are handed the consolidated maintenance pack for the quarter. Read the
whole document; the single operation the runtime must perform is stated at
the very end.

## 1. Context

The virtual fleet is spread across one region (blr-1) and consists of API
front-ends, web front-ends and a database node. Health probing happens every
30 seconds; the maintenance windows are booked through the change system.

## 2. Change summary

| Change  | Node   | Type       | Risk | Outcome   |
|---------|--------|------------|------|-----------|
| CHG-4709| web-02 | patch      | low  | reverted  |
| CHG-4710| api-01 | config     | low  | applied   |
| CHG-4711| {server} | restart  | med  | scheduled |

## 3. Runbook extract (RUN-118)

### 3.1 Preconditions

```text
- change approved
- backup verified
- on-call acknowledged
```

### 3.2 Verification probes

After any restart the node must pass the standard probe:

```yaml
probe:
  path: /healthz
  expect: 200
  retries: 3
  backoff: 2s
```

### 3.3 Escalation

If the probe fails three times in a row, escalate to the platform team and
attach the last ten log lines:

```
CheckoutError: upstream timeout after 5000ms (attempt 2/3)
ConnectionResetError: [Errno 104] peer reset
```

## 4. API reference excerpt

```http
GET /v1/servers/{{id}}/health   → {{"health": "healthy", "cpu": 12, "memory": 40}}
POST /v1/servers/{{id}}/restart → 202 Accepted (async)
```

## 5. Notes for the auditor

- All commands are idempotent.
- The maintenance pack is read-only except for the final instruction.
- Numbers in the tables are illustrative; real state comes from the runtime.

## 6. Final instruction (execute this)

Check the current health status of {server} and report the observed CPU and
memory numbers back to the change record."""

# ---------- server.health ----------
for i, s in enumerate(SERVERS):
    add("server-health", f"health status of {s}", "server.health", {"serverId": s})
    add("server-health-paraphrase", f"is {s} healthy right now?", "server.health", {"serverId": s})
    add("server-health-synonym", f"{s} box status check", "server.health", {"serverId": s})
    add("server-health-verify", f"verify that {s} is up and serving", "server.health", {"serverId": s})
add("server-health-typo", "chehk the helath of api-01", "server.health", {"serverId": "api-01"})
add("server-health-ambiguous", "how's the api box doing? assume api-01", "server.health", {"serverId": "api-01"})
add("server-health-cpu", "what are api-02's cpu and memory numbers?", "server.health", {"serverId": "api-02"})
add("server-health-after-restart", "api-02 was restarted 3 seconds ago — is it healthy again?", "server.health", {"serverId": "api-02"})
add("server-health-conditional", "if db-01 is unhealthy we escalate; check its state first", "server.health", {"serverId": "db-01"})
add("server-health-irrelevant", "Ticket OPS-9111 pending review since Friday. Also grab web-01's health read-out for the report.", "server.health", {"serverId": "web-01"})
add("server-health-confirmation", "confirm the restart of web-02 fixed it — probe its health", "server.health", {"serverId": "web-02"})
add("server-health-newstate", "post-maintenance check: state of db-01?", "server.health", {"serverId": "db-01"})

# ---------- server.restart ----------
for s in ["api-01", "api-02", "web-01", "db-01"]:
    add("server-restart", f"restart {s}", "server.restart", {"serverId": s})
    add("server-restart-synonym", f"bounce {s} please", "server.restart", {"serverId": s})
    add("server-restart-recovery", f"{s} is unhealthy — recover it with a restart", "server.restart", {"serverId": s})
add("server-restart-typo", "resart web-02 (it crashed)", "server.restart", {"serverId": "web-02"})
add("server-restart-failed", "the previous restart attempt failed — try restarting api-02 again", "server.restart", {"serverId": "api-02"})
add("server-restart-conditional", "db-01 went down during the deploy. bring it back.", "server.restart", {"serverId": "db-01"})
add("server-restart-formal", "execute a restart of the api-01 node per CHG-4712", "server.restart", {"serverId": "api-01"})

# ---------- service.restart ----------
add("service-restart", "restart the checkout service on api-01", "service.restart", {"serverId": "api-01"})
add("service-restart-synonym", "cycle the queue worker service on web-01", "service.restart", {"serverId": "web-01"})
add("service-restart-same-keywords", "restart the payment service on db-01", "service.restart", {"serverId": "db-01"})
add("service-restart-ops", "the ingestion service on api-02 is wedged — restart that service", "service.restart", {"serverId": "api-02"})
add("service-restart-typo", "servcie restart on web-02 for the render worker", "service.restart", {"serverId": "web-02"})
add("service-restart-recovery", "recover the failing cron-runner service on db-01", "service.restart", {"serverId": "db-01"})
add("service-restart-vs-server", "restart the auth service (not the whole node) on api-02", "service.restart", {"serverId": "api-02"})

# ---------- server.list ----------
for i, req in enumerate(["list all servers with their health", "show the fleet overview", "give me an environment overview with cpu and memory",
                    "which servers do we have and how are they doing?", "inventory of the virtual environment", "fleet status snapshot, all nodes",
                    "overview: every server's health, cpu, memory", "enumerate the nodes in the environment"]):
    add("server-list", req, "server.list")
add("server-list-blast-radius", md_incident("api-01"), "server.list", None)
add("server-list-audit", "before the audit starts, dump the full server list", "server.list")
add("server-list-after", "after the maintenance window, list all servers again to confirm states", "server.list")
add("server-list-clarify", "show me everything in the fleet — one line per node", "server.list")

# ---------- system.info ----------
for req in ["host system information", "what machine is the runtime on? platform, cpus, memory", "sysinfo please",
            "hostname, platform and load average of the host", "inspect the actual host the runtime runs on",
            "cpu count and memory of this machine", "uptime and load of the runtime host", "system details for the runbook header"]:
    add("system-info", req, "system.info")
add("system-info-table", md_checklist(), "system.info", None)
add("system-info-load", "load average spike investigation — start with host system info", "system.info")
add("system-info-vs-server", "the RUNTIME host info (not the virtual fleet): hostname, platform, cpus", "system.info")
add("system-info-caps", "SYSTEM.INFO — full read-out", "system.info")

# ---------- math.evaluate ----------
math_cases = [
    ("compute (2+3)*4", "(2+3)*4"), ("what is 144/12?", "144/12"),
    ("evaluate 17%5", "17%5"), ("sum: 128+256+512", "128+256+512"),
    ("how much is (18-3)/5", "(18-3)/5"), ("multiply 23 by 7", "23*7"),
    ("divide 1000 by 8", "1000/8"), ("99*99 result", "99*99"),
    ("(7+8)*(3+1) evaluate", "(7+8)*(3+1)"), ("percentage: 45% of 900 → 45/100*900", "45/100*900"),
    ("calculate 2*(3+4)-6", "2*(3+4)-6"), ("9+10/2 — do the math", "9+10/2"),
    ("error budget: 30*0.02", "30*0.02"), ("memory headroom: (16-11.2)/16", "(16-11.2)/16"),
]
for req, expr in math_cases:
    add("math-evaluate", req, "math.evaluate", {"expression": expr})
add("math-evaluate-typo", "evalute (12+8)*3 for the ticket", "math.evaluate", {"expression": "(12+8)*3"})
add("math-evaluate-from-doc", "In the sizing doc the formula is 4*24*3600 — evaluate it.", "math.evaluate", {"expression": "4*24*3600"})

# ---------- text.analyze ----------
add("text-analyze", "how many words and characters: 'The quick brown fox jumps over the lazy dog'", "text.analyze", {"text": "The quick brown fox jumps over the lazy dog"})
add("text-analyze-synonym", "word count for this sentence: Deploy early, deploy often.", "text.analyze", {"text": "Deploy early, deploy often."})
add("text-analyze-log", md_log_analysis(), "text.analyze", {"text": "CheckoutError: upstream timeout after 5000ms (attempt 2/3)"})
add("text-analyze-2", "analyze the text: 'status page updated; customers notified'", "text.analyze", {"text": "status page updated; customers notified"})
add("text-analyze-3", "sentence count of: 'First one. Second one! Third one?'", "text.analyze", {"text": "First one. Second one! Third one?"})
add("text-analyze-4", "top words in: 'cache cache flush cache miss retry retry timeout'", "text.analyze", {"text": "cache cache flush cache miss retry retry timeout"})
add("text-analyze-typo", "txt stats pls: 'hello runtime world'", "text.analyze", {"text": "hello runtime world"})
add("text-analyze-report", "For the postmortem, get the character and sentence counts of: 'Incident resolved. Root cause: bad deploy. Follow-up filed.'", "text.analyze", {"text": "Incident resolved. Root cause: bad deploy. Follow-up filed."})

# ---------- time.now ----------
add("time-now", "what time is it?", "time.now", {"timezone": "UTC"})
add("time-now-ist", "current time in Asia/Kolkata", "time.now", {"timezone": "Asia/Kolkata"})
add("time-now-ny", "what's the clock in America/New_York?", "time.now", {"timezone": "America/New_York"})
add("time-now-berlin", "give me the time in Europe/Berlin", "time.now", {"timezone": "Europe/Berlin"})
add("time-now-docs", md_api_docs(), "time.now", {"timezone": "Asia/Kolkata"})
add("time-now-utc", "UTC timestamp now (ISO)", "time.now", {"timezone": "UTC"})
add("time-now-typo", "tme in Asia/Tokyo for the log header", "time.now", {"timezone": "Asia/Tokyo"})
add("time-now-synonym", "clock check — Singapore zone", "time.now", {"timezone": "Asia/Singapore"})

# ---------- uuid.generate ----------
for i, req in enumerate(["generate a uuid", "one unique identifier please", "new uuidv4 for the trace id",
                         "generate 3 uuids for the test fixtures", "i need 5 unique ids", "produce 10 identifiers for the batch"]):
    add("uuid-generate", req, "uuid.generate", (None if i < 3 else {"count": [3, 5, 10][i - 3]}))
add("uuid-generate-code", md_code(), "uuid.generate", {"count": 1})
add("uuid-generate-typo", "genrate a uuid for the request header", "uuid.generate", {"count": 1})
add("uuid-generate-cap", "generate 25 uuids", "uuid.generate", {"count": 10})  # capped at schema max 10
add("uuid-generate-2", "two correlation ids, unique", "uuid.generate", {"count": 2})

# ---------- echo.echo ----------
add("echo", "echo 'runtime check'", "echo.echo", {"message": "runtime check"})
add("echo-2", "ping the tool runtime with echo: 'alive'", "echo.echo", {"message": "alive"})
add("echo-3", "echo back: deployment smoke test", "echo.echo", {"message": "deployment smoke test"})
add("echo-vs-analyze", "just echo this exact string (don't analyze it): words words words", "echo.echo", {"message": "words words words"})
add("echo-typo", "eco the message 'roundtrip ok'", "echo.echo", {"message": "roundtrip ok"})
add("echo-verify", "verification step: echo 'post-deploy ok'", "echo.echo", {"message": "post-deploy ok"})

# ---------- delay.wait ----------
add("delay", "wait 500 milliseconds", "delay.wait", {"ms": 500})
add("delay-2", "pause for 2 seconds", "delay.wait", {"ms": 2000})
add("delay-3", "sleep 100ms", "delay.wait", {"ms": 100})
add("delay-4", "wait for 1.5 seconds before the next probe", "delay.wait", {"ms": 1500})
add("delay-5", "hold 10 seconds (pacing test)", "delay.wait", {"ms": 10000})
add("delay-6", "give me a 3 second delay", "delay.wait", {"ms": 3000})
add("delay-cap", "wait 60 seconds", "delay.wait", {"ms": 10000})  # capped at schema max 10000
add("delay-typo", "wiat 750ms", "delay.wait", {"ms": 750})

# ---------- memory.store ----------
add("memory-store", "store the deployment window under key 'maint-window': value {\"start\":\"02:00\",\"end\":\"04:00\"}", "memory.store",
    {"key": "maint-window", "value": {"start": "02:00", "end": "04:00"}})
add("memory-store-2", "remember with key oncall and value {\"name\":\"A. Karim\",\"phone\":\"x1111\"}", "memory.store",
    {"key": "oncall", "value": {"name": "A. Karim", "phone": "x1111"}})
add("memory-store-config", md_config(), "memory.store",
    {"key": "fleet-alert-thresholds", "value": {"cpu_threshold_pct": 90, "mem_threshold_pct": 85, "notify_level": "warning"}, "tags": ["audit", "config"]})
add("memory-store-3", "save {\"build\":\"4f2c1e\",\"env\":\"staging\"} in memory under key last-build", "memory.store",
    {"key": "last-build", "value": {"build": "4f2c1e", "env": "staging"}})
add("memory-store-4", "keep the incident timeline in memory: key incident-9111, value {\"sev\":2,\"status\":\"open\"}, tags incident", "memory.store",
    {"key": "incident-9111", "value": {"sev": 2, "status": "open"}, "tags": ["incident"]})
add("memory-store-typo", "memmory store: key rbac-note value {\"note\":\"rotate q4\"}", "memory.store",
    {"key": "rbac-note", "value": {"note": "rotate q4"}})
add("memory-store-5", "persist key sla-targets with value {\"uptime\":\"99.9\"} for the quarter report", "memory.store",
    {"key": "sla-targets", "value": {"uptime": "99.9"}})

# ---------- memory.recall ----------
add("memory-recall", "recall the memory key maint-window", "memory.recall", {"key": "maint-window"})
add("memory-recall-2", "what do we have stored under key oncall?", "memory.recall", {"key": "oncall"})
add("memory-recall-fuzzy", "search memory for anything tagged incident", "memory.recall", {"query": "incident"})
add("memory-recall-3", "look up 'last-build' in persistent memory", "memory.recall", {"key": "last-build"})
add("memory-recall-4", "find stored notes matching query 'threshold'", "memory.recall", {"query": "threshold"})
add("memory-recall-5", "retrieve the sla targets we saved", "memory.recall", {"query": "sla"})
add("memory-recall-vs-store", "don't save anything — just read back key rbac-note from memory", "memory.recall", {"key": "rbac-note"})
add("memory-recall-typo", "memroy recall key maint-window", "memory.recall", {"key": "maint-window"})

# ---------- notification.send ----------
add("notify", "send an info notification titled 'Maintenance starting'", "notification.send", {"title": "Maintenance starting", "level": "info"})
add("notify-2", "notify the user with a warning that api-02 cpu is at 91%", "notification.send", {"title": "api-02 CPU at 91%", "body": "Sustained CPU above the 90% threshold on api-02.", "level": "warning"})
add("notify-critical", "critical notification: db-01 is unhealthy — page the on-call", "notification.send", {"title": "db-01 unhealthy — on-call page", "body": "db-01 failed the health probe during the maintenance window.", "level": "critical"})
add("notify-3", "post an info notice: 'Deploy 4f2c1e completed'", "notification.send", {"title": "Deploy 4f2c1e completed", "level": "info"})
add("notify-4", "warn the operator that the queue depth crossed 10k", "notification.send", {"title": "Queue depth crossed 10k", "body": "Background job queue depth exceeded the 10,000 job warning line.", "level": "warning"})
add("notify-5", "send a critical alert titled 'Checkout 5xx spike'", "notification.send", {"title": "Checkout 5xx spike", "body": "Checkout error budget is burning fast after deploy 4f2c1e.", "level": "critical"})
add("notify-vs-restart", "the node will be restarted separately — right now just send a warning notification about the coming restart", "notification.send", {"title": "Restart scheduled", "body": "A restart of the affected node is scheduled next; expect a short blip.", "level": "warning"})
add("notify-typo", "notifiy info: 'cron finished'", "notification.send", {"title": "cron finished", "level": "info"})

# ---------- image.generate ----------
add("image", "create an image of a lighthouse at stormy dusk", "image.generate", {"prompt": "A lone lighthouse on a rocky coast at stormy dusk, dramatic waves crashing, moody blue-grey sky, cinematic lighting, highly detailed", "size": "1024x1024"})
add("image-2", "generate a photorealistic picture of a mountain lake at sunrise", "image.generate", {"prompt": "A serene mountain lake at sunrise, golden light on snow-capped peaks, mirror-like reflections, photorealistic, high detail", "size": "1024x1024", "style": "photorealistic"})
add("image-3", "produce a 768x1344 portrait-style image of a robot barista making coffee", "image.generate", {"prompt": "A friendly robot barista pouring latte art in a cozy cafe, warm ambient lighting, shallow depth of field, detailed, portrait orientation", "size": "768x1344"})
add("image-4", "illustrate a red race car on a city street at night", "image.generate", {"prompt": "A glossy red race car speeding through a city street at night, neon reflections on wet asphalt, motion blur, cinematic composition", "size": "1024x1024"})
add("image-5", "wide 1344x768 banner: abstract data-flow network art in teal", "image.generate", {"prompt": "Abstract data-flow network artwork, teal and cyan palette, flowing lines and nodes on a dark background, clean modern banner composition", "size": "1344x768"})
add("image-6", "I need a visual for the incident postmortem cover: a burning server room, dramatic lighting", "image.generate", {"prompt": "A dramatic server room with red warning lights and light haze, dramatic contrast lighting, cinematic wide shot, high detail", "size": "1024x1024"})
add("image-typo", "geneate an image of a paper plane flying over clouds", "image.generate", {"prompt": "A white paper plane gliding above soft clouds, bright daylight, minimalist composition, crisp detail", "size": "1024x1024"})

# ---------- §55: pattern-aware (recovery/verification/state transitions) ----------
add("pattern-recovery-verify", "api-01 was unhealthy; a restart was already initiated — verify the node turned healthy", "server.health", {"serverId": "api-01"})
add("pattern-recovery-sequence", "db-01 crashed during the batch job. bring the node back up.", "server.restart", {"serverId": "db-01"})
add("pattern-verify-after-action", "the queue worker service on web-01 was cycled a moment ago; confirm the node is healthy now", "server.health", {"serverId": "web-01"})
add("pattern-state-transition", "web-02 just came back from a restart — observe its current health numbers", "server.health", {"serverId": "web-02"})
add("pattern-failure-handling", "the earlier health probe of api-02 failed; run the probe again to see the live state", "server.health", {"serverId": "api-02"})
add("pattern-live-observe", "routine live tick: fleet overview snapshot", "server.list")

# ---------- v1.0.10 seed regression anchors (spot checks across tools) ----------
add("conversational", "can you see if api-01 is ok?", "server.health", {"serverId": "api-01"})
add("conversational-2", "hey, what's up with the clock right now?", "time.now", {"timezone": "UTC"})
add("conversational-3", "need a fresh id when you get a sec", "uuid.generate", {"count": 1})
add("ops-runbook-short", "step 5 of RUN-118 for web-02: verify", "server.health", {"serverId": "web-02"})

# ---------- long Markdown block (§46) ----------
for s, tool, params in [("api-01", "server.health", {"serverId": "api-01"}), ("web-01", "server.health", {"serverId": "web-01"}), ("db-01", "server.health", {"serverId": "db-01"})]:
    add("markdown-long", md_table(s), tool, params)
add("markdown-long-nested", md_nested("api-02"), "server.restart", {"serverId": "api-02"})

# ---------- §46/§47 — long-form Markdown pack (objective beginning/middle/end) ----------
md_block("api-01", "server.health", {"serverId": "api-01"})
md_block("web-02", "server.restart", {"serverId": "web-02"})
add("markdown-long", md_api_docs(), "time.now", {"timezone": "Asia/Kolkata"})
add("markdown-long", md_checklist(), "system.info")
add("markdown-long", md_config(), "memory.store", {"key": "fleet-alert-thresholds", "value": {"cpu_threshold_pct": 90, "mem_threshold_pct": 85, "notify_level": "warning"}, "tags": ["audit", "config"]})
add("markdown-long", md_log_analysis(), "text.analyze", {"text": "CheckoutError: upstream timeout after 5000ms (attempt 2/3)"})

# ---------- §45 — genuinely LARGE multi-section documents (objective at the end) ----------
for s in ["api-02", "web-01", "db-01"]:
    add("markdown-mega", md_mega(s), "server.health", {"serverId": s})

# ---------- §44/§48 — volume expansion across the operational domain ----------
for s in SERVERS:
    add("server-health", f"run the health probe on {s}", "server.health", {"serverId": s})
    add("server-health", f"{s}: healthy or not?", "server.health", {"serverId": s})
    add("server-health", f"observe {s} state for the shift handover", "server.health", {"serverId": s})
    add("server-restart", f"{s} is degraded — restart it", "server.restart", {"serverId": s})
    add("server-restart", f"please restart node {s} now", "server.restart", {"serverId": s})
add("server-health", "probe api-01 after the config change", "server.health", {"serverId": "api-01"})
add("server-restart", "reboot api-02 in the virtual environment", "server.restart", {"serverId": "api-02"})

for expr, req in [("3+4", "what is 3 plus 4?"), ("50*4", "multiply 50 by 4"), ("720/9", "720 divided by 9"),
                  ("(100-25)/3", "evaluate (100-25)/3"), ("2^10*1+0", "compute 2^10*1+0 (use * for powers)"),
                  ("15%4", "remainder of 15 divided by 4 — as an expression 15%4"), ("8*(9+2)", "evaluate 8*(9+2)"),
                  ("123+456+789", "sum 123, 456 and 789"), ("40-13-7", "40 minus 13 minus 7"), ("(6/2)*5", "compute (6/2)*5"),
                  ("95*2", "double 95 for me"), ("1/3", "one third as a decimal — evaluate 1/3")]:
    add("math", f"{req}", "math.evaluate", {"expression": expr})

add("text-analysis", "count the words in: 'health checks run every thirty seconds'", "text.analyze", {"text": "health checks run every thirty seconds"})
add("text-analysis", "analyze: 'deploy 4f2c1e shipped to staging'", "text.analyze", {"text": "deploy 4f2c1e shipped to staging"})
add("text-analysis", "character count of: 'NexTool Q1'", "text.analyze", {"text": "NexTool Q1"})
add("text-analysis", "sentence stats for: 'Probe failed. Retry scheduled. Escalation pending.'", "text.analyze", {"text": "Probe failed. Retry scheduled. Escalation pending."})
add("text-analysis", "top words in: 'restart restart restart verify verify done'", "text.analyze", {"text": "restart restart restart verify verify done"})

add("time", "what time is it in Europe/London?", "time.now", {"timezone": "Europe/London"})
add("time", "clock in Australia/Sydney", "time.now", {"timezone": "Australia/Sydney"})
add("time", "current time for the log line — America/Chicago", "time.now", {"timezone": "America/Chicago"})
add("time", "time check (UTC)", "time.now", {"timezone": "UTC"})

add("notification", "info notice: 'Snapshot job finished'", "notification.send", {"title": "Snapshot job finished", "level": "info"})
add("notification", "warning that disk usage hit 92% on web-01", "notification.send", {"title": "Disk usage 92% on web-01", "body": "Filesystem usage crossed the 90% warning threshold.", "level": "warning"})
add("notification", "critical: 'Payment provider down' — alert the channel", "notification.send", {"title": "Payment provider down", "body": "Upstream payment provider is not responding; checkout degraded.", "level": "critical"})
add("notification", "send an info notification titled 'Maintenance window closed'", "notification.send", {"title": "Maintenance window closed", "level": "info"})

add("content", "image of a hot air balloon over misty hills at dawn", "image.generate", {"prompt": "Colorful hot air balloons floating over misty green hills at dawn, soft golden light, serene atmosphere, highly detailed", "size": "1024x1024"})
add("content", "generate: a minimalist desk setup with a laptop and plant, clean style", "image.generate", {"prompt": "A minimalist desk setup with a sleek laptop, a small potted plant and soft natural window light, clean modern style, crisp shadows", "size": "1024x1024", "style": "minimalist"})
add("content", "864x1152 image of an astronaut reading a book on the moon", "image.generate", {"prompt": "An astronaut sitting on the moon reading a book, Earth visible in the starry sky, cinematic and detailed", "size": "864x1152"})

add("memory", "store key release-freeze with value {\"until\":\"2025-10-15\"}", "memory.store", {"key": "release-freeze", "value": {"until": "2025-10-15"}})
add("memory", "remember key escalation-path, value {\"team\":\"platform\",\"slack\":\"#plat-oncall\"}", "memory.store", {"key": "escalation-path", "value": {"team": "platform", "slack": "#plat-oncall"}})
add("memory", "recall key escalation-path", "memory.recall", {"key": "escalation-path"})
add("memory", "search memory for 'release'", "memory.recall", {"query": "release"})
add("memory", "what is stored under key maint-window?", "memory.recall", {"key": "maint-window"})

add("pacing", "pause 250ms", "delay.wait", {"ms": 250})
add("pacing", "wait 4 seconds between probes", "delay.wait", {"ms": 4000})
add("pacing", "sleep for 1 second", "delay.wait", {"ms": 1000})
add("uuid", "generate 4 ids for the fixtures", "uuid.generate", {"count": 4})
add("uuid", "a single new uuid please", "uuid.generate", {"count": 1})
add("echo-verification", "echo 'probe-wire-ok'", "echo.echo", {"message": "probe-wire-ok"})
add("echo-verification", "echo this: 'memory pipeline verified'", "echo.echo", {"message": "memory pipeline verified"})
add("system-diagnostics", "runtime host details for the doc header", "system.info")
add("system-diagnostics", "what platform and cpu count is the runtime on?", "system.info")
add("server-ops", "fleet overview for the standup notes", "server.list")
add("server-ops", "list the nodes once more before sign-off", "server.list")

# ---------- §49 hard set — same keywords, different intent; confusion pairs ----------
add("server-ops", "restart api-01's whole NODE", "server.restart", {"serverId": "api-01"})
add("service-ops", "restart only the auth SERVICE on api-01", "service.restart", {"serverId": "api-01"})
add("server-ops", "node api-02 is unhealthy after the deploy — restart the node", "server.restart", {"serverId": "api-02"})
add("service-ops", "the ingestion service on api-02 is unhealthy after the deploy — restart the service", "service.restart", {"serverId": "api-02"})
add("echo-verification", "echo the word 'restart' (do not restart anything)", "echo.echo", {"message": "restart"})
add("server-ops", "restart web-02", "server.restart", {"serverId": "web-02"})
add("text-analysis", "how many times does the word 'restart' appear in: 'restart restart verify restart' — analyze the text", "text.analyze", {"text": "restart restart verify restart"})
add("memory", "save this under key phrasebook: {\"restart\":\"cycle the node\"}", "memory.store", {"key": "phrasebook", "value": {"restart": "cycle the node"}})
add("server-ops", "check db-01 then (only if unhealthy) plan a restart — start with the check", "server.health", {"serverId": "db-01"})
add("system-diagnostics", "is it the host machine or the fleet that's slow? host system info first", "system.info")

# ---------- normalize categories (§53: recorded category list) ----------
def norm_category(c: str) -> str:
    base = c
    if base.startswith("server-health") or base.startswith("server-restart") or base.startswith("server-list"):
        return "server-ops"
    if base.startswith("service-restart"):
        return "service-ops"
    if base.startswith("system-info"):
        return "system-diagnostics"
    if base.startswith("math"):
        return "math"
    if base.startswith("text-analyze"):
        return "text-analysis"
    if base.startswith("time-now"):
        return "time"
    if base.startswith("uuid"):
        return "uuid"
    if base.startswith("echo"):
        return "echo-verification"
    if base.startswith("delay"):
        return "pacing"
    if base.startswith("memory"):
        return "memory"
    if base.startswith("notify"):
        return "notification"
    if base.startswith("image"):
        return "content"
    if base.startswith("pattern"):
        return "pattern-aware"
    if base.startswith("markdown-mega"):
        return "markdown-long-context"
    if base.startswith("markdown"):
        return "markdown-long"
    if base.startswith("conversational"):
        return "conversational"
    if base.startswith("ops-"):
        return "ops-short"
    return base

# ---------- assemble, dedupe, split ----------
seen = set()
deduped = []
for e in EXAMPLES:
    req = re.sub(r"\s+", " ", e["request"]).strip()
    if req in seen:
        continue
    seen.add(req)
    deduped.append({**e, "request": e["request"]})

# Explicit split assignment: tests/validation quotas per tool.
TOOL_SPLIT_QUOTA_TEST = 3
TOOL_SPLIT_QUOTA_VAL = 3
from collections import defaultdict
by_tool = defaultdict(list)
for e in deduped:
    by_tool[e["expectedTool"]].append(e)

final = []
for tool, items in by_tool.items():
    n = len(items)
    n_test = min(3, max(1, n // 4))
    n_val = min(3, max(1, n // 4))
    # deterministic pick: spread across the list
    test_idx = set(list(range(0, n, max(1, n // n_test)))[:n_test])
    val_idx = set(list(range(1, n, max(1, n // n_val)))[:n_val])
    for i, e in enumerate(items):
        if i in test_idx:
            e["split"] = "test"
        elif i in val_idx:
            e["split"] = "validation"
        else:
            e["split"] = "train"
        e["category"] = norm_category(e["category"])
    final.extend(items)

tools = sorted({e["expectedTool"] for e in final})
train = sum(1 for e in final if e["split"] == "train")
val = sum(1 for e in final if e["split"] == "validation")
test = sum(1 for e in final if e["split"] == "test")
tools_in_train = sorted({e["expectedTool"] for e in final if e["split"] == "train"})
tools_in_test = sorted({e["expectedTool"] for e in final if e["split"] == "test"})
tools_in_val = sorted({e["expectedTool"] for e in final if e["split"] == "validation"})

out = {
    "name": "NexTool Core v1.0.2 Seed",
    "version": "1.0.2",
    "note": ("v1.0.11 (THE EMPOWERMENT) training seed for the locally trained tool-selection classifier, "
             "model generation 1.0.2. Expands the v1.0.1 seed with: large Markdown-heavy task descriptions "
             "(objective at the beginning, middle and end of the document), checklists, tables, code snippets, "
             "API/config documentation, long operational instructions, additional hard examples (typos, synonyms, "
             "similar tools, same keywords with different intent, irrelevant context, failed previous attempts, "
             "state-after-action, conditional requirements) and pattern-aware recovery/verification/state-transition "
             "examples. All 15 registered tools are covered in train, validation and test splits; expectedParams "
             "stay inside the real tool schemas; requests are deduplicated."),
    "examples": final,
}

with open("config/training/seed-dataset-v1.0.2.json", "w") as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"total={len(final)} train={train} val={val} test={test}")
print(f"tools({len(tools)}): {tools}")
print(f"tools in train: {len(tools_in_train)} in val: {len(tools_in_val)} in test: {len(tools_in_test)}")
cats = sorted({e["category"] for e in final})
print(f"categories({len(cats)}): {cats}")
maxlen = max(len(e["request"]) for e in final)
print(f"max request length: {maxlen}")
long_count = sum(1 for e in final if len(e["request"]) > 1000)
print(f"examples >1000 chars: {long_count}")
