/**
 * NexTool Q1 — canonical version metadata.
 * Single source of truth for the application version, CoreModule model version
 * and runtime branding. Documentation, UI badges and /api/system all read this.
 *
 * Version concepts are intentionally kept SEPARATE:
 * - Application Version: bumped per release (currently 1.0.15).
 * - Model Version:       version of the LOCALLY TRAINED tool-selection
 *                        classifier checkpoints. v1.0.15 (THE LEARNED MIND)
 *                        trained the v1.0.4 generation on the massively
 *                        expanded curriculum (coding, errors, GK, languages,
 *                        creative/generative, complex content + patterns,
 *                        self-understanding, PCB/electronics/electricity,
 *                        software/computer engineering, design, intelligent
 *                        improvement, JSON, tool-title+body, AskSelf/
 *                        AskForUser, user events, approval states, terminal
 *                        environments). Historical checkpoints (1.0.0/1.0.1/
 *                        1.0.2/1.0.3) keep their versions for traceability.
 *                        The UI must always read TRAINED_MODEL_VERSION
 *                        dynamically — never hardcode.
 * - CoreModule Version:  llm-core is served through the external
 *                        z-ai-web-dev-sdk provider and is NOT locally
 *                        retrained — it stays 1.0.0.
 * - Dataset Version:     dynamic — version of the most recently updated
 *                        dataset in the registry (never hardcoded here).
 */

export const APP_NAME = 'NexTool Q1';
export const APP_VERSION = '1.0.15';
export const RELEASE_NAME =
  'THE LEARNED MIND — v1.0.4 trained classifier generation on the expanded curriculum (coding, errors, GK, languages, creative, complex/pattern content, self-understanding, PCB/electronics/electricity, software/computer engineering, design, improvement, JSON, tool-title+body, AskSelf/AskForUser, events, approvals, terminal environments) with the checkpoint exported to model-checkpoints/v1.0.4 (TFJS model.zip + model.nextool), three-way tool approval (Accept/Skip/Reject) with the explicit pending/accepted/skipped/rejected/cancelled state machine, real interactive FS terminal (persistent bash sessions, stdin, streaming, Ctrl+C, history, multi-session), real-FS search path fix and verified user-event delivery.';

export const CORE_MODULE_NAME = 'llm-core';
/** CoreModule decision-unit version — llm-core is a provider-served model and
 *  was NOT retrained locally (never fabricate external training). */
export const CORE_MODULE_VERSION = '1.0.0';
export const CORE_MODULE_FALLBACK = 'heuristic-fallback';

/**
 * v1.0.15 — semantic version for the LOCALLY TRAINED tool-selection
 * classifier generation (v1.0.4 curriculum: the expanded knowledge domains
 * of the v1.0.15 spec §1-§9/§50-§57). Trained checkpoints register under
 * this version; historical checkpoints (1.0.0, 1.0.1, 1.0.2, 1.0.3) keep
 * their versions. */
export const TRAINED_MODEL_VERSION = '1.0.4';

export const RUNTIME_BRAND = 'NexTool Runtime';
export const REALTIME_TRANSPORT = 'sse' as const;
export const REALTIME_ENDPOINT = '/api/stream';
