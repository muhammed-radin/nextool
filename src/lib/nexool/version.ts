/**
 * NexTool Q1 — canonical version metadata.
 * Single source of truth for the application version, CoreModule model version
 * and runtime branding. Documentation, UI badges and /api/system all read this.
 *
 * - Application Version: bumped per release (currently 1.0.1).
 * - Model Version:       version of the CoreModule decision unit itself
 *                        (llm-core). It has NOT changed in v1.0.1 — only the
 *                        application around it was enhanced — so it stays 1.0.0.
 */

export const APP_NAME = 'NexTool Q1';
export const APP_VERSION = '1.0.1';
export const RELEASE_NAME = 'Enhancement, Responsive UI, Connectivity, Documentation & Completion';

export const CORE_MODULE_NAME = 'llm-core';
/** CoreModule decision-unit version — unchanged since v1.0.0 (model did not change). */
export const CORE_MODULE_VERSION = '1.0.0';
export const CORE_MODULE_FALLBACK = 'heuristic-fallback';

export const RUNTIME_BRAND = 'NexTool Runtime';
export const REALTIME_TRANSPORT = 'sse' as const;
export const REALTIME_ENDPOINT = '/api/stream';
