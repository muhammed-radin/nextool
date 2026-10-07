---
title: Tools
category: Tools
order: 1
---

# Tools — writing and registering tools

Everything the runtime can *do* is a tool. This page documents the `ToolDefinition`
schema, parameter generation rules, the registration paths (built-in code, the
`/api/tools/register` endpoint and the Tool IDE function-tool path), the four dynamic
handler kinds, and a complete working example. The tool authoring workflow (Tool IDE,
`js-function`/`nodejs` sandbox contracts, testing, debugging) has its own page:
[Tool Development](tool-development.md).

## ToolDefinition schema

```ts
interface ToolDefinition {
  name: string;              // "namespace.action", lowercase; regex ^[a-z][a-z0-9_.-]*\.[a-z][a-z0-9_.-]*$
  description: string;       // what it does — feeds matching + prompts
  purpose?: string;          // why it exists (prompt context)
  category: string;          // monitoring | automation | content | utility | memory | notification | general …
  environment: 'builtin' | 'virtual-env' | 'dynamic' | 'js-function' | 'nodejs' | 'freedom-node';
  // v1.0.2: js-function · v1.0.5: nodejs (restricted Node.js environment)
  // v1.0.11: freedom-node (INTENTIONALLY unrestricted — configuration-gated)
  schema: {
    type: 'object';
    properties: ToolParamDef[];
  };
  handlerKind?: 'echo' | 'delay' | 'http_get' | 'uuid';   // dynamic tools only
  handlerConfig?: Record<string, unknown>;                // dynamic tools only
  functionSource?: string;   // js-function AND nodejs tools (≤ 64 000 chars)
  toolVersion?: string;      // user-facing version string, free form
  metadata?: Record<string, string>;   // v1.0.5: flat string key/value pairs, ≤ 50
  autoExecute?: boolean;     // v1.0.6: false (default) → tool execution requires approval
  timeoutMs?: number;        // v1.0.7: tool-specific execution timeout (ms, 1000–3600000)
}                            //         undefined → global default 10000; runtime caps at 1 h

interface ToolParamDef {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  description: string;
  generation?: 'extractive' | 'constructive';
  enumValues?: string[];
  min?: number;
  max?: number;
  default?: unknown;
}
```

The 15 built-in tools (seeded into `ToolRecord` on first registry access) follow this
contract — `server.*` are `virtual-env`, the rest `builtin`. Browse them with
`GET /api/tools` or the Tools view, which renders each param's type, required flag,
generation and enum chips.

## The Tool IDE and the function-tool environments (v1.0.2 / v1.0.5 / v1.0.6)

**Tools → New Tool / Edit** opens the in-console Tool IDE: a Monaco JavaScript editor
(custom `nextool-dark` theme, with a v1.0.5 **textarea toggle**), a schema editor
(structured form + JSON view since v1.0.5), schema-driven IntelliSense, a References
pane showing the real sandbox API, and a **Test Tool** panel that runs the actual
sandbox. A tool authored here has `environment: 'js-function'` — or, since v1.0.5,
`environment: 'nodejs'` — and its body is a single
`async function execute(params, context) { …; return value; }`.

- **js-function** execution happens in a hardened `node:vm` sandbox
  (`src/lib/nexool/tools/js-runner.ts`) exposing `params`,
  `context {executionId, taskId, mode, now, log}`, `console` (capped 100 lines), ES
  builtins — and, since v1.0.6, the common controlled APIs: policy-gated `fetch`, a
  real async `XMLHttpRequest`, async `alert`/`prompt`, and deadline-bounded timers.
  `require()` resolves **virtual-workspace (VFS) modules only**. No `process`, no Node
  modules.
- **nodejs** (v1.0.5, expanded v1.0.6) is a restricted Node.js environment with the
  SAME execute contract: the static module allowlist (`buffer`, `crypto`, `events`,
  `path`, `querystring`, `string_decoder`, `url`, `util`, `assert`, `zlib`) plus the
  v1.0.6 context-provided virtual modules — `fs` (the Virtual FS), `os`
  (virtualized values), `timers`/`timers/promises`, `http`/`https` (controlled network
  client) and a restricted virtual `child_process`. Full module tables, VFS guide,
  command policy and limits:
  [Tool Development](tool-development.md#the-nodejs-environment--restricted-virtualized-nodejs).
- **freedom-node** (**v1.0.11**) is an INTENTIONALLY UNRESTRICTED Node.js environment:
  real `require()`/`import()` (Node builtins `fs`/`path`/`os`/`child_process`/`process`/
  streams + installed npm packages), the REAL host filesystem (never redirected into the
  VFS), the real global `fetch` with NO Network Policy caps, and the real `process`
  (incl. `process.env`) and `Buffer`. It is gated ONLY by the central `fs` section of
  `config/configuration-limits.json` — configuration-file gate, fail closed
  (`FREEDOM_DISABLED` when closed); the Settings UI deliberately has no control for it.
  Full contract, security implications and the preserved task-lifecycle limits:
  [Tool Development → The freedom-node environment](tool-development.md#the-freedom-node-environment--intentionally-unrestricted-v1011)
  and [Security](security.md).
- The **Execution environment** selector offers `js-function | nodejs | dynamic |
  freedom-node` from the real runtime registry (`GET /api/tools/environments`); dynamic
  tools are locked to dynamic in the editor. Choosing freedom-node shows the exact
  warning: *"freedom-node — Full host Node.js access. File system, network, processes,
  and host-level capabilities may be available."*
- **Metadata** (v1.0.5) — structured key/value rows (strings only, ≤ 50 pairs),
  stored on the ToolDefinition and round-tripped through export/import.
- **Auto-Execute switch** (v1.0.6, General section) — the per-tool `autoExecute` flag.
  Default **off = approval required**: when the runtime calls this tool inside a task
  it first emits `tool.approval.required` and waits for an Allow/Deny decision (or a
  global/task override). Persisted with the tool; round-trips export/import. See
  [Tool Runtime](tool-runtime.md#the-approval-gate-v106).
- Limits (both function environments): source ≤ 64 000 chars; sync execution capped
  4 s (`vm` timeout — enforced at function invocation since v1.0.5); the whole run
  capped 10 s; results must be JSON-serializable, ≤ 64 KiB, depth ≤ 12. `nodejs` adds
  a 256 MiB heap-growth sentinel. `freedom-node` keeps the execution deadline and sync
  cap but relaxes the sandbox-level result/network caps — its result still travels the
  runtime's JSON transport (5 MiB runtime cap); see
  [Tool Development](tool-development.md#the-freedom-node-environment--intentionally-unrestricted-v1011).
- Full guide with worked examples, limits tables and debugging checklist:
  [Tool Development](tool-development.md).

Grid actions on the Tools view (v1.0.2): **New Tool**, **Edit**, **Duplicate** (built-ins
included — creates an editable `js-function` copy), **Test**, **Enable/Disable**,
**Export** (v1.0.4, per-tool JSON download), and **Delete** (user tools only, behind a
confirm dialog; built-ins are rejected `READ_ONLY`). The header actions dropdown adds
**Import tool (JSON)…** and **Export all tools (JSON)** (v1.0.4).

## Tool export / import as JSON (v1.0.4)

Tools are portable: the exact function source travels with the tool as text, so a
tool can be moved between registries (dev → prod, or between projects) without
retyping code. Everything runs through the **existing** registry endpoints — there are
no new API routes; validation, preview and conflict handling happen client-side in
`src/lib/nexool/tool-portable.ts` + the Tools view.

### Export format

One tool = one JSON file (named `<tool-name>.json`; any characters outside letters,
digits, dots, hyphens and underscores are replaced with `_`):

```jsonc
{
  "nexool": { "kind": "nextool.tool", "version": 1, "appVersion": "1.0.6", "exportedAt": "…" },
  "name": "utility.wordcount",
  "description": "Counts words, characters or lines of a text.",
  "purpose": "…",                     // optional, present when the tool has one
  "category": "utility",
  "environment": "js-function",        // js-function | nodejs | dynamic (v1.0.5: nodejs)
  "toolVersion": "1.0.0",              // optional
  "enabled": true,
  "schema": { "type": "object", "properties": [ /* ToolParamDef[] — the real field names */ ] },
  "functionSource": "async function execute(params, context) { … }",  // EXACT source, as text
  "metadata": { "owner": "platform" }, // v1.0.5 — present when the tool has metadata
  "autoExecute": true,                 // v1.0.6 — present only when true; absent/false → approval required
  "handlerKind": "…",                  // dynamic tools only
  "handlerConfig": { … }               // dynamic tools only
}
```

The `nexool` envelope is advisory metadata (read on import, not enforced).
**Export all tools (JSON)** downloads `nextool-tools-<YYYY-MM-DD>.json` — an array of
these single-tool objects. Since **v1.0.91** that array is a complete round trip: feed
it back to **Import tools (JSON)…** and every tool is validated and restored. The
`{ "tools": [...] }` bundle wrapper stays *export-only*.

### Import workflow (v1.0.4, extended by v1.0.91 — single object OR array)

**Import tools (JSON)…** accepts BOTH a single tool object and a JSON array of tool
objects (the exact shape of *Export all tools*). It runs this pipeline — nothing is
registered until you confirm:

1. **Parse** (`parseToolsImport`) — must be valid JSON; the file shape decides the flow:
   - **JSON object** → single-tool import (the unchanged v1.0.4 behavior).
   - **JSON array** → bulk import (v1.0.91).
   - **Empty array `[]`** → the honest notice *"No tools found in this JSON file."* —
     nothing is registered and no import API call is made.
   - **Parse failure** → *"Invalid JSON file — …"* with the parser's reason; nothing
     is imported (not even partially).
   - The `{ "tools": [...] }` bundle wrapper is rejected with a pointed message
     (export-only contract, unchanged).
2. **Client-side validation** (human-readable errors, shown in a rejection dialog):
   - `name` — required, `namespace.action` regex (lowercase).
   - `description` — required (the CoreModule matches on it).
   - `environment` — must be `js-function`, `nodejs` (both authorable), **`freedom-node`
     (v1.0.11 — also authorable; the environment string round-trips EXACTLY and bulk
     import accepts it)** or `dynamic`; `builtin`/`virtual-env` (read-only registry
     tools) are rejected with a "read-only" message — duplicate them into a function
     tool instead.
   - `functionSource` — required for `js-function` and `nodejs` (v1.0.5), ≤ 64 000
     chars; a warning (not a rejection) fires when no `execute(params, context)`
     definition is visible.
   - `metadata` (v1.0.5) — optional; when present it must be a flat string → string
     object with at most 50 pairs (non-string values are rejected).
   - `schema` — validated against the real param rules (`string|number|boolean|object|
     array` types, `enumValues` must be an array, every param needs a name); a bare
     param array (the register-dialog format) is tolerated.
   - `dynamic` tools require `handlerKind` (`echo|delay|http_get|uuid`) and, when
     present, an object `handlerConfig`.

   For a bulk import **every array item goes through this exact same pipeline
   independently** (`buildBulkImportPlan`) — there is no weaker bulk path.

3. **Validation BEFORE registration** (v1.0.91) — the whole array is validated up
   front; the import never registers the first few tools and then discovers a later
   invalid one.
4. **Preview** —
   - *Single*: name, environment, category, schema param count, description and the
     full function source, plus any warnings, before you choose **Register tool**.
   - *Bulk*: the **Bulk Import Tools** dialog lists every item with `✓`/`✕`, its
     environment/param count (or its first validation error), and the totals
     ("12 tools detected — ✓ 10 valid · ✕ 2 invalid"). Duplicate names inside the
     file are called out explicitly ("Duplicate tool name inside import file:
     `utility.test`").
5. **Conflict handling** — never a silent overwrite:
   - *Single*: if the name already exists a dialog offers **Replace existing tool**
     (`PUT /api/tools/{name}` with the imported definition), **Import as copy** (auto
     non-conflicting name `base.copy`, then `base.copy-2`, `base.copy-3` …) or
     **Cancel**.
   - *Bulk*: every valid item whose name already exists in the registry gets a
     per-row **Replace / Import as copy / Skip** decision in the preview; the safe
     default is **Skip**. Later duplicates within the same file default to **Skip**
     or **Import as copy**. Conflict resolution happens BEFORE any registration.
6. **Registration** via the existing endpoints: `POST /api/tools/js` for
   `js-function`/`nodejs`, `POST /api/tools/register` for `dynamic`. The backend
   re-validates everything (zod + function-source syntax via the sandbox compiler) and
   surfaces `ALREADY_EXISTS` honestly if a race slipped past the conflict check.
   `autoExecute` (v1.0.6) round-trips: imported tools **without** the field default to
   approval-required without invalidating anything else. Invalid items are **never
   registered** — the bulk confirmation button imports only the valid items
   ("Import 10 valid tools"), so a file with 10 valid + 2 invalid entries imports the
   10 and skips the 2 explicitly.
7. **Progress** (v1.0.91) — a bulk import registers one tool at a time with a live
   progress bar (`7 / 10`) and a per-item running status list; the UI never freezes.
8. **Summary** (v1.0.91) — the run ends with **Import complete — Imported: 8 ·
   Skipped: 1 · Failed: 1** plus per-item detail (imported names, skipped names with
   the conflict/duplicate reason, failed names with the registry error).

Imported tools appear in the registry and are fully editable in the Tool IDE (a
function loads into the editor like any other function tool — a `nodejs` tool opens
with the Node.js environment, IntelliSense and References already wired).

## Tool search & filter (v1.0.7)

The Tools view has a prominent, responsive search field (placeholder
`Search tools...`) that filters the registry **live — no page reload**:

- **Fields searched** (where present): tool name, description, purpose, category,
  environment, handler kind, tool version and metadata key/value pairs (tags).
- **Case-insensitive** and whitespace-trimmed; multiple tokens use AND semantics
  (searching `image` matches `image.generate`, `image.edit`, `image.resize`, …).
- On narrow screens the field occupies its own full-width row and never squeezes the
  "New Tool" / overflow controls; a match counter ("3 of 18 tools match") sits beside
  it from `sm:` up.
- No match shows an honest empty state — "No tools found" with a **Clear search**
  button — never a broken layout.

The pure filter implementation lives in `src/lib/nexool/tool-search.ts`
(`filterTools`) and is unit-tested.

## Tool execution timeout (v1.0.7)

Every tool may carry its own execution timeout (`ToolDefinition.timeoutMs`, ms):

- Set it in the **Tool IDE → Execution Environment → "Execution timeout (ms)"**
  (empty = use the global default).
- Valid range **1000–3600000** — the registration/update APIs **reject** anything
  above 1 hour, and the runtime additionally clamps (never bypassable).
- Precedence and propagation are documented in
  [Configuration → Tool execution timeout](configuration.md#tool-execution-timeout-v107):
  global default (10 s) → tool-specific → runtime maximum (1 h).

## Parameter generation: extractive vs constructive

This distinction is load-bearing for CoreModule (see
[CoreModule](../ai-core/core-module.md)):

- **`extractive`** — the value is expected to appear verbatim in the request/context and
  must be copied, not invented. Use it for identifiers, expressions, raw text:
  `serverId`, `expression`, `text`, `message`, `timezone`, `count`, `ms`.
- **`constructive`** — the value must be *regenerated and enriched* from intent, tool
  description, schema and context. Use it when copying the raw sentence would produce a
  poor result: `image.generate.prompt` (the LLM adds lighting/composition/style
  detail), `notification.send.title/body/level`.

Rule of thumb: if the parameter is data the user named → `extractive`; if it is content
the system should craft → `constructive`.

## The four dynamic handler kinds

Dynamic tools cannot ship arbitrary code — they bind to a safe, pre-built handler:

| `handlerKind` | Behavior | Notes |
| --- | --- | --- |
| `echo` | Returns `{ echo: <message param> }` | Requires a `message` param in your schema. |
| `delay` | Waits `ms` (100–10 000, default 1000) → `{ waitedMs }` | Good for testing async behavior and timeouts. |
| `uuid` | Generates `count` UUIDv4s (1–10, default 1) → `{ count, uuids }` | |
| `http_get` | `fetch(handlerConfig.url)` with an `AbortSignal.timeout` → `{ status, body (≤2000 chars) }` | Missing `handlerConfig.url` fails with `INVALID_CONFIG`. Config (v1.0.5): `url` (required) + `timeout` in ms (1000–15000, default 8000) — the Tool IDE renders both as structured fields. |

A dynamic tool **must** declare a valid `handlerKind`; registration without one is
rejected (`INVALID_PARAMS`).

## Registration paths

### 1. Code path (built-ins)

Add a definition to `BUILTIN_TOOLS` in `src/lib/nexool/tools/registry.ts` and a handler
to the `builtinMap` (or a new handler module in `tools/`). Seeding upserts the definition
into SQLite on the next registry access; existing rows get description/category updates
but never lose their stats or enabled flag.

### 2. API path (runtime registration)

```bash
curl -X POST http://localhost:3000/api/tools/register \
  -H 'Content-Type: application/json' \
  -d '{
    "definition": {
      "name": "deploy.status",
      "description": "Echoes the deploy status check for a service.",
      "purpose": "Observe deployment progress.",
      "category": "monitoring",
      "environment": "dynamic",
      "schema": { "type": "object", "properties": [
        { "name": "message", "type": "string", "required": true,
          "description": "Service to check", "generation": "extractive" }
      ]}
    },
    "handlerKind": "echo"
  }'
```

- Validation: definition object required; name regex; dynamic tools require a
  `handlerKind` from the four kinds; duplicate names → `ALREADY_EXISTS` (surfaced as
  400 `REGISTER_FAILED`). `POST /api/tools` behaves identically (the register endpoint
  is an alias).
- The handler is resolved and cached immediately; the tool is created `enabled: true`.
- Toggle any tool with `POST /api/tools/{name}/toggle` `{ "enabled": false }` — name is
  URL-encoded (tool names contain dots). Disabled tools are excluded from the registry
  the loop loads, and the post-decision gate rewrites decisions targeting them into
  `cannot_execute`.

### 3. Tool IDE path (function tools, v1.0.2 / v1.0.5)

```bash
curl -X POST http://localhost:3000/api/tools/js -H 'Content-Type: application/json' \
  -d '{ "name": "utility.wordcount", "description": "…", "category": "utility",
        "environment": "nodejs",
        "metadata": { "owner": "platform" },
        "schema": { "type": "object", "properties": [ … ] },
        "functionSource": "async-annotated or plain function body…" }'
```

- The source is compiled server-side before registration — a syntax error blocks the
  save (`REGISTER_FAILED`). Duplicate names → `ALREADY_EXISTS` (409).
- v1.0.5 fields: `environment` (`js-function` — the default — or `nodejs`) and
  `metadata` (flat string key/value record, ≤ 50 pairs). A `nodejs` tool's stored
  environment drives the Node.js sandbox at run time. **v1.0.11:** the enum also
  accepts `freedom-node` (the intentionally unrestricted environment, run by the
  dedicated freedom runner behind the configuration gate — see
  [Tool Development](tool-development.md#the-freedom-node-environment--intentionally-unrestricted-v1011)).
- v1.0.6 field: `autoExecute` (boolean, default `false`). `false` (or omitted) means
  every task-driven execution of this tool passes through the approval gate unless a
  global/task override turns auto-execution on (see
  [Tool Runtime](tool-runtime.md#the-approval-gate-v106)).
- CRUD beyond creation (v1.0.2, extended v1.0.5/v1.0.6): `GET /api/tools/{name}` (full
  entry incl. `functionSource` and `metadata`), `PUT /api/tools/{name}` (partial update
  of user-editable tools — description, category, schema, source, `toolVersion`,
  `enabled`, rename via the `name` field, plus `environment` (js-function ⇄ nodejs
  switch), `metadata`, `handlerKind`/`handlerConfig` for dynamic tools and the v1.0.6
  `autoExecute` flag; built-ins → 403 `READ_ONLY`), `DELETE /api/tools/{name}` (user
  tools only), `POST /api/tools/test` (registered tool or unsaved source — see
  [Tool Development](tool-development.md) for the response shape).

## Complete working example tool

A dynamic tool that checks a deployment endpoint (works end-to-end with `http_get`):

```jsonc
// POST /api/tools/register
{
  "definition": {
    "name": "deploy.health",
    "description": "Fetches the deployment health endpoint of a service and returns its status.",
    "purpose": "Observe whether a deployment finished successfully.",
    "category": "monitoring",
    "environment": "dynamic",
    "handlerKind": "http_get",
    "handlerConfig": { "url": "https://example.com/healthz" },
    "schema": {
      "type": "object",
      "properties": [
        { "name": "service", "type": "string", "required": false,
          "description": "Optional service name recorded in the request context",
          "generation": "extractive" }
      ]
    }
  }
}
```

Then give the runtime a goal task:

```bash
curl -X POST http://localhost:3000/api/tasks -H 'Content-Type: application/json' \
  -d '{ "request": "Check whether the deployment of service web finished successfully",
        "config": { "mode": "goal", "enabledTools": ["deploy.health"] } }'
```

The Planner includes `deploy.health` in its tool inventory; CoreModule matches the
objective, extracts `service` verbatim, executes the tool (HTTP status + body become the
observation), and the Observer/goal-check decide completion. Watch it live in Task
Preview: `core.decision` → `tool.started` → `tool.completed` → `observer.observed`.

## Tool stats & lifecycle

- Every execution increments `callCount`, and one of `successCount` / `failureCount` /
  `timeoutCount`, plus `totalMs` (→ `avgMs`).
- Stats live on the `ToolRecord` row — they survive restarts; handlers do not (they are
  re-resolved on demand from the in-memory map / builtin map).
- `environment` labels are honest: `virtual-env` tools operate on the in-memory fleet,
  `builtin` on the real host, `dynamic` on their bound handler.

## Shared global VFS (v1.0.12)

All tools running in restricted environments (`js-function`, `nodejs`) now share **ONE persistent, runtime-owned virtual filesystem** (§3.1–§3.13). Files written by one tool are visible to every other tool and to later tasks:

```
Tool A: fs.writeFile("/notes/test.txt", "hello")
Tool B: fs.readFile("/notes/test.txt")   →   "hello"
```

- The VFS root is the security boundary — tool code sees virtual absolute paths rooted at `/` and can never reach the host filesystem (traversal, encoded escapes, NUL bytes, drive letters and symlink escapes are all rejected).
- Storage is a real on-disk tree under the runtime data directory, so files persist across executions, tasks and application restarts.
- Limits (max file size, total size, entries, depth) remain authoritative in `config/configuration-limits.json` and are enforced live — now against the WHOLE shared store.
- `freedom-node` is exempt (§3.10): it keeps complete host freedom and never touches the shared VFS.

Native filesystem tools (built-in, operate only on the shared VFS):

| Tool | Purpose |
| --- | --- |
| `fs.list` | List entries in a directory (with metadata) |
| `fs.readfile` | Read a file (`utf8`, `base64` or `buffer`) |
| `fs.writefile` | Create/overwrite a file |
| `fs.getpath` | Normalize a virtual path |
| `fs.hasfile` / `fs.hasfolder` | Existence checks |
| `fs.infofile` | File metadata (name, path, size, type, timestamps) |
| `fs.createfolder` / `fs.deletefile` / `fs.deletefolder` | Structure management |
| `fs.find` | **v1.0.13** Name search with configurable depth (0 = start dir only), files-only/folders-only, case sensitivity; result-capped |
| `fs.copy` | **v1.0.13** Copy a file or a whole folder (recursive) inside the VFS |
| `fs.move` | **v1.0.13** Move/rename a file or folder inside the VFS |
| `fs.cmd` | **v1.0.13** Execute a terminal command on the host (bash, confined to the runtime working directory). ALWAYS requires explicit user confirmation — it is on the `FORCE_APPROVAL_TOOLS` list and carries a second handler-level gate for subtool/test contexts. 30 s default / 120 s max timeout, 256 KiB output caps |
| `fs.download` | **v1.0.13** Register a VFS file for download → short-lived console URL `/api/fsdownloads/<token>` (10 min TTL, re-verifies the VFS boundary per request) |
| `fs.upload` | **v1.0.13** Ask the operator for a file ("Upload a file — [Choose file] [Cancel]") and store it in the shared VFS; bounded 120 s wait window, honest `FILE_REQUEST_TIMEOUT` on expiry |

Built-in tools are visible but **not exportable** — only custom tools can be exported (§2.2).
