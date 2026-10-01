---
title: Model Format
category: AI Core
order: 3
---

# Model Format — packages, zips and manifests

NexTool moves real model artifacts since v1.0.2 (`src/lib/nexool/training/model-package.ts`,
built on `fflate`): trained classifiers are **exported** as downloadable zips and
**imported** with a genuine TF.js compatibility check. The v1.0.1 `.nextool` manifest
validator (`POST /api/models/load`) remains unchanged for metadata-only registration.

## Export layout 1 — native TFJS zip (`format=tfjs`)

Exactly what `tf.loadLayersModel` consumes, plus a NexTool metadata sidecar:

```
model.zip
├── model.json               ← { modelTopology, weightsManifest, format: "tfjs-layers-model", generatedBy: "NexTool Q1 v1.0.5" }
├── group1-shard1of1.bin     ← raw weight payload (referenced by weightsManifest paths)
└── metadata.json            ← ExportedModelMetadata (below)
```

Download name: `<packageName>-tfjs-v<version>.zip`.

## Export layout 2 — `.nextool` package (`format=nextool`)

The full NexTool package: manifest + embedded model + metadata:

```
core.nextool
├── package.json             ← manifest: name, version, format "nextool-model-package",
│                              applicationVersion, architecture, parameterCount, datasetVersion,
│                              classes, vocabSize, finalMetrics, trainingConfig, tfjsCompatibility
├── model/
│   ├── model.json           ← { modelTopology, weightsManifest }
│   └── group1-shard1of1.bin
└── metadata.json            ← the same ExportedModelMetadata as above
```

Download name: `<packageName>-v<version>.nextool` (served as
`application/octet-stream`).

### metadata.json fields (both layouts)

| Field | Content |
| --- | --- |
| `packageName` | ModelRecord name |
| `applicationVersion` | the exporting app's `APP_VERSION` (e.g. `1.0.5`) |
| `modelVersion` | ModelRecord version (e.g. `tc-…` for trained classifiers) |
| `architecture` | `tfjs-sequential` / `tfjs-model` (from topology `className`) or the manifest's architecture string |
| `parameterCount` | Sum of weight-shape products |
| `datasetVersion` | From the training manifest lineage; `null` when absent — never invented |
| `createdAt` | ISO export timestamp |
| `tfjsCompatibility` | TF.js version that produced the topology |
| `packageFormat` | `tfjs-zip` or `nextool` |
| `notes` | ModelRecord note, when present |

**Exportability rule:** only models whose manifest contains topology + weights are
exportable — trained classifiers (`tfjs-trained-classifier`) and native imports
(`tfjs-native-import`). A bare manifest (metadata only) fails with an explicit error.

## Import (`POST /api/models/import`, multipart `file`)

| Input | Recognition | Behavior |
| --- | --- | --- |
| `.nextool` zip | `package.json` + `model/` entries | Topology + first weight shard extracted, format `tfjs-trained-classifier`, package.json fields (classes/vocabSize/datasetVersion/…) preserved. |
| native tfjs `.zip` | root `model.json` + shard bins | Format `tfjs-native-import`, version `imported`, warning that benchmark compatibility depends on the architecture. |
| bare `.json` manifest | file extension | v1.0.1 compatibility path — requires only `name` + `version`, registered **with the warning** *"Bare manifest imported — contains no native TFJS weights, not runnable for benchmarks."* |
| anything else | — | Rejected: *"Unsupported file type — upload a .nextool, .zip or .json package."* |

Safety and validation:

- **Size limit 25 MiB** per package.
- **No blind extraction:** zip entry names are filtered against path traversal
  (`^[\w./-]+$`, no leading `/`, no `..`); archives without readable entries are
  rejected.
- **Real compatibility check:** binary packages are loaded via
  `tf.loadLayersModel(tf.io.fromMemory(...))` *before* registration; a package whose
  topology/weights do not load is rejected with the TF.js error surfaced verbatim
  (*"Package failed TFJS compatibility validation: …"*).
- Response 201: `{ name, version, format, modelRecordId, runnable, metadata,
  warnings }`. The registered `ModelRecord` stores the parsed package as its manifest.

The same import logic is exposed in the Models view (**Import model** dialog) and via
`nextool model import <file>` (see [CLI](../operations/cli.md)).

## The `.nextool` manifest (metadata-only path, unchanged)

A JSON object posted to `POST /api/models/load` as `{ "manifest": { … } }`. Validation
checks **all five required fields**:

| Field | Type | Rule | Failure message |
| --- | --- | --- | --- |
| `name` | string | non-empty after trim | `name must be a non-empty string` |
| `version` | string | semver-like `/^\d+\.\d+\.\d+/` | `version must be semver-like (e.g. 1.0.0)` |
| `format` | string literal | must equal `"nextool"` | `format must be "nextool"` |
| `architecture` | object | any non-null, non-array object | `architecture must be an object` |
| `compatibility.runtime` | string | non-empty string | `compatibility.runtime must be a string` |

Any violation → HTTP 400 `INVALID_MANIFEST` listing every failed rule. Success creates
a `ModelRecord` with `format: 'nextool-manifest'`, `status: 'registered'` and a note
that it carries no weights. Extra fields are preserved verbatim. Rejected manifests are
never persisted.

## Registry & API surface

| Item | Detail |
| --- | --- |
| Storage | `ModelRecord` table (SQLite): id, name, version, format, status, manifest JSON, sizeBytes, note, createdAt. Formats in practice: `nextool-manifest`, `tfjs-trained-classifier`, `tfjs-native-import`. |
| `GET /api/models` | `engine` (ActiveEngineInfo) + `packages` (max 100, newest first) + `adapters { tfjs: true, nextoolManifest: true, parquet: false }`. |
| `GET /api/models/export` | zip download (see above). |
| `POST /api/models/import` | multipart import (see above). |
| `POST /api/models/load` | metadata-only manifest registration. |

## Versioning rules of thumb

- Trained checkpoint versions look like `tc-<id>`; re-importing/re-training creates new
  records (no dedup) — keep versions distinct to keep the package list meaningful.
- The CoreModule's own version (llm-core `1.0.0`) is tracked separately in
  `version.ts` and is unaffected by registered packages.
