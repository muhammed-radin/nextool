---
title: Datasets
category: AI Core
order: 4
---

# Datasets

NexTool stores evaluation/training datasets as JSON. Import, listing, export and
deletion are fully implemented; the Parquet interchange adapter is **not installed in
this environment** and says so instead of pretending.

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

## Splits

The importer computes counts by `split` and stores them on the record:

| Split | Stored column | Purpose |
| --- | --- | --- |
| `train` (default) | `trainSize` | Fitting (once a training adapter exists). |
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

## Export

- `GET /api/datasets/{id}/export?format=json` →
  `{ ok: true, data: { dataset: DatasetInfo, examples: DatasetExample[] } }` — the full,
  re-importable JSON.
- `GET /api/datasets/{id}/export?format=parquet` → HTTP 400
  `{ code: 'PARQUET_UNAVAILABLE', message: 'Parquet adapter is not installed in this
  environment. JSON interchange is fully supported.' }` — an honest refusal, not a
  silent downgrade.
- Any other `format` value → `INVALID_PARAMS` listing the supported options.
- The legacy alias `GET /api/datasets/{id}` behaves identically (export/delete route).
- The console's Export button opens the JSON export in a new tab.

## Deletion

`DELETE /api/datasets/{id}` → `{ ok: true, data: { deleted: true } }`, or
`404 NOT_FOUND` when the id is unknown.

## Storage shape (DatasetRecord)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | cuid | |
| `name`, `version` | string | author-supplied |
| `format` | `"json"` | `parquet` exists in the type union but is never produced today |
| `trainSize` / `valSize` / `testSize` | int | computed at import |
| `examples` | JSON string | the validated example array |
| `categories` | JSON string[] | deduped |
| `note` | string? | |
| `createdAt` / `updatedAt` | datetime | |

## What datasets are (and are not) used for today

- **Used today**: nothing reads them into inference. The active llm-core engine is
  prompt-driven and does not consume datasets. Datasets power the evaluation workflow
  (see [Evaluation](evaluation.md)) and are the preparation ground for a future
  trained matcher (see [Training](training.md)).
- **Not available**: Parquet import/export (adapter not installed), automatic
  train/val splitting, any server-side training run.

## Quick start

```bash
curl -X POST http://localhost:3000/api/datasets/import \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke","version":"0.1.0","examples":[
        {"category":"monitoring","request":"Check the health of server api-01",
         "expectedTool":"server.health","expectedParams":{"serverId":"api-01"},
         "split":"test"}]}'

curl "http://localhost:3000/api/datasets/<id>/export?format=json"
```
