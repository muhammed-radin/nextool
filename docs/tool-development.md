---
title: Tool Development
category: Tools
order: 2
---

# Tool Development — the Tool IDE and js-function tools

v1.0.2 adds a full in-console Tool IDE: author a JavaScript tool in Monaco, define its
parameter schema, get schema-driven IntelliSense, test it in the real sandbox, and save
it into the live registry. The execution environment is `js-function` — the tool **is**
a JavaScript function (`async function execute(params, context)`) run inside a hardened
`node:vm` sandbox. v1.0.4 hardens the editor loop (the code you see is the code that is
saved and tested) and makes **Duplicate** non-destructive; it also adds JSON
export/import of tools (see [Tools](tools.md#tool-export--import-as-json-v104)). This
page is the complete guide; the ToolDefinition schema, dynamic handler kinds and the
built-in tools live in [Tools](tools.md).

## Entry points

- **Tools view → New Tool** — opens the IDE with an empty draft (mode `new`).
- **Tools view → Edit** — opens a saved user tool (mode `edit`). Built-in and
  `virtual-env` tools are read-only; use **Duplicate** instead, which prefills an
  editable `js-function` copy under a new name.
- The IDE is a dedicated console view (`tool-editor.tsx`, zustand view `tool-editor`);
  closing it returns to the Tools grid.

## Anatomy of a js-function tool

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

There is exactly **one** execution path: the same runner (`src/lib/nexool/tools/js-runner.ts`)
serves IDE tests, the `POST /api/tools/test` endpoint, `nextool tool test` in the CLI and
real task executions (with `mode: 'production'`).

## Sandbox contract

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
I/O, write a dynamic handler tool (`http_get` etc., see [Tools](tools.md#the-four-dynamic-handler-kinds))
or a built-in in code.

### Limits and error codes

| Limit | Value |
| --- | --- |
| Function source length | ≤ 64 000 chars (enforced at save and at run). |
| Sync execution | Capped at 4 s by the `node:vm` script timeout. |
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

## Schema editor and IntelliSense

- **Schema pane** — a JSON array of `ToolParamDef` objects
  (`{ name, type, required, description, enumValues?, min?, max?, generation? }`, max 40
  params). It is validated before save: invalid JSON, an unsupported type, or a missing
  `name` blocks the save with a visible error.
- **IntelliSense from the schema** — the schema is compiled into a TypeScript
  `interface ToolParams` declaration, so `params.serverId` completes and type-checks;
  `enumValues` become string-union types, optional params get `?`.
- **Runtime declarations** — the sandbox API (`params`, `context`, `log`, available
  builtins) is declared via a Monaco `extraLib` (`nextool-runtime.d.ts`, built by
  `src/lib/nexool/tool-runtime-declarations.ts`). The **References** pane renders the
  same source as human-readable rows — the editor help and the sandbox contents cannot
  drift apart, because both come from one declaration module.
- **Editor theme** — Monaco with the custom `nextool-dark` theme (`@monaco-editor/react`).

## Complete worked example: `utility.wordcount`

**1. Schema** (paste into the Schema pane):

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

**2. Function source** (paste into the editor):

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

**3. Test before saving** — press **Test Tool** (or call the API with unsaved source):
(v1.0.4) the test always executes the code currently visible in Monaco — the editor
model is read through a live editor ref, so unsaved edits are tested exactly as shown,
never a stale cached value:

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
  "status": "completed",
  "durationMs": 3,
  "result": { "mode": "words", "count": 4, "chars": 29, "lines": 1 },
  "error": null,
  "logs": ["mode=words count=4"]
}
```

The test panel renders `result` in the console JSON tree and lists the captured log
lines. Test runs use `context.mode: 'test'` and `taskId: null` — they never touch task
flows.

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
    "functionSource": "/* the exact source from step 2 */"
  }'
```

The source is syntax-validated server-side before registration; a broken source never
becomes an active tool (`REGISTER_FAILED` with the syntax error). The tool lands in the
real `ToolRecord` registry with `environment: 'js-function'`. (v1.0.4) **Save** also
reads the code straight from the Monaco model through the live editor ref — the exact
on-screen code is what gets registered, and the `source` React state is synced from it,
so state and editor can never disagree.

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
  `functionSource`, `toolVersion`, `enabled`, and `name` itself for renaming).
  Switching between tools remounts the editor view (per-session key), so every session
  initializes its state from the freshly loaded definition — no carry-over of the
  previous tool's code or schema.
- **Rename** is a real registry operation — executions already in flight keep their
  resolved handler; the next decision uses the new name.
- **Duplicate** (v1.0.4 — non-destructive) — the in-editor **Duplicate** button
  switches the session into *register-a-copy* mode: the target name resets to
  `namespace.copy`, the session becomes a "new tool" session, and the copy keeps the
  **exact** function code + schema + metadata of the original. **Save** then calls the
  register endpoint (`POST /api/tools/js`) and creates a NEW tool — the original is
  never renamed or overwritten. The Tools-grid **Duplicate** action uses the same
  flow (it opens the editor prefilled as a copy under `<namespace>.copy`).
- `GET /api/tools/{name}` returns the full entry including `functionSource` — the IDE
  loads the editor content from it.
- **Export / import** — tools (including this exact source) can be downloaded as
  portable JSON and imported into another registry; see
  [Tools](tools.md#tool-export--import-as-json-v104).

## Debugging checklist

1. **Syntax error on save** — the server compiles the source with the same wrapper the
   runner uses; the error message quotes the compile failure.
2. **Test fails with `TIMEOUT`** — an `await` that never settles (there are no timers,
   so an accidental `new Promise(resolve => setTimeout(resolve))` hangs until the 10 s
   cap). Poll-free logic or `Promise.resolve` patterns are the way out.
3. **`NOT_SERIALIZABLE`** — you returned a `Map`, `Set`, function or BigInt. Convert to
   plain objects/arrays/strings first (`Object.fromEntries`, `Array.from`, `String(...)`).
4. **Wrong values in production** — remember CoreModule extracts `extractive` params
   verbatim from the request; mark a param `constructive` only when the model should
   craft the content (see [Tools](tools.md#parameter-generation-extractive-vs-constructive)).
5. **Tool not selected** — check the description (it feeds matching), confirm the tool
   is enabled, and watch the `core.decision` event for the reason.
