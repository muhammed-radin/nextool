/**
 * NexTool v1.0.4 — @uiw/react-json-view theme tokens mapped to the NexTool
 * blue-glass palette. Plain module (no 'use client') importable anywhere.
 *
 * v1.0.4 §2 (JSON tree visibility fix): the installed library version
 * (2.0.0-alpha.43) reads `--w-rjv-*` custom properties ONLY. The previous
 * theme set `--json-tree-*` variables, which this version ignores — every
 * syntax color silently fell back to the library's dark default (#002b36 …),
 * i.e. near-invisible text on the console's dark glass background. The theme
 * below uses the REAL variable names with a bright, dark-console syntax
 * palette (high contrast against the .glass-inset navy well):
 *
 *   keys → bright sky      strings → bright green
 *   numbers → bright amber booleans → bright orange
 *   null/undefined → bright rose / slate
 *   braces/brackets → cyan  colons → readable slate
 *
 * Verified against node_modules/@uiw/react-json-view/cjs/theme/nord.js
 * (the library's own dark theme) so every token below is actually consumed.
 */

import type { CSSProperties } from 'react';

export const NextoolDarkTheme: CSSProperties = {
  // Base text — anything not otherwise tokenized (e.g. nested containers).
  '--w-rjv-color': 'oklch(0.93 0.015 240)',

  // Keys (including their quotes).
  '--w-rjv-key-string': 'oklch(0.88 0.09 225)',
  '--w-rjv-quotes-color': 'oklch(0.80 0.07 225)',
  '--w-rjv-quotes-string-color': 'oklch(0.88 0.12 155)',

  // Type colors — the actual values.
  '--w-rjv-type-string-color': 'oklch(0.88 0.12 155)',
  '--w-rjv-type-int-color': 'oklch(0.88 0.12 85)',
  '--w-rjv-type-float-color': 'oklch(0.86 0.13 70)',
  '--w-rjv-type-bigint-color': 'oklch(0.88 0.12 85)',
  '--w-rjv-type-boolean-color': 'oklch(0.85 0.13 60)',
  '--w-rjv-type-date-color': 'oklch(0.85 0.10 200)',
  '--w-rjv-type-url-color': 'oklch(0.85 0.09 230)',
  '--w-rjv-type-null-color': 'oklch(0.80 0.09 10)',
  '--w-rjv-type-nan-color': 'oklch(0.86 0.13 70)',
  '--w-rjv-type-undefined-color': 'oklch(0.80 0.02 250)',

  // Structure — braces, brackets, colons, arrows.
  '--w-rjv-curlybraces-color': 'oklch(0.88 0.08 210)',
  '--w-rjv-brackets-color': 'oklch(0.88 0.08 210)',
  '--w-rjv-colon-color': 'oklch(0.72 0.02 250)',
  '--w-rjv-arrow-color': 'oklch(0.82 0.08 225)',

  // Chrome — lines, edit highlight, copy feedback, metadata ("info").
  '--w-rjv-background-color': 'transparent',
  '--w-rjv-line-color': 'oklch(1 0 0 / 10%)',
  '--w-rjv-edit-color': 'oklch(0.88 0.09 225)',
  '--w-rjv-info-color': 'oklch(0.70 0.02 250 / 55%)',
  '--w-rjv-update-color': 'oklch(0.85 0.09 225 / 55%)',
  '--w-rjv-copied-color': 'oklch(0.85 0.09 225)',
  '--w-rjv-copied-success-color': 'oklch(0.85 0.13 155)',

  // Font — matches the console's mono stack (also set inline by JsonTree).
  '--w-rjv-font-family': 'var(--font-geist-mono), monospace',
} as CSSProperties;
