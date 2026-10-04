/**
 * NexTool Q1 — canonical version metadata.
 * Single source of truth for the application version, CoreModule model version
 * and runtime branding. Documentation, UI badges and /api/system all read this.
 *
 * Version concepts are intentionally kept SEPARATE:
 * - Application Version: bumped per release (currently 1.0.13).
 * - Model Version:       version of the CoreModule decision unit itself
 *                        (llm-core). llm-core is served through the external
 *                        z-ai-web-dev-sdk provider and is NOT locally
 *                        retrained — so it stays 1.0.0. The LOCALLY TRAINABLE
 *                        tool-selection classifier checkpoints moved to model
 *                        version 1.0.3 in v1.0.12 (MCP/VFS/identity-aware
 *                        curriculum) and STAY 1.0.3 in v1.0.13 — the app
 *                        release does NOT change the model version; historical
 *                        1.0.0/1.0.1/1.0.2 checkpoints keep their original
 *                        versions for traceability. The UI must always read
 *                        TRAINED_MODEL_VERSION dynamically — never hardcode.
 * - Dataset Version:     dynamic — version of the most recently updated
 *                        dataset in the registry (never hardcoded here).
 */

export const APP_NAME = 'NexTool Q1';
export const APP_VERSION = '1.0.13';
export const RELEASE_NAME =
  'THE OPERATOR CONSOLE — single-user self-hosted architecture, FS Inspector (VFS + real FS), super-powered MCP client with customizable auth, verification latch, subtool API, await alert()/askForUserAsChoice(), safety-limit continuation';

export const CORE_MODULE_NAME = 'llm-core';
/** CoreModule decision-unit version — llm-core is a provider-served model and
 *  was NOT retrained locally in v1.0.11 (never fabricate external training). */
export const CORE_MODULE_VERSION = '1.0.0';
export const CORE_MODULE_FALLBACK = 'heuristic-fallback';

/**
 * v1.0.12 — semantic version for the LOCALLY TRAINED tool-selection
 * classifier generation (v1.0.3 curriculum: MCP connectors, shared global
 * VFS, NexTool identity, categorization/coding/GK/technology teaching).
 * Trained checkpoints register under this version; historical checkpoints
 * (1.0.0, 1.0.1, 1.0.2) keep their versions. */
export const TRAINED_MODEL_VERSION = '1.0.3';

export const RUNTIME_BRAND = 'NexTool Runtime';
export const REALTIME_TRANSPORT = 'sse' as const;
export const REALTIME_ENDPOINT = '/api/stream';
