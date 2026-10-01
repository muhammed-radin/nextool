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
`node:vm` sandbox. **v1.0.5** adds a second authorable environment — `nodejs`, a restricted
Node.js JavaScript environment with `require()`/`await import()` for an **allowlisted**
module set — plus a structured metadata editor, a structured tool-schema form, a
Monaco ⇄ textarea toggle and hardened editor source-sync. v1.0.4 already hardened the
editor loop (the code you see is the code that is saved and tested) and made **Duplicate**
non-destructive; JSON export/import of tools is documented in
[Tools](tools.md#tool-export--import-as-json-v104). This page is the complete guide; the
ToolDefinition schema, dynamic handler kinds and the built-in tools live in [Tools](tools.md).

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

## Choosing the execution environment (v1.0.5)

The Tool IDE **Execution environment** selector offers the authorable environments
`js-function`, `nodejs` and `dynamic`. The list, labels and descriptions come from the
**real runtime registry** — `GET /api/tools/environments` — not a hardcoded frontend
copy (see [API](api.md#get-apitoolsenvironments)). Tools stored as `dynamic` are **locked**
to dynamic in the editor (handler-based storage) — duplicate one into a function tool to
change its environment.

| | `js-function` | `nodejs` (v1.0.5) | `dynamic` |
| --- | --- | --- | --- |
| What it is | Restricted JavaScript tool sandbox | Restricted Node.js JavaScript environment | Registered handler kind (`echo`/`delay`/`http_get`/`uuid`), no custom code |
| Entry point | `execute(params, context)` | `execute(params, context)` — **same contract** | handler implementation |
| Modules | none — no `require`/`import` | `require()` / `await import()` for **allowlisted** modules only | — |
| Network | no | no (`http`/`https`/`net` are blocked) | only via `http_get` with its configured URL |
| `process` / timers / `fetch` | none | none — `process` is not injected, no timers, no `fetch` | — |
| Typical use | pure computation over params | hashing, compression, URL/querystring parsing, binary data | safe I/O with fixed behavior |

**nodejs is still a sandbox** — it is *not* unrestricted Node.js access. It exists so a
tool can use selected Node.js capabilities (crypto, zlib, Buffer, URL parsing …) that the
plain `js-function` sandbox withholds. Everything reachable is allowlisted and audited;
see the tables below for exactly what exists.

## The js-function sandbox contract

The sandbox global contains **only** what is listed here. Everything else — `require`,
`process`, `fetch`, `setTimeout`/`setInterval`, `Buffer`, `globalThis` escape hatches —
is intentionally absent. This is a documented limitation, not a bug: a js-function tool
is a pure computation over its params.

| Available | Details |
| --- | --- |
| `params`, `context` | As tabled above (params are JSON-cloned before the run). |
| `console.log/warn/error/info` | All routed to the capped log buffer. |
| ES builtins | `JSON`, `Math`, `Date`, `Number`, `String`, `Boolean`, `Array`, `Object`, `RegExp`, `Error`, `Map`, `Set`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`. |
| `async/await`, Promises | Supported — but see the async timeout below. |

**Not available (honest limitations):** no network (`fetch`), no filesystem, no child
processes, no timers (you cannot sleep or schedule), no dynamic `require`, no access to
the virtual fleet or memory store except by being called with params. If a tool needs
I/O, write a dynamic handler tool (`http_get` etc., see [Tools](tools.md#the-four-dynamic-handler-kinds)),
a `nodejs` tool (below) or a built-in in code.

### Limits and error codes

| Limit | Value |
| --- | --- |
| Function source length | ≤ 64 000 chars (enforced at save and at run). |
| Sync execution | Capped at 4 s by the `node:vm` script timeout — **v1.0.5: enforced at function invocation**, so a no-`await` runaway loop is bounded without freezing the host event loop. |
| Async execution (whole run) | Capped at 10 s (`TIMEOUT` abort). |
| Result size | ≤ 64 KiB serialized. |
| Result depth | ≤ 12 (BigInt/function/symbol/circular results are rejected). |
| Log buffer | 100 lines × 2000 chars. |
| Test context | 10 s timeout; tests never mutate task state. |

| Error code | Meaning |
| --- | --- |
| `SYNTAX_ERROR` | Source does not compile. |
| `INVALID_FUNCTION` | Source compiled to something that is not callable. |
| `TIMEOUT` | Run exceeded 10 s. |
| `NOT_SERIALIZABLE` | Result violates the serialization contract (message says why). |
| `SANDBOX_ERROR` | Sandbox could not be created. |
| `TOOL_FAILURE` | The function threw (message is the thrown error). |

## The nodejs environment — restricted Node.js (v1.0.5)

A `nodejs` tool is the same `execute(params, context)` function, compiled inside a
contextified `node:vm` sandbox (`src/lib/nexool/tools/node-runner.ts`) whose **only**
module surface is `require(id)` / `await import(id)` resolving through the allowlist
below. The host feeds the allowlisted modules in as static imports — there is no dynamic
path that could resolve anything else.

### Node.js module allowlist

`require('crypto')`, `require('node:crypto')` (the `node:`-prefixed form resolves through
the same list) and `await import('crypto')` all work for exactly these modules:

| Module | What it is for |
| --- | --- |
| `buffer` | Buffer class for binary data (also available as a global). |
| `crypto` | Hashes, HMACs, random bytes, UUIDs and other cryptography primitives. |
| `events` | EventEmitter for event-driven tool logic. |
| `path` | Path string utilities (pure string manipulation — no filesystem access). |
| `querystring` | URL query string parsing and formatting. |
| `string_decoder` | Stateful buffer → string decoding that respects multi-byte characters. |
| `url` | URL parsing and formatting (legacy API on top of the global URL). |
| `util` | Formatting, type checks and promise utilities. |
| `assert` | Assertion helpers for validating tool assumptions. |
| `zlib` | Compression (gzip/deflate/brotli) for data-processing tools. |

The IDE **References** panel shows this list live from the runtime, and the
authoritative source is the endpoint itself — `GET /api/tools/environments`
(`node.modules`) — which the IDE, the IntelliSense declarations and the panel all read
(there is no second hardcoded copy to drift).

**Non-allowed modules fail** with a pointed error (the wording to expect in test runs and
`TOOL_FAILURE` observations):

```
Module "x" is not available in the NexTool Node.js environment.
```

Unknown names append the allowed list; deliberately blocked ones append the reason.

### Deliberately blocked modules

| Module | Why it is never allowed |
| --- | --- |
| `child_process` | subprocess execution is never allowed |
| `cluster` | multi-process execution is never allowed |
| `vm` | creating further sandboxes is never allowed |
| `worker_threads` | thread execution is never allowed |
| `fs` | unrestricted filesystem access is never allowed |
| `os` | OS-level information/introspection is never allowed |
| `net`, `dgram` | raw network sockets are never allowed |
| `http`, `https` | unrestricted networking is never allowed |
| `process` | process manipulation is never allowed |

### Globals inside the nodejs sandbox

| Global | Type / notes |
| --- | --- |
| `params`, `context` | Same contract as `js-function` (params are JSON-cloned). |
| `console.log/warn/error/info` | Routed to the capped log buffer (100 lines × 2000 chars), shown in the test panel. |
| `Buffer` | Binary data constructor (from the allowlisted `buffer` module). |
| `TextEncoder`, `TextDecoder` | UTF-8 conversion. |
| `URL`, `URLSearchParams` | URL parsing and query handling (no network). |
| `atob`, `btoa` | Base64 decoding/encoding. |
| `structuredClone` | Structured deep clone. |

**Not available:** `process`, timers (`setTimeout`/`setInterval`/…), `fetch`, and every
module outside the allowlist. As with `js-function` this is a documented limitation, not
a bug.

### Node.js execution limits

| Limit | Value |
| --- | --- |
| Function source length | ≤ 64 000 chars (validated at save and at run). |
| Sync execution | Capped at 4 s by the `vm` timeout — enforced at the function **invocation**, so a no-`await` infinite loop is stopped (`TIMEOUT`) without blocking the host event loop. |
| Async execution (whole run) | Watchdog caps the run at 10 s (`TIMEOUT` abort) — bounds awaits, import chains and zlib streams. |
| Heap growth | 256 MiB heap-growth sentinel — the run aborts with `MEMORY` if the process heap grows beyond it while the tool executes. Honest caveat: this is an **in-process guard**, not a container; it aborts the tool result but cannot revoke memory already allocated in the host realm. |
| Result size | ≤ 64 KiB serialized, depth ≤ 12 (same `NOT_SERIALIZABLE` contract as `js-function`). |
| Log buffer | 100 lines × 2000 chars. |

| Error code (nodejs-specific) | Meaning |
| --- | --- |
| `TIMEOUT` | Sync body exceeded 4 s or the run exceeded the 10 s watchdog. |
| `MEMORY` | Heap growth exceeded the 256 MiB sentinel. |
| `TOOL_FAILURE` | The function threw — e.g. `Module "x" is not available in the NexTool Node.js environment.` |

### How dynamic `import()` works (implementation note)

Stock Node's `vm.Script` dynamic-import callback requires `--experimental-vm-modules` —
a flag the NexTool runtime cannot assume. Instead, dynamic `import("x")` **call sites**
are rewritten at compile time to `__nexoolDynamicImport("x")`, a shim that resolves
through the **same allowlist as `require()`**. The scanner is string/comment/regex-aware:
literals like `const s = "import(x)"` or `/import\(/` are never touched, and
`import.meta.url` passes through unchanged. Net effect: `await import('crypto')` works
without host flags, and `await import('fs')` fails with the standard block error.

## The Tool IDE

The editor is organized into explicit sections; on mobile they become tabs
(**Details / Schema / Function·Handler / References / Test** — see
[Mobile](mobile.md#v105-mobile-refinements)), on desktop the layout splits into a
left rail and a main pane.

- **General** — name (`namespace.action`), description, purpose, category, tool version,
  enabled switch — structured inputs, never raw JSON.
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
  `require()`/`import()` overloads built from the **live allowlist** plus the sandbox
  globals — IntelliSense knows exactly what the runtime accepts, nothing more.
  Dynamic tools show a **Handler** pane instead of code (see below).
- **References** — the human-readable sandbox API: the shared runtime contract
  (`params`, `context`, `log`, available globals) plus — in a `nodejs` session — the
  `require(...)`/`await import(...)` entries and the live module allowlist served by
  `GET /api/tools/environments`. The editor help and the sandbox contents cannot drift
  apart, because both come from one source.
- **Test** — runs the tool against the real sandbox with your test params JSON (see the
  worked example below).

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

## Complete worked example: `utility.wordcount`

**1. Schema** (structured rows, or paste into the JSON view):

```json
[
  {
    "name": "text",
    "type": "string",
    "required": true,
    "description": "Text to analyze",
    "generation": "extractive"
  },
  {
    "name": "mode",
    "type": "string",
    "required": false,
    "description": "Counting mode",
    "enumValues": ["words", "characters", "lines"],
    "generation": "extractive"
  }
]
```

**2. Function source** (paste into the editor — a `js-function` tool, plain body form):

```js
// utility.wordcount — counts words, characters or lines of the given text.
const text = typeof params.text === 'string' ? params.text : '';
const mode = params.mode ?? 'words';

let count = 0;
if (mode === 'characters') {
  count = text.length;
} else if (mode === 'lines') {
  count = text.split(/\r?\n/).length;
} else {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  count = words.length;
}

context.log('mode=' + mode, 'count=' + count);

return {
  mode,
  count,
  chars: text.length,
  lines: text.split(/\r?\n/).length,
  measuredAt: context.now,
};
```

**3. Test before saving** — press **Test Tool** (or call the API with unsaved source).
The test always executes the code currently visible in the editor, and the editor is
never modified by a test (see the source-sync guarantees above):

```bash
curl -X POST http://localhost:3000/api/tools/test -H 'Content-Type: application/json' \
  -d '{
    "functionSource": "const text = typeof params.text === \"string\" ? params.text : \"\"; return { words: (text.toLowerCase().match(/[a-z0-9'\'']+/g) ?? []).length };",
    "params": { "text": "NexTool executes real tools" }
  }'
```

Response (envelope data):

```json
{
  "mode": "test-source",
  "environment": "js-function",
  "status": "completed",
  "durationMs": 3,
  "result": { "words": 4 },
  "error": null,
  "params": { "text": "NexTool executes real tools" },
  "logs": []
}
```

The test panel renders `result` in the console JSON tree and lists the captured log
lines. Test runs use `context.mode: 'test'` and `taskId: null` — they never touch task
flows.

**Testing a `nodejs` tool** — pass the environment hint so unsaved source runs in the
Node.js sandbox (the endpoint is environment-aware since v1.0.5):

```bash
curl -X POST http://localhost:3000/api/tools/test -H 'Content-Type: application/json' \
  -d '{
    "functionSource": "async function execute(params) { const crypto = require(\"crypto\"); return { sha256: crypto.createHash(\"sha256\").update(params.input).digest(\"hex\") }; }",
    "params": { "input": "nexool" },
    "environment": "nodejs"
  }'
```

**4. Save (register)** — press **Save**:

```bash
curl -X POST http://localhost:3000/api/tools/js -H 'Content-Type: application/json' \
  -d '{
    "name": "utility.wordcount",
    "description": "Counts words, characters or lines of a text.",
    "category": "utility",
    "toolVersion": "1.0.0",
    "schema": { "type": "object", "properties": [
      { "name": "text", "type": "string", "required": true,
        "description": "Text to analyze", "generation": "extractive" },
      { "name": "mode", "type": "string", "required": false,
        "description": "Counting mode", "enumValues": ["words","characters","lines"] }
    ]},
    "metadata": { "owner": "platform" },
    "functionSource": "/* the exact source from step 2 */"
  }'
```

The source is syntax-validated server-side before registration; a broken source never
becomes an active tool (`REGISTER_FAILED` with the syntax error). The tool lands in the
real `ToolRecord` registry with `environment: 'js-function'` (a `nodejs` tool registers
the same way with `"environment": "nodejs"`). **Save** also reads the code straight from
the live editor surface — the exact on-screen code is what gets registered, and the
`source` React state is synced from it, so state and editor can never disagree.

**5. Enable / disable / delete** — Tools grid actions, or:

```bash
# toggle (name is URL-encoded — dots)
curl -X POST http://localhost:3000/api/tools/utility.wordcount/toggle \
  -H 'Content-Type: application/json' -d '{"enabled": false}'
# delete (user tools only; built-ins are rejected READ_ONLY)
curl -X DELETE http://localhost:3000/api/tools/utility.wordcount
```

**6. Call it from NexTool** — submit a goal task like
`Count the words of "to be or not to be"` in the Task Console. CoreModule sees
`utility.wordcount` in the tool inventory (description feeds matching), extracts the
`text` param, executes the sandboxed function, and the observation reports the result.
Watch `tool.started → tool.completed` in Task Preview.

## Editing, renaming, duplicating

- **Edit** re-opens the saved source (loaded via `GET /api/tools/{name}`); saving an
  edit issues `PUT /api/tools/{name}` (partial update: description, category, schema,
  `functionSource`, `toolVersion`, `enabled`, and `name` itself for renaming — plus the
  v1.0.5 fields `environment` (js-function ⇄ nodejs switch), `metadata` and the dynamic
  `handlerKind`/`handlerConfig`). Switching between tools remounts the editor view
  (per-session key), so every session initializes its state from the freshly loaded
  definition — no carry-over of the previous tool's code or schema.
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
- **Export / import** — tools (including this exact source, the environment and the
  metadata) can be downloaded as portable JSON and imported into another registry; see
  [Tools](tools.md#tool-export--import-as-json-v104).

## Debugging checklist

1. **Syntax error on save** — the server compiles the source with the same wrapper the
   runner uses; the error message quotes the compile failure.
2. **Test fails with `TIMEOUT`** — an `await` that never settles (there are no timers,
   so an accidental `new Promise(resolve => setTimeout(resolve))` hangs until the 10 s
   cap). Poll-free logic or `Promise.resolve` patterns are the way out. A no-`await`
   infinite loop is stopped by the 4 s invocation-level sync cap (v1.0.5).
3. **`Module "x" is not available in the NexTool Node.js environment.`** — expected for
   anything outside the allowlist (see the table above). Keep the module logic inside the
   allowed modules or move the capability into a dynamic handler/built-in.
4. **`NOT_SERIALIZABLE`** — you returned a `Map`, `Set`, function or BigInt. Convert to
   plain objects/arrays/strings first (`Object.fromEntries`, `Array.from`, `String(...)`).
5. **`MEMORY` (nodejs)** — the tool grew the heap beyond the 256 MiB sentinel; stream or
   chunk the work instead of materializing it.
6. **Wrong values in production** — remember CoreModule extracts `extractive` params
   verbatim from the request; mark a param `constructive` only when the model should
   craft the content (see [Tools](tools.md#parameter-generation-extractive-vs-constructive)).
7. **Tool not selected** — check the description (it feeds matching), confirm the tool
   is enabled, and watch the `core.decision` event for the reason.
