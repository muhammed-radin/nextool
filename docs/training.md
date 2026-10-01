---
title: Training
category: AI Core
order: 5
---

# Training

An honest account: what "training" means in NexTool v1.0.1 today, what infrastructure
already exists, and exactly which parts are pending the TensorFlow.js adapter.

## Current state

| Capability | Status |
| --- | --- |
| Dataset import/versioning (JSON) | ✅ Implemented — see [Datasets](datasets.md). |
| `.nextool` manifest validation + registration | ✅ Implemented — see [Model Format](model-format.md). |
| Learning from live feedback (runtime, not weight training) | ✅ Implemented — `user.feedback` events are stored as memory entries (`feedback_<taskId>`) and revise active subgoals; `learnFrom.results` config exists for future result-driven learning. |
| Weight training of a local model | ❌ **Not implemented.** No TensorFlow.js runtime is installed in this environment; no trainer code exists. |
| Serving a locally trained model | ❌ **Not implemented** — the inference adapter that would load `model.json` + `.bin` is pending. |
| Parquet interchange for large corpora | ❌ **Not installed** — JSON only. |

## What "training data" is available today

The runtime continuously produces supervised-style signal, all persisted in SQLite:

| Source | Table | Usable as |
| --- | --- | --- |
| Imported datasets | `DatasetRecord.examples` | The canonical eval/training set with `expectedTool` / `expectedParams` / `split`. |
| Real decisions | `TaskEvent` rows of type `core.decision` | Objective + chosen tool + params + confidence + engine per decision. |
| Ground truth outcomes | `HistoryEntry` (params/result/status per execution) | Verification that a chosen tool call actually succeeded. |
| User corrections | `MemoryEntry` keys `feedback_<taskId>` | Negative/positive correction pairs ("this decision was wrong, correct action was X"). |

A future trainer would join these: `core.decision` (prediction) × `HistoryEntry`
(outcome) × feedback (correction) × imported datasets (expected values).

## Preparing a dataset (what you can do today)

1. Author examples in the documented JSON shape
   (`{ category, request, expectedTool?, expectedParams?, split? }`, ≤ 5000 per import).
2. Import via the Datasets view or `POST /api/datasets/import`; keep versions distinct
   (`smoke 0.1.0` → `smoke 0.2.0`).
3. Split deliberately: `train` for fitting, `validation` for tuning, `test` held out.
4. Export (`GET /api/datasets/{id}/export?format=json`) to hand the exact bytes to an
   external trainer, or to version-control them.

The example records are intentionally schema-compatible with a future classifier: given
`request` (+ category context), predict `expectedTool` and `expectedParams` — the same
contract CoreModule serves live.

## Commands that actually exist

There are no training scripts. The relevant project commands (from `package.json`) are:

```bash
bun run dev           # next dev -p 3000
bun run build         # next build (standalone) + static/public copy
bun run start         # production server
bun run lint          # eslint
bun run db:push       # prisma db push (schema sync)
bun run db:generate   # prisma generate
bun run db:migrate    # prisma migrate dev
bun run db:reset      # prisma migrate reset
```

Any future trainer would be added as a `scripts/` entry alongside these (`bun
scripts/train.ts` is the natural shape given Bun is the project's script runtime) — none
exists in v1.0.1.

## Path to real training (pending TF.js adapter)

1. **Adapter** — install a TF.js runtime, implement a loader for `.nextool` packages
   (`model.json` + weight shards), flip the package `status` `registered → active`.
2. **Trainer** — train a small sequence classifier (request tokens → tool id) on the
   `train` split; validate on `validation`; package weights as `model.json` + `.bin`
   with a manifest whose `compatibility.runtime` names the installed runtime.
3. **Load** — `POST /api/models/load` registers the package; the adapter flips the
   engine, and `/api/models` reports the new active engine.
4. **Evaluate** — run the benchmark plan in [Evaluation](evaluation.md) against the
   `test` split; llm-core stays available as a fallback path either way.

Until step 1 happens, training-related screens in the console remain honest: the Models
view shows `tfjs: false`, and datasets are stored/versioned but not consumed.
