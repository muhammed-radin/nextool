/**
 * NexTool v1.0.2 — @uiw/react-json-view theme tokens mapped to the NexTool
 * blue-glass palette. Plain module (no 'use client') importable anywhere.
 */

import type { CSSProperties } from 'react';

export const NextoolDarkTheme: CSSProperties = {
  '--json-tree-background-color': 'transparent',
  '--json-tree-font-family': 'var(--font-geist-mono), monospace',
  '--json-tree-font-size': '12px',
  '--json-tree-color': 'oklch(0.93 0.012 250)',
  '--json-tree-key-color': 'oklch(0.78 0.12 225)',
  '--json-tree-value-color': 'oklch(0.85 0.05 210)',
  '--json-tree-string-color': 'oklch(0.85 0.1 200)',
  '--json-tree-number-color': 'oklch(0.82 0.14 80)',
  '--json-tree-boolean-color': 'oklch(0.78 0.16 162)',
  '--json-tree-null-color': 'oklch(0.62 0.03 255)',
  '--json-tree-undefined-color': 'oklch(0.62 0.03 255)',
  '--json-tree-border-color': 'oklch(1 0 0 / 10%)',
  '--json-tree-arrow-color': 'oklch(0.68 0.025 255)',
  '--json-tree-highlight-color': 'oklch(0.62 0.19 255 / 22%)',
  '--json-tree-value-quote-color': 'oklch(0.85 0.1 200)',
  '--json-tree-key-quote-color': 'oklch(0.78 0.12 225)',
  '--json-tree-unit-color': 'oklch(0.82 0.14 80)',
} as CSSProperties;
