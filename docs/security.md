---
title: Security
category: Architecture
order: 8
---

# Security — sandbox boundaries and honest limitations

This page is the security reference for the tool runtime (v1.0.6). The design goal:
tools are useful application code, but they can never reach the NexTool host
filesystem, the host system, or the network without passing one audited policy layer.
Everything below is implemented in `src/lib/nexool/tools/*` and enforced at execution
time — the capability payload served by `GET /api/tools/environments` is generated
from the same constants, so the documentation, the IDE and the runtime cannot drift.

## Host filesystem isolation

- `js-function` tools run in a contextified `node:vm` sandbox that is never given
  `require`, `process`, `Buffer` or any filesystem object. There is no path from tool
  code to the host fs — not through globals, not through imports.
- `nodejs` tools run in the same kind of sandbox; `require('fs')` resolves to the
  **Virtual File System** (below), not the host `fs`. `process` is a blocked module
  ("process manipulation is never allowed"), so `process.cwd()`, `process.env` and
  friends are unreachable.
- The static module allowlist (`buffer`, `crypto`, `events`, `path`, `querystring`,
  `string_decoder`, `url`, `util`, `assert`, `zlib`) contains no I/O module; `path`
  works on strings only.

## Virtual filesystem (VFS)

The VFS (`tools/vfs.ts`, `tools/sandbox-fs.ts`) is a real, persistent filesystem that
belongs to the tool runtime — **never** the host fs outside its root. **Changed in
v1.0.14 (§24): the root is now a REAL host directory, `VFS/` inside the project storage
root** (formerly the hidden `data/vfs` location; a one-time automatic migration moves
legacy contents into `VFS/` on first VFS use — never deletes/overwrites, logged
`[vfs] v1.0.14 migration`). What did NOT change is the sandbox:

- **Isolation** — ONE shared sandboxed store for all restricted tools (v1.0.12),
  scaffold `/input /output /tmp /data /workspace`; tool code sees only virtual absolute
  paths rooted at `/` and can never reach the host filesystem.
- **Path safety** — every path is decoded before validation (encoded traversal
  `%2e%2e` is caught), normalized, and rejected on: `..` beyond the virtual root,
  `file:` URLs, backslash paths, NUL bytes, malformed percent-encoding. Symbolic links
  are refused and the root is pinned by `realpath` — a symlink planted inside `VFS/`
  cannot redirect an operation outside it. Escape attempts fail with
  `VirtualFSAccessError: Access to the NexTool host filesystem is not permitted.`
  — never a silent redirect.
- **Limits** — enforced LIVE from the central config (`vfs.*`: shipped 2 MiB per file,
  700 MiB total, 4 000 entries, depth 56, path ≤ 512 chars) on every operation;
  editable at runtime via the Limitations page (hot reload ≤ 2 s) — lowering a limit
  never deletes existing data, new violating operations just fail clearly.
- **Terminal isolation** — the virtual `child_process` executes its documented command
  set against this tree through the sandbox's own restricted layer (a virtual session,
  never a host shell); `fs.cmd` is the only host-terminal tool and it always requires
  explicit user confirmation with its own handler-level gate.
- **Cross-environment note** — because `VFS/` physically exists in the host fs,
  `freedom-node` tools can access the same tree at the real path (they bypass the
  virtual-path sandbox by design); `mcp` connectors and restricted environments stay
  VFS-only and never gain host visibility. See
  [Architecture → Access boundaries](architecture.md#access-boundaries-real-fs--vfs--mpcrestricted).

## Network restrictions

One networking layer — `policyFetch` (`tools/sandbox-net.ts`) — serves `fetch`,
`XMLHttpRequest` and the virtual `http`/`https` modules in both environments. The
policy (`getNetworkPolicy()`) is resolved LIVE from the central
`config/configuration-limits.json` (shipped values):

| Restriction | Shipped value (live from the central limits) | Error code |
| --- | --- | --- |
| Protocol | `http:` / `https:` only | `PROTOCOL_BLOCKED` |
| Host | localhost (+`.localhost`, `.local`, `.internal`), loopback, link-local (incl. `169.254.x.x` cloud metadata), private ranges (10/8, 127/8, 172.16/12, 192.168/16, CGNAT 100.64/10), multicast/reserved, `host.docker.internal` | `HOST_BLOCKED` |
| Request timeout | `network.timeoutMs` — default 60 000 ms (the effective per-request timeout follows the owning tool's execution timeout; Settings-configurable since v1.0.9) | `NETWORK_TIMEOUT` |
| Response size | `network.maxResponseBytes` — 5 MiB, body read incrementally and aborted past the cap | `RESPONSE_TOO_LARGE` |
| Redirects | `network.maxRedirects` — max 56, every hop re-validated against protocol + host policy | `REDIRECT_LIMIT` |
| Requests per execution | `network.maxRequestsPerExecution` — max 56 | `REQUEST_LIMIT` |
| URL imports | enabled since v1.0.8 (`allowUrlImports: true`), capped at `network.maxResponseBytes` | `URL_IMPORTS_DISABLED` when off |
| **Self-origin access (v1.0.91)** | path-relative fetch URLs (`/api/…`) resolve against the application origin (`network.selfOriginAccess: true`) and are exempt from the host block ONLY — all other limits still apply; ABSOLUTE URLs (even to the app origin itself) keep the full host policy | `INVALID_URL` when disabled |

There is no second fetch path: the runtime's own code paths do not bypass
`policyFetch`, and raw sockets (`net`, `dgram`) are blocked modules.

## Module allowlist + blocked list

`nodejs` tools resolve modules through ONE centralized import resolver
(`tools/import-resolver.ts`) with exactly three sources: the static allowlist, the
context-provided virtual modules (`fs` → VFS, `os` → virtualized values, `timers`,
`timers/promises`, `http`/`https` → the controlled client, `child_process` → the
virtual command layer), and VFS files. Everything else fails with the
`Module "x" is not available in the NexTool Node.js environment (…)` wording.

Deliberately blocked (with reasons served by the API): `cluster`, `vm`,
`worker_threads`, `net`, `dgram`, `dns`, `process`, `perf_hooks`, `inspector`,
`module`, `async_hooks`. `js-function` tools are narrower still: only VFS modules
resolve; every Node specifier is rejected.

## Node.js API restrictions

- No `process`, no `Buffer` outside the allowlisted `buffer` module, no globals beyond
  the documented sandbox surface (`NODE_SANDBOX_GLOBALS`).
- Timers exist but are bounded by the execution deadline (default 10 s watchdog — v1.0.7: the effective, configurable tool timeout up to 1 h; deferred only
  while a `prompt()` legitimately waits).
- `os` values are fixed sandbox constants (`platform()` → `'nextool-virtual'`,
  `hostname()` → `'nextool-sandbox'`, `tmpdir()` → `'/tmp'`) — no host introspection.
- Dynamic `import()` call sites are rewritten at compile time to the resolver shim —
  there is no flag combination that produces a real dynamic import.

## Child process restrictions

`child_process` is a RESTRICTED VIRTUAL command layer
(`tools/virtual-child-process.ts`) — **no real host process is ever spawned**:

- Commands: `ls cat head tail echo printf pwd wc grep sort uniq date mkdir touch rm cp
  mv basename dirname env true false` — executed virtually against the tool's VFS
  workspace (working directory = the tool's `/workspace`).
- Shell metacharacters (`;` `&&` `||` `` ` `` `$(` `>` `<` `&`) are rejected with exit
  126; unknown commands exit 127; timeout 8 s (exit 124); output ≤ 64 KiB; ≤ 4
  processes per execution; ≤ 3 pipe stages; ≤ 32 args.
- API surface limited to `exec`, `execSync`, `execFile`, `spawn`, `spawnSync` — every
  creation path enforces the identical policy. There is no hidden route around the
  tokenizer.

## Execution limits

| Limit | js-function | nodejs |
| --- | --- | --- |
| Source length | ≤ 64 000 chars | ≤ 64 000 chars |
| Sync execution | 4 s (vm timeout, enforced at invocation) | 4 s (vm timeout, enforced at invocation) |
| Async watchdog | default 10 s (`TIMEOUT`) — v1.0.7: the effective tool timeout (≤ 1 h) | default 10 s (`TIMEOUT`) — v1.0.7: the effective tool timeout (≤ 1 h) |
| Heap growth | — | 256 MiB sentinel (`MEMORY`) |
| Result | ≤ 64 KiB serialized, depth ≤ 12 | ≤ 64 KiB serialized, depth ≤ 12 |
| Logs | 100 lines × 2000 chars | 100 lines × 2000 chars |

## Import restrictions

- Static allowlist + virtual modules + VFS files only (`.js`, `.mjs`, `.json`); VFS
  modules run CommonJS plus a conservative ESM transform — nothing else executes.
- URL imports are enabled by default since v1.0.8 (`allowUrlImports`) and pass the full
  network policy (see the network table).
- There are no approved external packages today — unknown package specifiers are
  honestly reported as unavailable.
- **Self-origin access (v1.0.91)**: tool functions can reach the application's own
  HTTP surface ONLY via path-relative URLs (`/api/…`) resolved against the application
  origin, gated by `network.selfOriginAccess`. The exemption covers the local-host
  block ONLY — every other network limit still applies, and absolute URLs (including
  an absolute URL of the application origin itself) stay subject to the unchanged SSRF
  host block, so other local services (databases, metadata endpoints, sibling ports)
  remain unreachable.

## Freedom-node threat model (v1.0.11)

The `freedom-node` tool environment is an **intentionally unrestricted** execution
surface (see [Tool Development](tool-development.md#the-freedom-node-environment--intentionally-unrestricted-v1011)).
It does not weaken the sandboxes above — it sits OUTSIDE them, explicitly requested per
tool (`environment: "freedom-node"`), and everything in this section describes that
single, explicit, opt-in path:

- **What it grants** — real `require()`/`import()` (Node builtins + npm packages), the
  REAL host filesystem (never REDIRECTED into the VFS — and since v1.0.14 a freedom
  tool can also read/write the shared `VFS/` tree at its real path, because the
  directory physically exists in the host fs; the VFS limits and path validation do
  not apply to it), real network WITHOUT the Network Policy caps
  (no request-count/response-size/redirect/per-request-timeout/URL-import limits), real
  `child_process` and the real `process` object including `process.env`.
- **Configuration-only gate, fail closed** — the escape is authorized ONLY by the
  central `fs` section of `config/configuration-limits.json` (`fs.enabled: true`,
  `fs.restricted: false`). The runtime reads the gate server-side on EVERY execution;
  when it is closed — or the file is unreadable — every freedom-node execution (and
  every Tool-IDE test run of one) is rejected with `FREEDOM_DISABLED` and nothing runs.
- **No Settings control, no API path** — the Settings UI deliberately has NO control
  for the `fs` switch and no API route can flip the gate. Editing the configuration
  file on the host is the only way to open or close it. This keeps the host-level
  escape out of reach of console-only users and of any HTTP-only compromise of the
  console surface.
- **Explicit-only blast radius** — existing `js-function`/`nodejs`/`dynamic` tools keep
  every restriction byte-for-byte; the gate cannot be widened for them.
- **What is still bounded** — the TASK LIFECYCLE remains: the tool execution deadline
  (interaction-aware watchdog), the `vm` sync cap (event-loop protection), the
  JSON-serializable result contract with a 5 MiB runtime transport cap, capped console
  log capture, and the approval/auto-execution hierarchy. `process.env` is never
  auto-dumped into logs or the UI.
- **Operational guidance** — treat a freedom-node tool like a host script: install only
  from trusted sources, review its source, and keep `fs.enabled: false` on shared hosts
  (a closed gate defeats even imported/registered freedom tools, fail closed).

## Tool approval & approval timeout

Every tool carries an `autoExecute` flag (default **false**). Since v1.0.11 the decision
goes through the ONE auto-execution hierarchy (`resolveAutoExecution`: global → tool →
task, `undefined` never forces, a lower layer can never override a higher enable — see
[Configuration](configuration.md#tool-auto-execution-approval-v106-hierarchy-redefined-in-v1011)).
With all layers unset/false, every task-driven
execution waits for an explicit Allow/Deny decision: `tool.approval.required` →
`awaiting_approval` → `tool.approval.allowed | .denied | .timeout`. The 5-minute
timeout **stops the task** — a timeout never silently executes the tool, and denial
feedback is recorded as a runtime event. This is the human-in-the-loop control for
everything the sandbox cannot decide statically.

## Protected resources: application reset & cleanup (v1.0.7)

The **Reset Application Data** operation (`POST /api/settings/reset`, typed `RESET`
phrase required) is implemented as an explicit deletion ALLOWLIST in
`maintenance.ts` — there is no code path that can drop the database or a storage
directory. Protected by construction: tools (definitions, handler config, function
source), models (registrations, manifests, artifacts), datasets (records, examples,
files), training jobs + benchmark runs (training artifacts / provenance) and
settings. Only runtime data is cleared (tasks, events, history, memory,
notifications, generated images, tool Virtual FS workspaces) and tool statistics are
zeroed while the tools themselves stay. Tool usage statistics reset to zero — the
tools do not.

The dependency-aware cleanup removes ONLY resources proven unreferenced by the
dependency graph (training jobs, benchmark runs, active status). The current model,
required datasets and every referenced resource are protected; cleanup is idempotent;
`exports/` downloads are never touched. `validateRuntimeDependencies` reports missing
artifacts or broken references as errors instead of silently recreating anything.

## Honest limitations

- **In-process sandbox, not a container.** The `node:vm` sandboxes share the Node.js
  process with the runtime. Defense is object-capability style (nothing dangerous is
  handed to tool code), but a hypothetical vm escape would be out of scope for these
  guarantees. Run the deployment in a container/OS boundary if your threat model
  requires it.
- **The heap sentinel cannot revoke memory.** The 256 MiB `MEMORY` guard aborts a
  runaway tool's result, but memory it already allocated in the host process is only
  reclaimed by the garbage collector (or a process restart).
- **Paused tasks cannot survive a process restart.** Pause state lives in the in-memory
  run handle; if the server dies while a task is paused, the task row stays `paused`
  and cannot resume (Stop still works).
- **VFS write-through is last-write-wins.** Concurrent executions of the same tool each
  write their snapshot; there is no cross-execution transaction.
- **Test-mode interactivity was simulated — INTERACTIVE since v1.0.14.** In Tool IDE
  test runs, `alert`/`confirm`/`askForUserAsChoice`/`prompt` now WAIT for the operator
  exactly like production (the v1.0.6–v1.0.13 auto-resolving test behavior — alert
  immediate, prompt default — was removed). A test that nobody answers simply stays on
  its interaction card (deadline/120 s rules unchanged).
- **freedom-node is unrestricted BY DESIGN (v1.0.11).** The environment deliberately
  drops the sandbox guarantees documented on this page for its tools (real fs, real
  network, real processes). Its only gate is the configuration file, and it fails
  closed; the safeguards that remain are the task-lifecycle limits listed in the
  [freedom-node threat model](#freedom-node-threat-model-v1011).

## See also

- [Tool Development](../tools/tool-development.md) — the authoring-side contracts
  (module tables, VFS guide, virtual child_process, network policy).
- [Tool Runtime](../tools/tool-runtime.md) — the approval gate and execution pipeline.
- [Runtime](runtime.md) — task states incl. `awaiting_approval` / `paused`.
- [Configuration](../getting-started/configuration.md) — the approval precedence model.

## Configuration limits and the security boundary (v1.0.8 §7.10/§18)

`config/configuration-limits.json` controls the application's **configured limits** —
and nothing else. Raising a limit never grants host-level privileges:

- `max timeout = 1 day` (self-hosted) does **not** mean an unrestricted host process —
  the tool still runs inside its sandbox with the same isolated surfaces.
- `max VFS size = 700 MiB` does **not** mean host filesystem access — the Virtual FS
  remains the sandboxed `VFS/` tree with decode-before-validate path safety (v1.0.14:
  a real directory, sandbox unchanged).
- URL imports (enabled by default in v1.0.8) pass the full network policy — protocol,
  host, timeout, response size, redirect and per-execution request caps — and imported
  modules execute under the SAME sandbox boundary as the importing tool.
- Virtual `node`/`npm` run inside the sandbox: `fs` is the VFS, `fetch` is the policy
  layer, packages install into the tool's workspace `node_modules`, lifecycle scripts
  are not auto-executed, and the host `node_modules`/source are unreachable.
- The executor timeout watchdog is interaction-aware: while a tool waits for a user
  answer (confirm/prompt) the watchdog defers and restores the full budget afterwards;
  confirmations resolve `false` on cancellation/expiry — never `true`.

## v1.1.0 additions — boundaries unchanged

v1.1.0 adds capabilities but changes NO security boundary:

- **The VFS shell's `vfsTerminal.allowedCommands` is a CAP, not an escape.** The
  server-side VFS shell (`/api/inspector/vfs/shell`) enforces the configured command
  list on every execution — but the list only narrows the shell UX. The VFS root
  boundary itself (path normalization, symlink refusal, `VFS_ACCESS` on escape) stays
  code-enforced for EVERY command including the allowed ones; setting
  `allowedCommands: null` (unrestricted) permits every IMPLEMENTED command — it does
  not, and cannot, turn the VFS shell into a host shell. Chaining/piping
  metacharacters are rejected; `echo … > file` redirection writes inside the VFS only.
- **The four file-editing tools stay VFS-confined.** `fs.apply_edits`, `fs.find_replace`,
  `fs.insert_text` and `fs.append_text` operate exclusively through the shared
  directory-backed VFS (`openGlobalVfs → normalizeVirtualPath → resolveSecure` +
  symlink refusal) — the same boundary as `fs.readfile`/`fs.writefile`. Host paths,
  traversal and symlink escapes fail with `FS_ACCESS`; oversized files fail with
  `FS_TOO_LARGE`. Their validation semantics (all-or-nothing edit sets, bounded
  regex, honest zero-match) are correctness guarantees, not security exemptions.
- **Force-stop kills ONLY task-owned processes.** The per-task registry
  (`main/task-processes.ts`) tracks real host processes spawned on a task's behalf
  (today: `fs.cmd` bash children). Stop terminates exactly those (SIGTERM → SIGKILL,
  group kills for detached children) — never the standalone FS Inspector terminal, and
  never unrelated host processes. The Late-write guard means a stopped task cannot be
  resurrected by a completing parallel batch, and the decision-level guard means a
  decision that resolved during stop never executes.
- **The real-FS terminal remains an operator surface, not a tool surface.** It is the
  documented REAL-filesystem console (like the read-only FS Inspector, but
  interactive); MCP/restricted tool environments still have no route to it, and it is
  never reachable from task tool code (`fs.cmd` remains the only task-driven host
  command path, behind its double confirmation gate). A task force-stop deliberately
  does not touch operator-opened terminal sessions.
