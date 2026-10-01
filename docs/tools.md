---
title: Tools
category: Tools
order: 1
---

# Tools — writing and registering tools

Everything the runtime can *do* is a tool. This page documents the `ToolDefinition`
schema, parameter generation rules, both registration paths (built-in code and the
`/api/tools/register` endpoint), the four dynamic handler kinds, and a complete working
example.

## ToolDefinition schema

```ts
interface ToolDefinition {
  name: string;              // "namespace.action", lowercase; regex ^[a-z][a-z0-9_.-]*\.[a-z][a-z0-9_.-]*$
  description: string;       // what it does — feeds matching + prompts
  purpose?: string;          // why it exists (prompt context)
  category: string;          // monitoring | automation | content | utility | memory | notification | general …
  environment: 'builtin' | 'virtual-env' | 'dynamic';
  schema: {
    type: 'object';
    properties: ToolParamDef[];
  };
  handlerKind?: 'echo' | 'delay' | 'http_get' | 'uuid';   // dynamic tools only
  handlerConfig?: Record<string, unknown>;                // dynamic tools only
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
| `http_get` | `fetch(handlerConfig.url)` with an 8 s `AbortSignal.timeout` → `{ status, body (≤2000 chars) }` | Missing `handlerConfig.url` fails with `INVALID_CONFIG`. |

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
  -d '{ "request": "Check whether the deployment of service web finished successfully" }'
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
