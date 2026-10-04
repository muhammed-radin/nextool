---
title: CoreModule
category: AI Core
order: 1
---

# CoreModule — the decision unit

CoreModule (`src/lib/nexool/core/coremodule.ts`) is the AI component that turns an
objective into exactly ONE structured action. It is the "SELECT TOOL → GENERATE PARAMS"
stages of the pipeline. Every decision is tagged with the engine that produced it:
**llm-core v1.0.0** (active) or **heuristic-fallback** (deterministic, covers SDK
outages).

## Input bundle (DecideInput)

```ts
{
  objective: string;          // active subgoal title, plan step title, or live observation objective
  request: string;            // original user request
  goal: string;               // refined goal
  activeSubgoal?: { title, reason };
  toolDefs: ToolDefinition[]; // every ENABLED tool (name, description, purpose, category, full schema)
  contextBundle?: {
    memory?: Record<string, unknown>[];      // ≤ 5 most recent MemoryEntries (if useMemory)
    history?: Record<string, unknown>[];     // ≤ 5 latest history actions for this task
    stateSummary?: string;                   // JSON: mode, iteration, toolCalls, activeSubgoal,
                                             // planStatuses, fleet health (api-01=healthy, …)
    lastObservation?: string;
  };
  reasoningLevel: number;      // 1..6
  allowedTools?: string[];     // task-level allow-list
}
```

The user message is a JSON serialization of all of the above — no hidden state, fully
inspectable in the `core.decision` event payload.

## Tool matching rules

1. **One tool only.** The prompt forbids chaining; the validator enforces that the named
   tool exists in the provided `toolDefs` set, otherwise the output is rejected →
   heuristic fallback.
2. **Extractive parameters** (`generation: "extractive"`) must be copied verbatim from
   the objective/request/context — the prompt explicitly forbids inventing them
   (e.g. `weather.get { location }`, `server.health { serverId }`).
3. **Constructive parameters** (`generation: "constructive"`) must be regenerated and
   enriched from intent, tool description, schema and context — never the raw sentence.
   The canonical example is `image.generate { prompt }`: the model adds lighting,
   composition, atmosphere, style and quality descriptors.
4. **Schema validation** is expected of the model (types, enums, min/max, safe coercion
   like string `"5"` → number). The runtime re-checks everything anyway:
   `validateOutput` runs the LLM params through `coerceParams`, and the executor runs
   full `coerceParams` + `validateParams` before invoking the handler.
5. **Missing required parameters** that cannot be derived → `clarification_required`
   with the missing param names.
6. **Post-decision gate**: if the chosen tool is not in `allowedTools` (or no longer in
   the enabled set), the decision is rewritten to `cannot_execute` with a precise reason
   ("disabled or excluded by the task configuration") — it is never silently executed.

## Output schema (CoreModuleOutput)

```jsonc
{
  "status": "tool_call | no_tool | clarification_required | cannot_execute | stop",
  "tool": "server.health",            // only for tool_call
  "params": { "serverId": "api-01" }, // only for tool_call, coerced
  "confidence": 0.95,                 // 0..1, default 0.5 if the model omits it
  "reason": "one concise operational sentence (no chain-of-thought)",
  "missing": ["param", "..."],        // only for clarification_required
  "candidates": [ { "tool": "...", "score": 0.42 } ],  // heuristic engine only
  "engine": "llm-core | heuristic-fallback",
  "latencyMs": 1120
}
```

Status semantics in the loop:

| Status | Goal Mode effect |
| --- | --- |
| `tool_call` | Execute (one retry on failure). |
| `no_tool` | Complete as informational if the reason matches "no registered/suitable tool", "not require", "informational", or confidence ≥ 0.6 — otherwise fail with `NO_TOOL`. |
| `clarification_required` | Fail with `CLARIFICATION_REQUIRED` + `core.clarification` event. |
| `cannot_execute` | Fail with `NO_CAPABLE_TOOL`. |
| `stop` | Finalize `stopped` with the decision reason. |

## Engines

### llm-core v1.0.0 (active)

- Backend: `z-ai-web-dev-sdk` chat completions, server-side, `thinking: { type:
  'disabled' }`, system prompt sent with role `assistant` (sandbox requirement).
- Hard timeout 25 s (`CORE_TIMEOUT_MS`). One automatic retry with a stricter "Return ONLY
  the JSON object" suffix if the first response contains no parseable JSON object.
- Output validation: status must be one of the five; confidence clamped 0–1; reason
  capped 300 chars; `tool_call` requires a known tool name (else → fallback engine).
- Latency is measured end-to-end (`Date.now()` around the whole decide call, including
  retries and validation) and recorded into the runtime metrics.

### heuristic-fallback

- Pure token-overlap matcher (`heuristic.ts`): normalizes text (typo table: moniter→
  monitor, infrom→inform, genrate→generate, …), tokenizes (stopword filter, dotted
  tokens like `api-01` kept), weights tool docs (name ×3, param names ×2, description/
  purpose/category/enum ×1) and scores an F1-like weighted overlap. Threshold **0.18**.
- Confidence is capped at **0.72** for `tool_call` and ≤ 0.6 for `no_tool`; returns top-3
  `candidates` with scores; naive parameter extraction covers server ids (`api|web|db-\d`),
  numbers, quoted strings, `#tags`, math expressions, enums.
- Unfilled required params → `clarification_required` listing them.

## Latency

- Every decision calls `recordCoreDecision(latencyMs)` → metrics: `coreCalls`,
  `totalCoreLatencyMs`, `lastDecisionAt`, and a rolling `coreDecisionSeries` (last 50)
  powering the Dashboard latency chart and `avgCoreLatencyMs` in `/api/system` and
  `/api/models`. Measured average in the v1.0.0 E2E run was ≈ 1.1 s per decision; treat
  that as anecdotal — live numbers are in the console.

## Real examples (from the shipped prompt + verified E2E runs)

- `Objective: "Check the weather in Kochi" | tool weather.get {location extractive}` →
  `{"status":"tool_call","tool":"weather.get","params":{"location":"Kochi"},"confidence":0.95,…}`
- `Objective: "Create an image of a car on a city street at night" | image.generate
  {prompt constructive, size enum, style constructive}` → enriched prompt
  (`cinematic, street lamps, reflections on wet asphalt…`), `"size":"1024x1024"`,
  confidence 0.97.
- `Objective: "Explain quantum physics" | no matching tool` →
  `{"status":"no_tool","confidence":0.8,"reason":"No registered tool provides explanatory
  text generation."}`
- Verified in-browser: `Check the health of server api-01` → `server.health` executed;
  typo-laden `moniter the server api-01 and infrom me` understood (typo normalization +
  LLM reasoning), task completed.

## Where decisions are visible

- `core.decision` events (priority 4) carry the full output — Events view / Task Preview
  timeline.
- `engine` badge surfaces in the header (active engine), Models view and status bar.
- [Heuristic details](#engines) above; [Models](models.md) for versioning.
