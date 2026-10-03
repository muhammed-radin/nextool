---
title: Datasets
category: AI Core
order: 4
---

# Datasets

NexTool stores evaluation/training datasets as structured examples in the registry.
Interchange happens at the import/export boundary in two formats, both **fully
implemented**: human-readable **JSON** and binary, column-oriented **Parquet** (real
since v1.0.3 via `@dsnp/parquetjs`).

| | JSON | Parquet |
| --- | --- | --- |
| Shape | Human-readable row payload (`{ examples: [...] }`) | Binary columnar file (`.parquet`) |
| Best for | Small datasets, hand-edited payloads, diffs | Larger datasets — efficient storage/compression, standard in analytics/training pipelines |
| Import | JSON body or multipart `.json` file | multipart `.parquet` file |
| Export | `?format=json` (default) | `?format=parquet` |

## JSON import format

`POST /api/datasets/import` with a `DatasetImportPayload`:

```jsonc
{
  "name": "tool-matching-core",          // required, non-empty string
  "version": "1.0.0",                    // required, non-empty string
  "note": "seed examples for core eval", // optional
  "examples": [                          // required, 1..5000 items
    {
      "category": "monitoring",          // required, non-empty string
      "request": "Check the health of server api-01",  // required, non-empty string
      "expectedTool": "server.health",   // optional
      "expectedParams": { "serverId": "api-01" },      // optional object
      "split": "train"                   // optional: train | validation | test
    }
  ]
}
```

Validation (`route.ts`):

- `name`, `version` non-empty strings; `examples` a non-empty array; hard cap
  **5000 examples** (`MAX_EXAMPLES`) — violations return `INVALID_PARAMS` with the exact
  reason.
- Each example must have string `category` and `request`; bad items collect into an
  `INVALID_EXAMPLES` error listing up to 5 problems (plus a count of the rest).
- `expectedTool` must be a string; `expectedParams` must be a plain object;
  `split` values other than `validation`/`test` default to **`train`**.

## Parquet interchange (v1.0.3)

The adapter lives in **one module** — `src/lib/nexool/datasets/parquet.ts` — so the web
console, the HTTP API and the CLI share the exact same encode/decode behavior. It is
built on **`@dsnp/parquetjs` 1.8.9** (pinned exactly — see
[Troubleshooting](../operations/troubleshooting.md) for why newer 1.9.x tarballs are not
used), a pure-JavaScript Parquet reader/writer that runs in the Node.js runtime and Bun.
No native binaries. `next.config.ts` lists it in `serverExternalPackages`, so the adapter
is `require`d from `node_modules` at runtime instead of being bundled.

Parquet is a binary, **column-oriented** storage format: values are grouped per column
and compressed together, which makes it efficient to store and scan larger datasets.
JSON is the opposite trade-off — human-readable rows, convenient for small datasets and
hand-editing.

### Column schema (flat, one row per example)

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `category` | UTF8 | **yes** | non-empty string |
| `request` | UTF8 | **yes** | non-empty string |
| `expectedTool` | UTF8 | optional | |
| `expectedParams` | UTF8 | optional | **JSON-serialized object** (e.g. `"{\"serverId\":\"api-01\"}"`) |
| `split` | UTF8 | defaults `train` | must be `train` \| `validation` \| `test` |

Decoding validates every row with the same rules as the JSON importer (category/request
required, split vocabulary, `expectedParams` must parse to a JSON **object**). A bad row
aborts with a readable message that includes the row index, e.g.
`Parquet row 12: expectedParams is not a JSON object string.` Empty files are rejected.

### Import (multipart)

`POST /api/datasets/import` now accepts **two content types**:

- `application/json` — the original body payload (above). Unchanged.
- `multipart/form-data` — fields:
  - `file` *(required)* — a `.parquet` or `.json` file (≤ **25 MiB** upload cap, mirroring
    the model import cap);
  - `name`, `version`, `note` — optional form fields; `name`/`version` fall back to the
    file name / `1.0.0` when omitted.

A `.parquet` upload is decoded by the adapter, then the resulting examples go through
the same validation as the JSON path. The dataset record's `format` field records the
import format (`"parquet"`). Errors surface as `INVALID_PARAMS` with the adapter's
message.

### Export (binary download)

- `GET /api/datasets/{id}/export?format=parquet` → the examples are encoded with the
  adapter and returned as `application/octet-stream` with
  `Content-Disposition: attachment; filename="<name>-v<version>.parquet"`. Encoding
  failures return 500 `PARQUET_EXPORT_FAILED` with the adapter's message.
- `GET /api/datasets/{id}/export?format=json` (default) → the original JSON envelope.
  Any other `format` value → `INVALID_PARAMS` listing the supported options.
- The legacy alias `GET /api/datasets/{id}` supports the same `?format=parquet` export
  (export/delete route).

### Capability detection (honest)

`parquetAdapterInfo()` attempts the real dynamic `import('@dsnp/parquetjs')` **once per
process** (cached on `globalThis`) and reports `{ available, packageName, error }` —
nothing is faked. `/api/models` exposes it:

```json
{ "adapters": { "tfjs": true, "nextoolManifest": true, "parquet": true } }
```

Because the adapter is installed, the Datasets view no longer shows a "not installed"
warning; it shows a JSON-vs-Parquet comparison note instead, and dataset cards carry
separate **JSON** and **Parquet** export buttons (parquet format badge is cyan).

### CLI

```bash
nextool dataset import data.parquet -n tool-matching-core -v 1.0.0
nextool dataset export tool-matching-core --format parquet -o ./out.parquet
```

`dataset import` decodes `.parquet` through the same adapter (`.json` unchanged);
`dataset export` accepts `--format json|parquet` — for parquet the binary file is
written and `--output` is **required** (there is no stdout binary mode; JSON keeps the
stdout default).

## Shipped seed dataset (v1.0.10)

The repository ships a ready-to-import training seed at
**`config/training/seed-dataset-v1.0.1.json`** — *"NexTool Core v1.0.1 Seed"*, version
`1.0.1`:

- **170 examples** — split **121 train / 23 validation / 26 test** (~71% / 13.5% / 15.3%).
- **All 15 registered tools covered in train AND test** (the test split is the
  benchmark split, so every tool class is scoreable on held-out data).
- **Robustness material**: paraphrases, synonyms, typos, ambiguous/confusing pairs and
  conversational wording of the same intents.
- **Parameter-generation examples**: `expectedParams` values sit inside the real tool
  schemas (serverIds, timezones, uuid counts, ms durations, …).
- **Zero duplicate request strings** — no split leakage; each phrasing appears once.

Import it through `POST /api/datasets/import` (JSON body or multipart file) or the CLI
(`nextool dataset import config/training/seed-dataset-v1.0.1.json`). The v1.0.10
training generation (model 1.0.1) and the recorded release benchmark were built on this
dataset — see [Training](training.md) and [Benchmarks](benchmarks.md).

## Splits

The importer computes counts by `split` and stores them on the record:

| Split | Stored column | Purpose |
| --- | --- | --- |
| `train` (default) | `trainSize` | Fitting (the TF.js training engine). |
| `validation` | `valSize` | Hyperparameter/overfit checks. |
| `test` | `testSize` | Held-out final evaluation. |

The Datasets view renders each dataset's split proportions as segmented bars. There is
no automatic splitting — authors control splits per example.

## Versioning

- Every import creates a **new `DatasetRecord`** (id = cuid). Re-importing the same
  name with a new `version` gives you a new, independent record; nothing is mutated
  in place.
- `GET /api/datasets` lists up to 100 records, newest update first, each with
  `{ id, name, version, format, trainSize, valSize, testSize, categories, note,
  createdAt, updatedAt }`.
- `categories` is the deduped set of example categories — also what the Dashboard uses
  for the global "latest dataset version" indicator (`SystemStats.datasetVersion`).

## Deletion

`DELETE /api/datasets/{id}` → `{ ok: true, data: { deleted: true } }`, or
`404 NOT_FOUND` when the id is unknown.

**v1.0.7 — dependency-aware cleanup:** `GET|POST /api/maintenance/cleanup` (and
Settings → Maintenance) can remove datasets that are proven ORPHANED — not
referenced by any training job or benchmark run. Referenced (required) datasets and
all training artifacts are protected; the cleanup is idempotent and every run
produces a traceable report. Deleting by hand is unchanged.

## Storage shape (DatasetRecord)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | cuid | |
| `name`, `version` | string | author-supplied |
| `format` | `"json" \| "parquet"` | the import format of this record |
| `trainSize` / `valSize` / `testSize` | int | computed at import |
| `examples` | JSON string | the validated example array (structured, regardless of import format) |
| `categories` | JSON string[] | deduped |
| `note` | string? | |
| `createdAt` / `updatedAt` | datetime | |

## What datasets are used for

- **Training** — the TF.js training engine reads a dataset's labeled examples
  (`expectedTool`) and fits the tool-selection classifier (see [Training](training.md)).
  ≥ 4 labeled examples across ≥ 2 distinct tools are required.
- **Benchmarking** — the `tool-selection` benchmark scores a decision unit against
  labeled examples with a `test` → `validation` → all split preference (see
  [Benchmarks](benchmarks.md)).
- **Encoding only** — Parquet/JSON are the import/export encodings at the boundary.
  Examples always live in the registry as structured records, so training consumes the
  same examples regardless of the format they arrived in.
- **Not available**: automatic train/val splitting; any server-side fine-tuning of
  llm-core (the active engine is prompt-driven and does not consume datasets).

## Quick start

```bash
# JSON body import (unchanged)
curl -X POST http://localhost:3000/api/datasets/import \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke","version":"0.1.0","examples":[
        {"category":"monitoring","request":"Check the health of server api-01",
         "expectedTool":"server.health","expectedParams":{"serverId":"api-01"},
         "split":"test"}]}'

# Parquet file import (multipart)
curl -X POST http://localhost:3000/api/datasets/import \
  -F "file=@examples.parquet" -F "name=smoke-parquet" -F "version=0.1.0"

# Binary Parquet export
curl -OJ "http://localhost:3000/api/datasets/<id>/export?format=parquet"

curl "http://localhost:3000/api/datasets/<id>/export?format=json"
```
