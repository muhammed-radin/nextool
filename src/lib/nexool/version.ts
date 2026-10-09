/**
 * NexTool Q1 — canonical version metadata.
 * Single source of truth for the application version, CoreModule model version
 * and runtime branding. Documentation, UI badges and /api/system all read this.
 *
 * Version concepts are intentionally kept SEPARATE:
 * - Application Version: bumped per release (currently 1.1.0 — the first
 *                        minor-batch promotion after the completed v1.0.x
 *                        series, not v1.0.17).
 * - Model Version:       version of the LOCALLY TRAINED tool-selection
 *                        classifier checkpoints. v1.0.16 (FAST HANDS, SHARP
 *                        MIND) trained the v1.0.5 generation on the expanded
 *                        coding curriculum (HTML, CSS, JavaScript, TypeScript,
 *                        JSX/TSX, Python, Markdown, JSON, C, C++, SQL,
 *                        Shell/Bash), error/stack-trace interpretation,
 *                        debugging and recovery, plus the retained v1.0.4
 *                        domains (GK, languages, creative/generative, complex
 *                        content + patterns, self-understanding, PCB/
 *                        electronics/electricity, software/computer
 *                        engineering, design, intelligent improvement, tool
 *                        title+body, AskSelf/AskForUser, user events, approval
 *                        states, terminal environments). It also reduced
 *                        avoidable heuristic-fallback routing with explicit
 *                        fallback-reason diagnostics and concurrent classifier
 *                        hinting. Historical checkpoints (1.0.0/1.0.1/1.0.2/
 *                        1.0.3/1.0.4) keep their versions for traceability.
 *                        The UI must always read TRAINED_MODEL_VERSION
 *                        dynamically — never hardcode.
 * - CoreModule Version:  llm-core is served through the external
 *                        z-ai-web-dev-sdk provider and is NOT locally
 *                        retrained — it stays 1.0.0.
 * - Dataset Version:     dynamic — version of the most recently updated
 *                        dataset in the registry (never hardcoded here).
 */

export const APP_NAME = 'NexTool Q1';
export const APP_VERSION = '1.1.0';
export const RELEASE_NAME =
  'First minor-batch promotion (v1.0.13 – v1.0.16 → v1.1.0): real-time CoreModule Live Output — actual provider token streaming over a dedicated SSE channel rendered in ~10-word batches in Task Preview — plus Continue Task (new linked follow-up tasks with seeded prior context), fork-from-recent-task in Task Console, four new file-editing tools (fs.apply_edits, fs.find_replace, fs.insert_text, fs.append_text), the Our Products showcase, a rebuilt real-FS terminal on plain node:child_process spawn-per-command execution with a shared xterm.js shell UI (bold block cursor, distinct VFS theme, server-side VFS shell), fully centralized application limits (core/planner LLM timeouts, terminal, skills, events, VFS allowed commands) with Standard and Complete Unrestricted presets, multi-skill selection in Task Console, reliable force-stop with provider-call and child-process cancellation, the executeAllPlannedSteps pre-plan option, and the removal of the hidden 25-second CoreModule timeout in favor of configurable, diagnostics-reported deadlines.';

export const CORE_MODULE_NAME = 'llm-core';
/** CoreModule decision-unit version — llm-core is a provider-served model and
 *  was NOT retrained locally (never fabricate external training). */
export const CORE_MODULE_VERSION = '1.0.0';
export const CORE_MODULE_FALLBACK = 'heuristic-fallback';

/**
 * v1.0.16 — semantic version for the LOCALLY TRAINED tool-selection
 * classifier generation (v1.0.5 curriculum: the expanded coding languages +
 * error/debugging domains of the v1.0.16 spec §5, on top of the retained
 * v1.0.4 curriculum). Trained checkpoints register under this version;
 * historical checkpoints (1.0.0, 1.0.1, 1.0.2, 1.0.3, 1.0.4) keep their
 * versions. */
export const TRAINED_MODEL_VERSION = '1.0.5';

export const RUNTIME_BRAND = 'NexTool Runtime';
export const REALTIME_TRANSPORT = 'sse' as const;
export const REALTIME_ENDPOINT = '/api/stream';
