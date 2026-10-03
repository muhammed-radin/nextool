/**
 * NexTool Q1 — canonical version metadata.
 * Single source of truth for the application version, CoreModule model version
 * and runtime branding. Documentation, UI badges and /api/system all read this.
 *
 * Version concepts are intentionally kept SEPARATE:
 * - Application Version: bumped per release (currently 1.0.11).
 * - Model Version:       version of the CoreModule decision unit itself
 *                        (llm-core). It has NOT changed in v1.0.11 — llm-core
 *                        is served through the external z-ai-web-dev-sdk
 *                        provider and is NOT locally retrained — so it stays
 *                        1.0.0. The LOCALLY TRAINABLE tool-selection
 *                        classifier checkpoints move to model version 1.0.2
 *                        in this release (expanded long-context dataset +
 *                        checkpoint selection); historical 1.0.0/1.0.1
 *                        checkpoints keep their original versions for
 *                        traceability.
 * - Dataset Version:     dynamic — version of the most recently updated
 *                        dataset in the registry (never hardcoded here).
 */

export const APP_NAME = 'NexTool Q1';
export const APP_VERSION = '1.0.11';
export const RELEASE_NAME =
  'THE EMPOWERMENT — pre-plan failure recovery, freedom-node, auto-execution hierarchy (model 1.0.2)';

export const CORE_MODULE_NAME = 'llm-core';
/** CoreModule decision-unit version — llm-core is a provider-served model and
 *  was NOT retrained locally in v1.0.11 (never fabricate external training). */
export const CORE_MODULE_VERSION = '1.0.0';
export const CORE_MODULE_FALLBACK = 'heuristic-fallback';

/**
 * v1.0.11 — semantic version for the LOCALLY TRAINED tool-selection
 * classifier generation (expanded long-context/Markdown dataset, validation-
 * based checkpoint selection). Trained checkpoints register under this
 * version; historical checkpoints (1.0.0, 1.0.1) keep their versions. */
export const TRAINED_MODEL_VERSION = '1.0.2';

export const RUNTIME_BRAND = 'NexTool Runtime';
export const REALTIME_TRANSPORT = 'sse' as const;
export const REALTIME_ENDPOINT = '/api/stream';
