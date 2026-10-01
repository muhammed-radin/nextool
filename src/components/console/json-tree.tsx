'use client';

/**
 * NexTool v1.0.2 — ONE consistent JSON tree viewer for the whole console
 * (spec §74-77). Built on @uiw/react-json-view (maintained library), themed to
 * the NexTool blue-glass palette, responsive: long strings wrap instead of
 * breaking layout, containers scroll inside a capped height.
 */

import { useState } from 'react';
import JsonView, { type JsonViewProps } from '@uiw/react-json-view';
import { NextoolDarkTheme } from './json-theme';

type JsonViewPropsSafe = Omit<JsonViewProps<object>, 'value' | 'style'>;

/**
 * Interactive JSON tree. Falls back to formatted text for primitives and to a
 * readable error for non-serializable values (never throws, never blank).
 */
export function JsonTree({ value, maxHeight = 320, ...rest }: JsonViewPropsSafe & { value: unknown; maxHeight?: number }) {
  const [copied, setCopied] = useState(false);

  if (value === undefined || value === null || typeof value !== 'object') {
    return (
      <pre
        className="glass-inset nextool-scroll overflow-auto rounded-md p-3 font-mono text-xs leading-relaxed text-sky-100/80"
        style={{ maxHeight }}
      >
        {value === undefined ? 'undefined' : value === null ? 'null' : String(value)}
      </pre>
    );
  }

  return (
    <div className="glass-inset nextool-scroll relative overflow-auto rounded-md p-3" style={{ maxHeight }}>
      <JsonView
        value={value as object}
        displayDataTypes={false}
        enableClipboard={true}
        onCopied={() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        collapsed={2}
        shortenTextAfterLength={120}
        style={{
          ...NextoolDarkTheme,
          fontFamily: 'var(--font-geist-mono), monospace',
          fontSize: '12px',
          lineHeight: 1.55,
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap',
        }}
        {...rest}
      />
      {copied ? (
        <span className="pointer-events-none absolute right-2 top-2 rounded bg-emerald-400/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
          copied
        </span>
      ) : null}
    </div>
  );
}
