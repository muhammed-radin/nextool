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
  environment: 'builtin' | 'virtual-env' | 'dynamic' | 'js-function' | 'nodejs';
  // v1.0.2: js-function · v1.0.5: nodejs (restricted Node.js environment)
  schema: {
    type: 'object';
    properties: ToolParamDef[];
  };
  handlerKind?: 'echo' | 'delay' | 'http_get' | 'uuid';   // dynamic tools only
  handlerConfig?: Record<string, unknown>;                // dynamic tools only
  functionSource?: string;   // js-function AND nodejs tools (≤ 64 000 chars)
  toolVersion?: string;      // user-facing version string, free form
  metadata?: Record<string, string>;   // v1.0.5: flat string key/value pairs, ≤ 50
}

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

## The Tool IDE and the function-tool environments (v1.0.2 / v1.0.5)

**Tools → New Tool / Edit** opens the in-console Tool IDE: a Monaco JavaScript editor
(custom `nextool-dark` theme, with a v1.0.5 **textarea toggle**), a schema editor
(structured form + JSON view since v1.0.5), schema-driven IntelliSense, a References
pane showing the real sandbox API, and a **Test Tool** panel that runs the actual
sandbox. A tool authored here has `environment: 'js-function'` — or, since v1.0.5,
`environment: 'nodejs'` — and its body is a single
`async function execute(params, context) { …; return value; }`.

- **js-function** execution happens in a hardened `node:vm` sandbox
  (`src/lib/nexool/tools/js-runner.ts`) exposing **only** `params`,
  `context {executionId, taskId, mode, now, log}`, `console` (capped 100 lines) and ES
  builtins. No `require`, `process`, `fetch`, timers or `Buffer` — a documented
  limitation, not a bug.
- **nodejs** (v1.0.5) is a restricted Node.js environment with the SAME execute
  contract plus `require()`/`await import()` for an allowlisted module set
  (`buffer`, `crypto`, `events`, `path`, `querystring`, `string_decoder`, `url`,
  `util`, `assert`, `zlib`). Still sandboxed — no `process`, no timers, no `fetch`,
  no filesystem/network. Full allowlist, limits and error wording:
  [Tool Development](tool-development.md#the-nodejs-environment--restricted-nodejs-v105).
- The **Execution environment** selector offers `js-function | nodejs | dynamic` from
  the real runtime registry (`GET /api/tools/environments`); dynamic tools are locked
  to dynamic in the editor.
- **Metadata** (v1.0.5) — structured key/value rows (strings only, ≤ 50 pairs),
  stored on the ToolDefinition and round-tripped through export/import.
- Limits (both function environments): source ≤ 64 000 chars; sync execution capped
  4 s (`vm` timeout — enforced at function invocation since v1.0.5); the whole run
  capped 10 s; results must be JSON-serializable, ≤ 64 KiB, depth ≤ 12. `nodejs` adds
  a 256 MiB heap-growth sentinel.
- Full guide with a worked example, limits tables and debugging checklist:
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
  "nexool": { "kind": "nextool.tool", "version": 1, "appVersion": "1.0.5", "exportedAt": "…" },
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
  "handlerKind": "…",                  // dynamic tools only
  "handlerConfig": { … }               // dynamic tools only
}
```

The `nexool` envelope is advisory metadata (read on import, not enforced).
**Export all tools (JSON)** downloads `nextool-tools-<YYYY-MM-DD>.json` — an array of
these single-tool objects. Bundle files are *export-only*: the importer accepts one
tool at a time.

### Import workflow

**Import tool (JSON)…** runs this pipeline — nothing is registered until you confirm:

1. **Parse** — must be valid JSON; arrays and `{ "tools": [...] }` bundles are rejected
   with a pointed message ("import one tool at a time").
2. **Client-side validation** (human-readable errors, shown in a rejection dialog):
   - `name` — required, `namespace.action` regex (lowercase).
   - `description` — required (the CoreModule matches on it).
   - `environment` — must be `js-function`, `nodejs` (both authorable) or `dynamic`;
     `builtin`/`virtual-env` (read-only registry tools) are rejected with a
     "read-only" message — duplicate them into a function tool instead.
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
3. **Preview dialog** — name, environment, category, schema param count, description
   and the full function source, plus any warnings, before you choose **Register tool**.
4. **Conflict handling** — if the name already exists a dialog offers
   **Replace existing tool** (`PUT /api/tools/{name}` with the imported definition),
   **Import as copy** (auto non-conflicting name `base.copy`, then `base.copy-2`,
   `base.copy-3` …) or **Cancel** — never a silent overwrite.
5. **Registration** via the existing endpoints: `POST /api/tools/js` for
   `js-function`/`nodejs`, `POST /api/tools/register` for `dynamic`. The backend
   re-validates everything (zod + function-source syntax via the sandbox compiler) and
   surfaces `ALREADY_EXISTS` honestly if a race slipped past the conflict check.
6. The imported tool appears in the registry and is fully editable in the Tool IDE
   (its function loads into the editor like any other function tool — a `nodejs` tool
   opens with the Node.js environment, IntelliSense and References already wired).

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
  environment drives the Node.js sandbox at run time.
- CRUD beyond creation (v1.0.2, extended v1.0.5): `GET /api/tools/{name}` (full entry
  incl. `functionSource` and `metadata`), `PUT /api/tools/{name}` (partial update of
  user-editable tools — description, category, schema, source, `toolVersion`,
  `enabled`, rename via the `name` field, plus the v1.0.5 fields `environment`
  (js-function ⇄ nodejs switch), `metadata`, and `handlerKind`/`handlerConfig` for
  dynamic tools; built-ins → 403 `READ_ONLY`), `DELETE /api/tools/{name}` (user tools
  only), `POST /api/tools/test` (registered tool or unsaved source — see
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
