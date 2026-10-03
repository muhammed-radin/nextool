---
title: Tool Development
category: Tools
order: 2
---

# Tool Development — the Tool IDE, js-function and nodejs tools

v1.0.2 introduced the in-console Tool IDE: author a JavaScript tool in Monaco, define its
parameter schema, get schema-driven IntelliSense, test it in the real sandbox, and save it
into the live registry. The execution environment was `js-function` — the tool **is** a
JavaScript function (`async function execute(params, context)`) run inside a hardened
`node:vm` sandbox. **v1.0.5** added a second authorable environment — `nodejs`, a
restricted Node.js JavaScript environment — plus a structured metadata editor, a
structured tool-schema form, a Monaco ⇄ textarea toggle and hardened editor source-sync.
**v1.0.6** is the tool-runtime expansion release: both environments now share a common
controlled baseline (`fetch`, a real `XMLHttpRequest`, async `alert()`/`prompt()`,
timers), the `nodejs` environment gains a **Virtual File System**, a **restricted virtual
`child_process`**, controlled `http`/`https`, virtualized `os` and a centralized import
resolver with VFS modules — and every tool gains an `autoExecute` approval flag.
v1.0.4 already hardened the editor loop (the code you see is the code that is saved and
tested) and made **Duplicate** non-destructive; JSON export/import of tools is documented
in [Tools](tools.md#tool-export--import-as-json-v104). This page is the complete guide;
the ToolDefinition schema, dynamic handler kinds and the built-in tools live in
[Tools](tools.md).

## Entry points

- **Tools view → New Tool** — opens the IDE with an empty draft (mode `new`).
- **Tools view → Edit** — opens a saved user tool (mode `edit`). Built-in and
  `virtual-env` tools are read-only; use **Duplicate** instead, which prefills an
  editable copy under a new name.
- The IDE is a dedicated console view (`tool-editor.tsx`, zustand view `tool-editor`);
  closing it returns to the Tools grid.

## Anatomy of a function tool

Both authorable function environments share **one** execute contract:

```ts
async function execute(params, context) {
  // params  — validated against the tool's schema
  // context — { executionId, taskId, mode, now, log(...) }
  return { anything: 'JSON-serializable' };
}
```

| Part | Contract |
| --- | --- |
| `params` | Values produced by CoreModule (production) or you (test), validated against the schema. |
| `context.executionId` | Unique id of this execution run. |
| `context.taskId` | Owning task id — `null` during Tool IDE test runs. |
| `context.mode` | `'test'` (IDE/CLI test runs) or `'production'` (real task executions). |
| `context.now` | ISO timestamp captured at invocation. |
| `context.log(...parts)` | Appends a log line (capped at 100 lines, 2000 chars each); test runs surface them in the test panel. |
| return value | Must be JSON-serializable, ≤ 64 KiB serialized, depth ≤ 12. |

A source that already declares `execute` is compiled as-is; a bare statement body is
wrapped into `(async function execute(params, context) { … })` automatically.

There is exactly **one** execution path per environment: `js-runner.ts`
(`js-function`) and `node-runner.ts` (`nodejs`) both serve IDE tests, the
`POST /api/tools/test` endpoint and real task executions (with `mode: 'production'`).
Neither runner is used anywhere else.

## Choosing the execution environment (v1.0.6)

The Tool IDE **Execution environment** selector offers the authorable environments
`js-function`, `nodejs` and `dynamic`. The list, labels and descriptions come from the
**real runtime registry** — `GET /api/tools/environments` — not a hardcoded frontend
copy (see [API](api.md#get-apitoolsenvironments)). Tools stored as `dynamic` are **locked**
to dynamic in the editor (handler-based storage) — duplicate one into a function tool to
change its environment.

| | `js-function` | `nodejs` | `dynamic` |
| --- | --- | --- | --- |
| What it is | Restricted JavaScript tool sandbox | Restricted, **virtualized** Node.js JavaScript environment | Registered handler kind (`echo`/`delay`/`http_get`/`uuid`), no custom code |
| Entry point | `execute(params, context)` | `execute(params, context)` — **same contract** | handler implementation |
| Common runtime APIs (v1.0.6) | `fetch`, `XMLHttpRequest`, `alert`, `prompt`, timers, standard globals | same baseline | only via `http_get` with its configured URL |
| Modules | `require()` resolves **VFS modules only** (no Node modules) | static allowlist + context-provided virtual modules (`fs`, `os`, `timers`, `http`/`https`, `child_process`) via ONE import resolver | — |
| Filesystem | VFS modules through `require()`/`import()` | full Virtual FS (`fs` module) | — |
| Network | policy-controlled `fetch` + `XMLHttpRequest` | the same controlled layer through `fetch`/XHR **and** `http`/`https` | only via `http_get` |
| `process` | none | none — `process` is blocked | — |
| Typical use | computation + fetch + interactive tools over params | file processing in the VFS, controlled HTTP clients, virtual shell pipelines | safe I/O with fixed behavior |

**nodejs is still a sandbox** — it is *not* unrestricted Node.js access. Everything
reachable is allowlisted, virtualized or policy-controlled: `fs` **is** the Virtual FS,
`http`/`https` route through the network policy, `child_process` never spawns a host
process. See the tables below for exactly what exists, and
[Security](security.md) for the threat-model reasoning.

## Common runtime APIs in both environments (v1.0.6)

`js-function` and `nodejs` share one controlled baseline. There is exactly **one**
implementation of each — the same code serves both sandboxes (`sandbox-net.ts`,
`sandbox-interactive.ts`), so the two environments cannot drift.

### fetch — the controlled network client

`await fetch(url, init?)` is available in both environments. It is a real HTTP client,
but every request passes through `policyFetch` (`src/lib/nexool/tools/sandbox-net.ts`),
the single networking layer of the runtime:

| Policy | Value | Behavior when violated |
| --- | --- | --- |
| Protocols | `http` and `https` only | `PROTOCOL_BLOCKED` |
| Hosts | localhost, link-local, private ranges (10/8, 127/8, 172.16/12, 192.168/16, 169.254/16, CGNAT), cloud metadata hosts are denied | `HOST_BLOCKED` |
| Request timeout | 10 s | `TIMEOUT` |
| Response size | 1 MiB cap (body read incrementally, aborted past the cap) | `RESPONSE_TOO_LARGE` |
| Redirects | max 3 — **every hop is re-validated** against the same policy | `REDIRECT_LIMIT` |
| Request count | max 10 per tool execution | `REQUEST_LIMIT` |

Rejections throw a `NetworkPolicyError` whose stable `code` (`INVALID_URL`,
`PROTOCOL_BLOCKED`, `HOST_BLOCKED`, `REQUEST_LIMIT`, `RESPONSE_TOO_LARGE`,
`REDIRECT_LIMIT`, `TIMEOUT`, `NETWORK_ERROR`) is surfaced to tool authors — a tool can
catch and branch on it. `GET/POST/PUT/PATCH/DELETE`, request `headers`/`body`, and the
`Response` surface (`status`, `statusText`, `.json()`, `.text()`) work as usual. See the
[network policy section](#network-policy-v106) below.

### XMLHttpRequest — a real implementation

`new XMLHttpRequest()` exists in both environments and is **not** a stub: it is a full
async XHR implementation layered over the same `policyFetch` (same policy, same request
accounting). Supported: `open()` / `setRequestHeader()` / `send()` / `abort()`,
`readyState`, `status`, `statusText`, `responseText`, `response`,
`onreadystatechange` / `onload` / `onerror` / `onabort` / `ontimeout`,
`getAllResponseHeaders()` / `getResponseHeader()`, and `responseType` `'' | 'text' |
'json'`.

Honest limitation: **async only** — `open(method, url, false)` (sync mode) is rejected
with a clear error. Sync XHR cannot be implemented honestly on top of the async policy
layer, so NexTool rejects it instead of faking it.

### alert(message), prompt(message, defaultValue?) and confirm(message) — runtime interaction

These are **NexTool runtime functions**, not the browser's blocking dialogs:

```js
await alert('Server recovery completed.');      // → emits tool.user_alert, resolves immediately
const name = await prompt('Enter the server:'); // → PAUSES this tool until answered
const ok = await confirm('Delete the files?');  // → v1.0.8: PAUSES this tool, ALWAYS boolean
```

| Function | Behavior | Events |
| --- | --- | --- |
| `await alert(message)` | Emits a `tool.user_alert` runtime event (visible in Task Preview / Live Monitor / Events) and resolves immediately. Message ≤ 2000 chars. | `tool.user_alert` |
| `await prompt(message, defaultValue?)` | Registers a pending prompt and pauses **only this tool** — the task loop, scheduler and other tools keep running. Resolves with the user's answer (≤ 4000 chars), `null` on cancel, or `null` after the **120 s timeout**. Message ≤ 2000 chars. | `tool.user_prompt.requested` → `tool.user_prompt.responded` |
| `await confirm(message, options?)` **v1.0.8** | Registers a pending confirmation, shows the NexTool confirmation UI and pauses **only this tool**. **ALWAYS resolves to a boolean** — never `"yes"`/`"no"` strings. Cancellation, task stop or the **120 s timeout** resolve **`false`** (an unresolved confirmation is never treated as true). Optional `{ default?: boolean }` is the TEST-mode answer. | `tool.confirm.requested` → `tool.confirm.responded` |

While a prompt/confirm waits, the tool's execution deadline is **deferred** (neither the
sandbox watchdog nor the executor timeout kills a legitimately waiting tool) and the full
budget is **reset** once the interaction completes. The runtime is never frozen: at most
this one Promise pends. The console UI renders pending prompts as answer/cancel cards and
pending confirmations as **Confirm/Cancel cards** in Task Preview and Live Monitor; they
are resolved through `POST /api/prompts` and `POST /api/confirmations`. Stopping the task
flushes pending prompts with `null` and pending confirmations with **`false`**.

**Test mode honesty**: in Tool IDE "Test Tool" runs (`context.mode: 'test'`), `alert`
resolves immediately, `prompt` resolves with its default value (or `null`) and `confirm`
resolves with its declared default (or the conservative `false`) — tests never hang
waiting for interactive input that nobody can answer.

### Standard globals

Both environments expose the standard JavaScript globals tool authors expect:
`Math`, `Object`, `Array`, `String`, `Number`, `Boolean`, `Date`, `RegExp`, `JSON`,
`Promise`, `Map`, `Set`, `WeakMap`, `WeakSet`, `URL`, `URLSearchParams`, `console`,
`Error`/`TypeError`/`RangeError`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`,
`structuredClone`, `TextEncoder`, `TextDecoder`, `atob`/`btoa` — plus
`setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` (deadline-bounded: the overall
execution timeout still applies to timer chains). `nodejs` additionally exposes `Buffer`
and the `process`-free global surface listed below.

## The js-function sandbox contract

`js-function` remains a lightweight restricted runtime (`node:vm` sandbox). The sandbox
global contains what is listed here — and, since v1.0.6, the common controlled APIs
above. Still absent by design: `process`, `Buffer`, Node modules (below) and any host
escape hatch.

| Available | Details |
| --- | --- |
| `params`, `context` | As tabled above (params are JSON-cloned before the run). |
| `console.log/warn/error/info` | All routed to the capped log buffer. |
| ES builtins | `JSON`, `Math`, `Date`, `Number`, `String`, `Boolean`, `Array`, `Object`, `RegExp`, `Error`/`TypeError`/`RangeError`, `Map`, `Set`, `WeakMap`, `WeakSet`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `Promise`, `structuredClone`. |
| `fetch`, `XMLHttpRequest` | The controlled network layer (v1.0.6 — see above). |
| `alert`, `prompt` | NexTool runtime interaction functions (v1.0.6 — see above). |
| Timers | `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` — deadline-bounded (v1.0.6). |
| `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams`, `atob`, `btoa` | Standard helpers (v1.0.6). |
| `require()` | **Narrow by design (v1.0.6)**: resolves **virtual-filesystem modules only** — relative/absolute specifiers load `.js`/`.mjs`/`.json` files from the tool's VFS workspace. Node module specifiers fail with `Module "x" is not available in the js-function environment — it is a lightweight restricted runtime. Use the nodejs environment for allowlisted Node.js modules.` |

### Limits and error codes

| Limit | Value |
| --- | --- |
| Function source length | ≤ 64 000 chars (enforced at save and at run). |
| Sync execution | Capped at 4 s by the `node:vm` script timeout — **enforced at function invocation** (v1.0.5), so a no-`await` runaway loop is bounded without freezing the host event loop. |
| Async execution (whole run) | Capped at 10 s (`TIMEOUT` abort); the deadline is deferred while `prompt()` legitimately waits and reset after. |
| Result size | ≤ 64 KiB serialized. |
| Result depth | ≤ 12 (BigInt/function/symbol/circular results are rejected). |
| Log buffer | 100 lines × 2000 chars. |
| Network | 10 requests per execution, 10 s timeout each, 1 MiB response cap (see above). |
| Test context | 10 s timeout; tests never mutate task state. |

| Error code | Meaning |
| --- | --- |
| `SYNTAX_ERROR` | Source does not compile. |
| `INVALID_FUNCTION` | Source compiled to something that is not callable. |
| `TIMEOUT` | Run exceeded 10 s. |
| `NOT_SERIALIZABLE` | Result violates the serialization contract (message says why). |
| `SANDBOX_ERROR` | Sandbox could not be created. |
| `TOOL_FAILURE` | The function threw (message is the thrown error — including `NetworkPolicyError`, `VirtualFSAccessError`, `ChildProcessPolicyError`). |

## The nodejs environment — restricted, virtualized Node.js

A `nodejs` tool is the same `execute(params, context)` function, compiled inside a
contextified `node:vm` sandbox (`src/lib/nexool/tools/node-runner.ts`). `require(id)` /
`await import(id)` resolve through ONE centralized import resolver
(`src/lib/nexool/tools/import-resolver.ts`) over exactly three sources: the static
allowlist, context-provided **virtual modules** (built per execution around the tool's
own VFS/network/interaction layers), and files inside the tool's Virtual FS. There is no
path that resolves anything else.

### Static module allowlist (unchanged since v1.0.5)

`require('crypto')`, `require('node:crypto')` (the `node:`-prefixed form resolves through
the same list) and `await import('crypto')` all work for exactly these modules:

| Module | What it is for |
| --- | --- |
| `buffer` | Buffer class for binary data (also available as a global). |
| `crypto` | Hashes, HMACs, random bytes, UUIDs and other cryptography primitives. |
| `events` | EventEmitter for event-driven tool logic. |
| `path` | Path string utilities (pure string manipulation — works on virtual paths). |
| `querystring` | URL query string parsing and formatting. |
| `string_decoder` | Stateful buffer → string decoding that respects multi-byte characters. |
| `url` | URL parsing and formatting (legacy API on top of the global URL). |
| `util` | Formatting, type checks and promise utilities. |
| `assert` | Assertion helpers for validating tool assumptions. |
| `zlib` | Compression (gzip/deflate/brotli) for data-processing tools. |

### Context-provided virtual modules (v1.0.6)

These entries are **virtual**: no host module is ever handed to tool code. Each is built
per execution around the sandbox context — the tool's VFS workspace, the network
accounting, the interaction layer:

| Module | What it really is |
| --- | --- |
| `fs` | The **NexTool Virtual File System** — per-tool isolated workspace (`/input /output /tmp /data /workspace`). Never the host filesystem. See the [VFS guide](#the-virtual-file-system-v106). |
| `os` | Virtualized OS surface with fixed sandbox values: `platform()` → `'nextool-virtual'`, `hostname()` → `'nextool-sandbox'`, `tmpdir()` → `'/tmp'`, `arch()` → `'x64'`, plus `EOL`, `type`, `release`, `cpus`, `totalmem`/`freemem` (reported as the 256 MiB limit), `userInfo`, `loadavg`. No host introspection. |
| `timers` | `setTimeout` / `clearTimeout` / `setInterval` / `clearInterval` / `setImmediate` / `clearImmediate` — bounded by the tool execution deadline. |
| `timers/promises` | Promise-based `setTimeout` / `setImmediate` (`setInterval` throws — the deadline would abort it anyway). |
| `http` | Controlled HTTP client — `request`/`get` routed through the same network policy as `fetch` (protocol/host/timeout/size/redirect/request-count). |
| `https` | The same controlled client for https URLs. |
| `child_process` | RESTRICTED virtual command layer (`exec`, `execSync`, `execFile`, `spawn`, `spawnSync`) executing documented commands **against the VFS workspace**. No real host process is ever spawned. See the [virtual child_process guide](#virtual-childprocess-v106). |

### Deliberately blocked modules

| Module | Why it is never allowed |
| --- | --- |
| `cluster` | multi-process execution is never allowed |
| `vm` | creating further sandboxes is never allowed |
| `worker_threads` | thread execution is never allowed |
| `net` | raw network sockets are never allowed — use the controlled http/https/fetch layer |
| `dgram` | raw network sockets are never allowed |
| `dns` | DNS resolution is not exposed — resolve through the controlled network layer |
| `process` | process manipulation is never allowed |
| `perf_hooks` | performance introspection of the host process is never allowed |
| `inspector` | debugger access is never allowed |
| `module` | module system introspection is never allowed |
| `async_hooks` | host async context introspection is never allowed |

Note the v1.0.6 change of shape: `fs`, `os`, `http`, `https` and `child_process` moved
from "blocked" to "virtual" (they used to fail with the blocked-module wording in
v1.0.5) — but each of them is a restricted implementation, not the host module.

**Non-allowed modules fail** with a pointed error (the wording to expect in test runs and
`TOOL_FAILURE` observations):

```
Module "x" is not available in the NexTool Node.js environment (reason).
```

Unknown names append the allowed list; deliberately blocked ones append the reason.

### Globals inside the nodejs sandbox

| Global | Type / notes |
| --- | --- |
| `params`, `context` | Same contract as `js-function` (params are JSON-cloned). |
| `console.log/warn/error/info` | Routed to the capped log buffer (100 lines × 2000 chars), shown in the test panel. |
| `fetch` | Controlled fetch — the NexTool network policy (see above). |
| `XMLHttpRequest` | Real async XHR over the same network policy. |
| `alert`, `prompt` | NexTool runtime interaction functions (120 s prompt timeout, tool-only pause). |
| Timers | `setTimeout` / `setInterval` — the overall execution deadline still applies. |
| `Buffer` | Binary data constructor (from the allowlisted `buffer` module). |
| `TextEncoder`, `TextDecoder` | UTF-8 conversion. |
| `URL`, `URLSearchParams` | URL parsing and query handling. |
| `atob`, `btoa` | Base64 decoding/encoding. |
| `structuredClone` | Structured deep clone. |

**Not available:** `process`, and every module outside the allowlist + virtual set. As
with `js-function` this is a documented limitation, not a bug.

### Node.js execution limits

| Limit | Value |
| --- | --- |
| Function source length | ≤ 64 000 chars (validated at save and at run). |
| Sync execution | Capped at 4 s by the `vm` timeout — enforced at the function **invocation**, so a no-`await` infinite loop is stopped (`TIMEOUT`) without blocking the host event loop. |
| Async execution (whole run) | Watchdog caps the run at 10 s (`TIMEOUT` abort) — bounds awaits, import chains and zlib streams; deferred while `prompt()` waits. |
| Heap growth | 256 MiB heap-growth sentinel — the run aborts with `MEMORY` if the process heap grows beyond it while the tool executes. Honest caveat: this is an **in-process guard**, not a container; it aborts the tool result but cannot revoke memory already allocated in the host realm. |
| Result size | ≤ 64 KiB serialized, depth ≤ 12 (same `NOT_SERIALIZABLE` contract as `js-function`). |
| Log buffer | 100 lines × 2000 chars. |

| Error code (nodejs-specific) | Meaning |
| --- | --- |
| `TIMEOUT` | Sync body exceeded 4 s or the run exceeded the 10 s watchdog. |
| `MEMORY` | Heap growth exceeded the 256 MiB sentinel. |
| `TOOL_FAILURE` | The function threw — e.g. `Module "x" is not available in the NexTool Node.js environment (…)`, `NetworkPolicyError`, `VirtualFSAccessError`, `ChildProcessPolicyError`. |

## The Virtual File System (v1.0.6)

`require('fs')` / `import fs from 'fs'` in a `nodejs` tool resolves to the NexTool
**Virtual File System** (`src/lib/nexool/tools/vfs.ts` + `sandbox-fs.ts`) — a real,
persistent filesystem that belongs to the tool runtime, never to the NexTool project or
the host. Storage is the SQLite `VirtualFile` table; tool code has no path to anything
else.

### Lifecycle and isolation

- **Persistent per tool** — each tool owns an isolated workspace (scoped by the tool
  name). Files survive across executions and restarts (they are DB rows).
- **Snapshot + write-through** — each execution loads a workspace snapshot and writes
  through to the database as operations complete.
- **Concurrent executions are last-write-wins** — two simultaneous executions of the
  same tool each write their own snapshot; the last completed write persists. This is
  the documented model — don't rely on read-modify-write across concurrent executions.
- **Tool IDE tests are ephemeral** — "Test Tool" runs get a scratch workspace that is
  wiped after the run, so testing cannot leave state behind (and tests cannot read the
  tool's real persisted files).
- Scaffold directories `/input`, `/output`, `/tmp`, `/data`, `/workspace` exist on
  first use. Relative paths in `require()`/`import()` resolve inside `/workspace`.

### The fs surface

Promise-first, with `fs.promises` mirroring it, `*Sync` helpers, and callback-style
`readFile`/`writeFile` tolerated for older code:

| Operation | Notes |
| --- | --- |
| `readFile`, `readFileSync` | Encoding arg or `Buffer` back. |
| `writeFile`, `appendFile`, `writeFileSync`, `appendFileSync` | Missing parent directories are created implicitly. |
| `mkdir`, `mkdirSync` | `{ recursive: true }` supported. |
| `readdir`, `readdirSync` | Names sorted; `stat`/`lstat` return `{ path, kind, size, createdAt, updatedAt }` (no symlinks exist in the VFS — `lstat` ≡ `stat`). |
| `rename`, `copyFile` (+ `copy` for directories), `unlink`, `rm` | `rm` needs `{ recursive: true }` for non-empty dirs (`ENOTEMPTY` otherwise); the workspace root cannot be removed. |
| `realpath` | Returns the normalized virtual path (throws on traversal). |
| `exists` / `existsSync` | **NexTool extension (honest deviation from Node)** — a promise-returning `fs.exists(path)`; callback form also accepted. |
| `fs.usage()` | **NexTool extension** — `{ usedBytes, files, limits }` against the VFS limits. |

Errors are Node-shaped: `ENOENT`, `EISDIR`, `ENOTEMPTY`, `EEXIST`, `EINVAL` — so existing
tool code that branches on `err.code` keeps working.

### Path safety

Every path is decoded, normalized and validated before use (decode-**before**-validate,
so `%2e%2e`-style encoded traversal is caught). Rejected with
`VirtualFSAccessError: Access to the NexTool host filesystem is not permitted.` (and a
detail suffix): `..` climbing beyond the virtual root, `file:` URLs, backslash paths,
NUL bytes, malformed percent-encoding. There are no symlinks to smuggle escapes through.
Ordinary node-shaped errors (`ENOENT` …) are used for everything that is merely absent.

### VFS limits

| Limit | Value |
| --- | --- |
| Max file size | 512 KiB (also the max read/write size) |
| Max total workspace size | 8 MiB |
| Max entries | 500 per tool |
| Path length | ≤ 512 chars |
| Path depth | ≤ 24 |

Limits are centrally defined (`VFS_LIMITS`) and served verbatim by
`GET /api/tools/environments` (`vfs.limits`).

### VFS example

```js
// nodejs tool — write, read back, import a VFS module
const fs = require('fs');

await fs.writeFile('/data/report.json', JSON.stringify({ ok: true, at: context.now }));
const raw = await fs.readFile('/data/report.json', 'utf8');

// modules can live IN the workspace and be required relatively
await fs.writeFile('/workspace/lib/score.js', 'module.exports.grade = (n) => n >= 90 ? "A" : "B";');
const { grade } = require('./lib/score.js');

return { parsed: JSON.parse(raw), grade: grade(95) };
```

## Virtual child_process (v1.0.6, expanded in v1.0.8)

`require('child_process')` returns a **restricted virtual command layer**
(`src/lib/nexool/tools/virtual-child-process.ts`). There is **no real host process** —
ever. Instead a documented set of common file/text utilities is executed virtually
against the tool's VFS workspace through ONE centralized policy:

```text
Command → tokenizer → Command Resolver (allowlist) → Virtual Runtime → VFS
```

Working directory = the tool's workspace (`/workspace` by default).

### Available commands (v1.0.8)

| Group | Commands |
| --- | --- |
| v1.0.6 (preserved) | `ls` `cat` `head` `tail` `echo` `printf` `pwd` `wc` `grep` `sort` `uniq` `date` `mkdir` `touch` `rm` `cp` `mv` `basename` `dirname` `env` `true` `false` |
| v1.0.8 file/text | `cd` `clear` `find` `tree` `du` `df` `cut` `tr` `sed` `awk` `xargs` `tee` `yes` `sleep` `which` `whoami` `uname` `realpath` `readlink` |
| v1.0.8 runtimes | `node` (sandboxed JS programs inside the VFS) · `npm` (`init` / `install` / `uninstall` / `run` / `test` / `start` / `ls`) |

Subsets implemented honestly: virtual `sed` supports `s/pat/repl/[gi]` and `/pat/d`;
virtual `awk` supports `{print}` / `{print $n}` / `{print NF}` / `{print NR}` /
`{print "text"}` with an optional `/pattern/` prefix and `-F`; `readlink` always
reports `EINVAL` (the VFS has no symlinks); `yes` generates up to the output cap.

### `cd` and the shell session (§3.8/§3.9)

The working directory is **session state that persists across commands within one tool
execution** (§3.9) — `cd project` then `pwd` prints `/workspace/project`. It can never
escape the VFS (§3.8): `cd ..` at the root stays at the root and traversal beyond it is
rejected. `exec(cmd, { cwd })` overrides the directory for one call without changing the
session.

### `node` (§3.3)

`node <script.js>` (and `node -e "<code>"`) executes the program **inside the NexTool
sandbox**: a `node:vm` context whose `fs` is the Virtual FS, whose `fetch` is the
controlled network layer, and which inherits the execution limits (sync cap, output cap,
per-command deadline). `require()` inside the program resolves VFS files, workspace
`node_modules` (from the requiring module's directory upward) and a narrow allowlist
(`fs`, `os`, `path`, `timers`, `events`) — never the host filesystem or host process.
Programs that schedule async work are drained under `exec()`/`spawn()`; under
`execSync()` they complete synchronously or report honestly.

### `npm` (§3.4–§3.7)

The virtual npm operates **entirely inside the tool's isolated VFS workspace**:

- `npm init [-y]` writes `package.json` into the workspace.
- `npm install <pkg>` fetches REAL package metadata and tarballs from
  `registry.npmjs.org` **through the network policy** (request accounting, timeout,
  response cap), extracts them into `/workspace/node_modules/<pkg>` and records them in
  `package.json` + a simplified `package-lock.json`. Transitive dependencies are
  installed up to `childProcess.npmMaxPackages`.
- **Lifecycle scripts are NOT auto-executed by `npm install`** (§3.7 — install can never
  become arbitrary code execution). Scripts run only when explicitly invoked
  (`npm run <script>` / `npm test` / `npm start`) and then execute through the SAME
  sandboxed pipeline.
- `npm uninstall`, `npm ls` operate on the workspace state.

The host `node_modules` and NexTool source are structurally unreachable — packages only
ever land in the tool's Virtual FS.

### Policy (all limits resolved from the central limits, §3.15)

| Rule | Value / behavior |
| --- | --- |
| Shell metacharacters | `;` `&&` `\|\|` `` ` `` `$(` `>` `<` `&` are rejected outright (`EBADSHELL`) — exit code **126** |
| Unknown/host commands | exit code **127** with a pointed stderr — no hidden path around the policy (§3.14) |
| Pipes | simple single pipes only, max **3 stages** (`childProcess.maxPipeStages`); beyond → 126 |
| Timeout | **8 s default** per command (`childProcess.timeoutMs`) — the effective tool execution timeout RAISES it; exceeded → exit 124 |
| Output | ≤ **64 KiB** default (`childProcess.maxOutputBytes`) |
| Processes | ≤ **64** per execution (`childProcess.maxProcessesPerExecution`, raised from 4 in v1.0.8) |
| Arguments | ≤ **32** per command (`childProcess.maxArgs`) |
| Working directory | always inside the tool's virtual workspace |

A realistic project workflow works entirely inside the VFS (§3.11/§3.12):

```js
const cp = require('child_process');
await cp.exec('mkdir my-app');       await cp.exec('cd my-app');
await cp.exec('npm init -y');        await cp.exec('mkdir server');
// write server/index.js via fs, then:
await cp.exec('npm install express-mini');
await cp.exec('node server/index.js'); // runs INSIDE the sandbox, deps from VFS node_modules
```

### API subset

`exec`, `execSync`, `execFile`, `spawn`, `spawnSync` — every process-creation path
enforces the identical policy (async forms preferred; there is no callback that bypasses
the tokenizer/policy):

```js
const cp = require('child_process');
const { exec } = cp;

const r1 = await new Promise((res, rej) =>
  exec('ls /data', (err, stdout) => err ? rej(err) : res(stdout)));
// "cat report.txt | grep error | wc -l" works — 3 stages, VFS files only
// "rm -rf /" is not special: /workspace-relative, VFS-only, policy-checked
```

## The import resolver (v1.0.6)

`require()` and `import()` (static and dynamic) resolve through **one centralized
resolver** (`src/lib/nexool/tools/import-resolver.ts`) in both environments — there is
no second, incompatible resolver:

1. **Allowlisted Node modules** → static objects (with `node:` prefix normalization).
2. **Virtual modules** → the context-provided `fs`/`os`/`timers`/`http`/`https`/
   `child_process` implementations (nodejs environment only; `js-function` rejects
   bare specifiers).
3. **VFS modules** → relative/absolute specifiers (`./`, `../`, `/`) resolve inside the
   tool's workspace: `.js`, `.mjs`, `.json` (JSON parses; extension probing is applied
   when the specifier has none). VFS modules run CommonJS, plus a **conservative ESM
   transform**: `export default …`, `export const/let/var …`, `export function|class …`
   and `export { a, b as c }` are rewritten to CommonJS assignments (`module.exports`);
   anything beyond that shape is not transformed — keep VFS modules simple.
4. **URL imports** — **v1.0.8: ENABLED by default** through the central network policy
   (`network.allowUrlImports`; set it to `false` in `config/configuration-limits.json` to
   disable without code changes). URL imports are REAL network fetches that pass the full
   policy — protocol (http/https only; `file:`/`data:`/`node:` are rejected), host
   policy, `network.timeoutMs`, `network.maxResponseBytes` (the module size cap — the
   separate v1.0.6 256 KiB limit was removed), `network.maxRedirects` and
   `network.maxRequestsPerExecution`. The policy is checked BEFORE the module cache: a
   URL that is blocked right now can never be satisfied from a stale cached module
   (§2.6). Downloaded modules execute under the SAME sandbox boundary as the importing
   tool — their `require()` goes through the importing environment's resolver, so a URL
   module never gains host filesystem, process or child-process access (§2.4).
   Supported export shapes: CommonJS `module.exports`, plus the conservative ESM
   transform (`export default`, named exports) — `default`, `named` and multiple exports
   work where compatible with the loader (§2.3).

Dynamic `import()` call sites are rewritten at compile time to an internal shim (same
mechanism as v1.0.5 — string/comment/regex-aware, no host vm flags needed), so
`await import('./lib/score.js')` in a VFS module or `await import('crypto')` in the
tool body behave exactly like their `require()` equivalents.

## Network policy (v1.0.6)

One policy, three consumers: `fetch`, `XMLHttpRequest` and the virtual
`http`/`https` modules all route through `policyFetch`
(`src/lib/nexool/tools/sandbox-net.ts`). The policy is centralized
(`NETWORK_POLICY`) and served verbatim by `GET /api/tools/environments`
(`network`): http/https only · 10 s request timeout · 1 MiB response cap ·
max 3 redirects (each hop re-validated) · max 10 requests per tool execution ·
URL imports disabled. Localhost, private ranges, link-local (incl. cloud metadata
`169.254.x.x`) and internal hosts are denied with `HOST_BLOCKED`. There is no second
fetch path and no configuration that turns the policy off.

## The Tool IDE

The editor is organized into explicit sections; on mobile they become tabs
(**Details / Schema / Function·Handler / References / Test** — see
[Mobile](mobile.md#v105-mobile-refinements)), on desktop the layout splits into a
left rail and a main pane.

- **General** — name (`namespace.action`), description, purpose, category, tool version,
  enabled switch — structured inputs, never raw JSON. v1.0.6 adds the **Auto-Execute
  Tools** switch here (the per-tool `autoExecute` flag; default off = approval required,
  see [Tool Runtime](tool-runtime.md#the-approval-gate-v106)).
- **Execution environment** (v1.0.5) — the selector `js-function | nodejs | dynamic`,
  with the description of the selected environment rendered underneath. The options are
  the **authorable** entries of the real runtime registry
  (`GET /api/tools/environments`); builtin/virtual-env tools never reach this editor
  (read-only). A stored `dynamic` tool is locked to dynamic — "duplicate into a function
  tool to change environment".
- **Metadata** (v1.0.5) — structured key/value **rows** with add/remove/edit; this is not
  a raw JSON box. Values are strings (a flat `Record<string, string>` on the
  ToolDefinition), keys must be non-empty, and at most **50 pairs** are accepted.
  Metadata round-trips through save, update, export and import (see [Tools](tools.md)).
- **Tool schema** (v1.0.5) — two views over one schema: a **structured form editor**
  (one row per param: name, type, required, description, enum values — add/remove rows)
  and a **JSON view** (the same schema as editable JSON). Both stay consistent; the
  schema is validated before save (≤ 40 params, known types, non-empty names).
- **Function** — the code editor with a **Monaco ⇄ textarea toggle** (v1.0.5,
  *Use Monaco Editor*, default **ON**). Both editors share one source of truth: switching
  captures the exact visible code into the shared state, so **code is preserved when
  switching** in either direction, and Save/Test behave identically in either mode.
  Monaco keeps the custom `nextool-dark` theme, schema-driven `params` IntelliSense and
  runtime declarations; in a `nodejs` session the declarations extend to
  `require()`/`import()` overloads built from the **live allowlist + virtual modules**
  plus the sandbox globals — IntelliSense knows exactly what the runtime accepts,
  nothing more. Dynamic tools show a **Handler** pane instead of code (see below).
- **References** — the human-readable sandbox API: the shared runtime contract
  (`params`, `context`, `log`, globals) plus the environment's module surface. In a
  `nodejs` session (v1.0.6) the panel also shows the **VFS limits**, the **virtual
  child_process commands** and the **network policy** — all served by
  `GET /api/tools/environments` (`vfs`, `childProcess`, `network`, `capabilities`).
  The editor help and the sandbox contents cannot drift apart, because both come from
  one source.
- **Capability matrix** (v1.0.6) — the References area renders the `capabilities`
  table from `GET /api/tools/environments` (capability × `jsFunction` × `nodejs`) so
  authors can compare the two environments at a glance, straight from the runtime.
- **Test** — runs the tool against the real sandbox with your test params JSON (see the
  worked examples below). v1.0.6: tests get an **ephemeral scratch VFS workspace**
  (wiped after the run), and interactive functions are honest in test mode — `alert`
  resolves immediately, `prompt` returns its default (or `null`); tests never hang.

### Dynamic handler tools in the IDE

For an environment `dynamic` the editor swaps the code editor for the **handler
configuration**:

- **Handler kind selector** — fed by the real runtime registry
  (`handlerKinds` from `GET /api/tools/environments`): `echo`, `delay`, `http_get`,
  `uuid`, each with its label and description. Registration with an unknown kind is
  rejected by the backend.
- **Structured config** — the selected kind's `configFields` render as proper form
  fields. `http_get` exposes exactly two: **url** (required, absolute http(s) URL
  fetched when the tool executes) and **timeout** (ms, clamped 1000–15000,
  default 8000). Required fields block save with a visible message.

The registry-level handler behaviors are documented in
[Tools](tools.md#the-four-dynamic-handler-kinds).

## Editor source-sync guarantees (v1.0.5)

The editor's write/read paths are guarded by pure helpers (`src/lib/nexool/editor-source.ts`,
unit-tested in `tests/nextool-v105.test.ts`), so the historical "Test blanked my editor"
failure class is closed by construction:

- **Test reads the CURRENT editor code** — the run uses exactly what is on screen
  (Monaco model while mounted; the shared source state otherwise, e.g. in textarea
  mode or after a mobile tab switch disposes the editor).
- **Unsaved code survives testing** — the test request carries a copy; nothing writes
  back into the editor on test success **or failure**.
- **A non-edit `onChange` can never clear the code** — editor model swaps/remounts can
  fire `onChange` with `undefined`/`null`; these are coerced to the previous value. Only
  a genuine user clearing (empty string) empties the editor.
- **A disposed editor is never trusted** — reading a dead Monaco model throws; the
  shared source state (kept in sync) is the fallback.
- **Switching tools loads the stored source** — the IDE remounts per session, so every
  session initializes from the freshly loaded definition (`GET /api/tools/{name}`),
  never from the previous tool's state.

## Worked example 1 — a `js-function` tool with fetch + alert/prompt

**Schema**: one param `url` (string, required, extractive, "Status endpoint to check").

**Function source** (plain body form):

```js
// ops.statuscheck — fetch a status endpoint, ask the operator when it is degraded
const url = typeof params.url === 'string' ? params.url : '';
context.log('checking', url);

const response = await fetch(url, { method: 'GET' });   // policy-controlled
const body = await response.text();

if (response.status >= 500) {
  await alert(`Status endpoint ${url} returned ${response.status}`); // runtime event
  const note = await prompt('Add a note for the operator?', 'investigate'); // pauses THIS tool
  return { status: response.status, degraded: true, note };
}

return { status: response.status, ok: response.status < 400, bytes: body.length };
```

What happens at run time (production): the fetch passes the network policy (public host,
http/https, ≤ 1 MiB, ≤ 10 s, counted against 10 requests); `alert` emits
`tool.user_alert` and resolves; `prompt` emits `tool.user_prompt.requested` and pauses
**this tool only** — the task loop keeps running — until someone answers the prompt card
in Task Preview / Live Monitor, cancels it, or 120 s elapse (→ `null`). The tool's
deadline is deferred while waiting.

**Test it before saving** — in test mode the prompt returns its default immediately:

```bash
curl -X POST http://localhost:3000/api/tools/test -H 'Content-Type: application/json' \
  -d '{
    "functionSource": "const r = await fetch(params.url); return { status: r.status };",
    "params": { "url": "https://example.com/healthz" }
  }'
```

**Save (register)** — `POST /api/tools/js` with `"environment": "js-function"` (the
default) and the source above; flip **Auto-Execute Tools** off (or leave the default) if
every run should require an explicit Allow (see
[Tool Runtime](tool-runtime.md#the-approval-gate-v106)).

## Worked example 2 — a `nodejs` tool with fs + child_process + a VFS import

**Schema**: one param `dataset` (string, required, extractive, "VFS file to analyze").

**Function source**:

```js
// data.audit — audit a CSV in the VFS using virtual shell + an imported VFS module
const fs = require('fs');
const cp = require('child_process');

const path = '/data/' + String(params.dataset || 'input.csv');
if (!(await fs.exists(path))) {
  return { error: 'ENOENT', path, usage: fs.usage() };  // NexTool extension: usage()
}

// 1) virtual shell pipeline over VFS files (3 stages max, ≤ 8 s, ≤ 64 KiB out)
//    NOTE: redirections ('<' / '>') and metacharacters are rejected by the policy —
//    use plain commands or pipes only.
const stat = await fs.stat(path); // { path, kind, size, createdAt, updatedAt }
const count = await new Promise((res, rej) =>
  cp.exec(`grep -c ',' ${path}`, (err, stdout) => err ? rej(err) : res(stdout.trim())));

// 2) import a module that lives IN the workspace
const summary = await import('/workspace/lib/summary.mjs');   // export default allowed
const parsed = await summary.default({ bytes: stat.size, lines: count });

await fs.appendFile('/output/audit.log', `${context.now} ${path} rows=${count}\n`);

return { path, count, parsed, usage: fs.usage() };
```

Return value shape:

```js
const raw = await fs.readFile(path, 'utf8');
const rows = raw.split(/\r?\n/).filter(Boolean).length;   // pure-fs alternative to grep -c
```

Prepare the workspace module first (any earlier execution, or the same tool). Keep VFS
modules pure computation — they receive data as arguments; only the **tool body** (not a
VFS module) can `require('fs')`:

```js
await fs.mkdir('/workspace/lib', { recursive: true });
await fs.writeFile('/workspace/lib/summary.mjs',
  'export default function summarize({ bytes, lines }) {\n' +
  '  return { bytes, lines, avgLineLen: lines ? Math.round(bytes / lines) : 0 };\n' +
  '}');
```

Behavior notes: `require('fs')` is the VFS — `/data` is the tool's own persistent
workspace, not the host; `cp.exec` runs a virtual `grep` against that workspace (no
process, no host shell); `await import('/workspace/lib/summary.mjs')` resolves through
the centralized resolver's ESM transform; escape attempts like
`fs.readFile('/workspace/../../../.env')` fail with `VirtualFSAccessError`. Every
task-driven execution of this tool first passes the approval gate unless an override
applies.

## Editing, renaming, duplicating

- **Edit** re-opens the saved source (loaded via `GET /api/tools/{name}`); saving an
  edit issues `PUT /api/tools/{name}` (partial update: description, category, schema,
  `functionSource`, `toolVersion`, `enabled`, and `name` itself for renaming — plus the
  v1.0.5 fields `environment` (js-function ⇄ nodejs switch), `metadata` and the dynamic
  `handlerKind`/`handlerConfig`, and the v1.0.6 `autoExecute` flag). Switching between
  tools remounts the editor view (per-session key), so every session initializes its
  state from the freshly loaded definition — no carry-over of the previous tool's code
  or schema.
- **Rename** is a real registry operation — executions already in flight keep their
  resolved handler; the next decision uses the new name.
- **Duplicate** (v1.0.4 — non-destructive) — the in-editor **Duplicate** button
  switches the session into *register-a-copy* mode: the target name resets to
  `namespace.copy`, the session becomes a "new tool" session, and the copy keeps the
  **exact** function code + schema + metadata of the original. **Save** then calls the
  register endpoint (`POST /api/tools/js`) and creates a NEW tool — the original is
  never renamed or overwritten. The Tools-grid **Duplicate** action uses the same
  flow (it opens the editor prefilled as a copy under `<namespace>.copy`).
- `GET /api/tools/{name}` returns the full entry including `functionSource` (and
  `metadata`) — the IDE loads the editor content from it.
- **Export / import** — tools (including this exact source, the environment, the
  metadata and the `autoExecute` flag) can be downloaded as portable JSON and imported
  into another registry; see [Tools](tools.md#tool-export--import-as-json-v104).

## Debugging checklist

1. **Syntax error on save** — the server compiles the source with the same wrapper the
   runner uses; the error message quotes the compile failure.
2. **Test fails with `TIMEOUT`** — an `await` that never settles (an accidental
   `new Promise(resolve => setTimeout(resolve))` hangs until the 10 s cap). A no-`await`
   infinite loop is stopped by the 4 s invocation-level sync cap (v1.0.5).
3. **`Module "x" is not available in the NexTool Node.js environment (…)`** — expected
   for anything outside the allowlist + virtual set (see the tables above). Keep the
   module logic inside the allowed modules or move the capability into a dynamic
   handler/built-in. In a `js-function` tool, Node module specifiers fail with the
   js-function wording — only VFS modules resolve there.
4. **`NetworkPolicyError: HOST_BLOCKED / PROTOCOL_BLOCKED / REQUEST_LIMIT …`** — the
   network policy rejected the request (private/localhost host, non-http(s) protocol,
   > 10 requests per execution, …). This is by design — see the network policy section.
5. **`VirtualFSAccessError: Access to the NexTool host filesystem is not permitted.`** —
   the tool tried to escape its virtual workspace (encoded traversal, `..` beyond the
   root, `file:` URLs, backslash paths). By design; fix the path.
6. **`child_process` exit 126 / 127** — 126 = shell metacharacter or policy limit
   (pipes/args/processes); 127 = unknown command. Only the documented virtual commands
   exist, and only simple single-pipe pipelines run.
7. **`NOT_SERIALIZABLE`** — you returned a `Map`, `Set`, function or BigInt. Convert to
   plain objects/arrays/strings first (`Object.fromEntries`, `Array.from`, `String(...)`).
8. **`MEMORY` (nodejs)** — the tool grew the heap beyond the 256 MiB sentinel; stream or
   chunk the work instead of materializing it.
9. **Wrong values in production** — remember CoreModule extracts `extractive` params
   verbatim from the request; mark a param `constructive` only when the model should
   craft the content (see [Tools](tools.md#parameter-generation-extractive-vs-constructive)).
10. **Tool not selected** — check the description (it feeds matching), confirm the tool
    is enabled, and watch the `core.decision` event for the reason.
