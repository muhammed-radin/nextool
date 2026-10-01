---
title: Model Format
category: AI Core
order: 3
---

# Model Format — `.nextool` manifests

NexTool defines a manifest format for registering model packages. In v1.0.1 the manifest
validator is fully implemented; the inference adapter that would *load weights* is not
installed (no TensorFlow.js runtime in this environment). This page documents exactly
what the validator accepts and how the underlying files relate to the standard TF.js
format for future adapters.

## The `.nextool` manifest

A JSON object posted to `POST /api/models/load` as `{ "manifest": { … } }`. Validation
lives in `src/app/api/models/load/route.ts` and checks **all five required fields**:

| Field | Type | Rule | Failure message |
| --- | --- | --- | --- |
| `name` | string | non-empty after trim | `name must be a non-empty string` |
| `version` | string | semver-like `/^\d+\.\d+\.\d+/` | `version must be semver-like (e.g. 1.0.0)` |
| `format` | string literal | must equal `"nextool"` | `format must be "nextool"` |
| `architecture` | object | any non-null, non-array object | `architecture must be an object` |
| `compatibility.runtime` | string | non-empty string | `compatibility.runtime must be a string` |

Any violation → HTTP 400:

```json
{ "ok": false, "error": { "code": "INVALID_MANIFEST",
  "message": "Invalid .nextool manifest: format must be \"nextool\"; …" } }
```

### Example manifest

```json
{
  "name": "tool-matcher-mini",
  "version": "0.1.0",
  "format": "nextool",
  "architecture": {
    "type": "layers",
    "inputs": [{ "name": "objective_tokens", "shape": [64] }],
    "outputs": [{ "name": "tool_logits", "shape": [16] }]
  },
  "compatibility": { "runtime": "tfjs-node >= 4.0" },
  "labels": { "tools": ["server.health", "server.restart", "…"] }
}
```

Extra fields (like `labels`) are preserved verbatim — the manifest is stored as-is.

## What happens on success

A `ModelRecord` row is created:

| Column | Value |
| --- | --- |
| `name` / `version` | from the manifest |
| `format` | `nextool-manifest` |
| `status` | `registered` |
| `manifest` | full JSON, verbatim |
| `sizeBytes` | byte length of the serialized manifest |
| `note` | "Registered. Inference adapter not active in this environment — active engine: llm-core." |

Response: HTTP 201 with the `ModelPackageInfo` DTO. **Registration is not activation** —
the active engine remains llm-core, and the note says so. Rejected/invalid manifests are
never persisted. `status` values across the system: `registered | active | rejected`.

## model.json + .bin — the standard TF.js layout

The `.nextool` package is designed to wrap the standard TensorFlow.js model directory
format, so a future adapter can load it without conversion:

```
mypackage.nextool/          (conceptual bundle)
├── manifest.nextool.json   ← the manifest documented above
├── model.json              ← TFJS graph/layers model topology + weightsManifest
└── group1-shard1of1.bin    ← weight shards (binary, referenced by model.json)
```

- `model.json` describes the model architecture (`modelTopology`) and lists weight
  shards with byte offsets — this is the standard TF.js serialization.
- `.bin` files are the raw weight payloads.
- In a future adapter, loading would be: validate manifest → resolve compatibility
  (`compatibility.runtime`) → `tf.loadLayersModel(url/model.json)` → warm up → flip the
  engine status to `active`.

**Status today: no `tf` runtime is installed; `model.json`/`.bin` handling is specified
here for adapter authors, not executable in v1.0.1.**

## Registry & API surface

| Item | Detail |
| --- | --- |
| Storage | `ModelRecord` table (SQLite): name, version, format, status, manifest JSON, sizeBytes, note, createdAt. |
| `GET /api/models` | `engine` (ActiveEngineInfo) + `packages` (max 100, newest first, manifest parsed) + `adapters { tfjs: false, nextoolManifest: true, parquet: false }`. |
| `POST /api/models/load` | Validation + registration as above. |
| Console | Models view: load dialog accepts a pasted JSON manifest or a file; 400 reasons surface directly in the UI. |

## Versioning rules of thumb

- `version` is per-package semver-like; re-loading the same name+version creates a new
  record (no dedup) — keep versions distinct to keep the package list meaningful.
- The CoreModule's own version (llm-core `1.0.0`) is tracked separately in
  `version.ts` and is unaffected by registered packages.
