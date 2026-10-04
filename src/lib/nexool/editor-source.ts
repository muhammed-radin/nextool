/**
 * NexTool v1.0.5 §1/§4 — tool editor SOURCE-SYNC invariants as pure functions.
 *
 * The v1.0.5 incident: clicking Test could leave the Monaco editor blank.
 * Root causes addressed here, at every editor write/read path:
 *
 *  1. `coerceEditorChange` — editor onChange can fire with undefined/null
 *     (model swaps, remounts). These are NOT user edits and must never
 *     overwrite the source with "" — the previous value wins.
 *  2. `readMonacoValue` — reading the model of a DISPOSED editor (mobile tab
 *     switch unmounts Monaco) throws or returns garbage; the `source` state
 *     (kept in sync) is the fallback. A dead editor is never trusted.
 *
 * Used by the Tool IDE for BOTH the Monaco and textarea surfaces (§4.4 —
 * neither editor owns an independent copy of the code).
 */

/**
 * Guard an editor change before it reaches the shared `functionSource` state.
 * Returns the value that should be written into the source state.
 *
 *   coerceEditorChange(undefined, 'code') → 'code'   (never clears)
 *   coerceEditorChange(null,       'code') → 'code'   (never clears)
 *   coerceEditorChange('',         'code') → ''        (a real user clearing)
 *   coerceEditorChange('next',     'code') → 'next'
 */
export function coerceEditorChange(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value;
}

/**
 * Read the CURRENT code exactly as visible in Monaco (§1.2). If the editor is
 * unmounted/disposed — getValue throws or yields a non-string — the shared
 * source state is returned instead. Never returns undefined.
 */
export function readMonacoValue(read: () => string | undefined | null, fallback: string): string {
  try {
    const value = read();
    return typeof value === 'string' ? value : fallback;
  } catch {
    // Model disposed (tab switch / editor swap) — state is the screen truth.
    return fallback;
  }
}
