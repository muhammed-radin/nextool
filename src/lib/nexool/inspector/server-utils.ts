/**
 * NexTool v1.0.13 §2 — server-side helpers shared by the FS Inspector routes
 * (vfs / fs / terminal). Server-only: uses node:crypto and Buffer.
 */

import crypto from 'node:crypto';
import { fail } from '@/lib/nexool/api-helpers';

/** Operator listing cap — a directory dump is capped, not unbounded. */
export const LIST_ENTRY_CAP = 500;
/** Preview cap: at most the first 64 KiB is returned for previews/reads. */
export const READ_PREVIEW_BYTES = 64 * 1024;
/** Files larger than 2 MiB are refused for preview (honest error, no slice). */
export const READ_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Hard cap for `write` mutations (spec §2: 8 MB). */
export const WRITE_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Hard cap for total uncompressed ZIP payload (download/zip ops). */
export const ZIP_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** Search depth cap (spec §2.6) and result cap. */
export const SEARCH_MAX_DEPTH = 10;
export const SEARCH_RESULT_CAP = 200;
/** Checksums computed only for files up to this size (spec §2.8). */
export const CHECKSUM_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Per-file upload cap (mirrors the write cap). */
export const UPLOAD_MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Detect whether a byte buffer is valid UTF-8 text: no NUL bytes and the
 * utf8-decode → re-encode roundtrip must be lossless. `allowBrokenTail`
 * tolerates a truncated trailing multi-byte sequence (the preview slice can
 * cut a code point in half) by ignoring up to 3 trailing bytes.
 */
export function looksTextual(buf: Buffer, allowBrokenTail = false): boolean {
  if (buf.includes(0)) return false;
  const tries = allowBrokenTail ? 4 : 1;
  let probe = buf;
  for (let i = 0; i < tries; i++) {
    const text = probe.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(probe)) return true;
    if (!allowBrokenTail) return false;
    probe = buf.subarray(0, buf.length - (i + 1));
    if (probe.length === 0) return true;
  }
  return false;
}

/** SHA-256 hex checksum of a buffer. */
export function sha256Hex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Content-Disposition header value with an ASCII fallback plus a RFC 5987
 * `filename*` for non-ASCII names.
 */
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename)
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, ' ');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Build the attachment Response for file/zip downloads. */
export function downloadResponse(data: Buffer, filename: string, zip: boolean): Response {
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': zip ? 'application/zip' : 'application/octet-stream',
      'Content-Length': String(data.length),
      'Content-Disposition': contentDisposition(filename),
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * First-available destination name inside a target directory.
 *  - style 'copy'    → "name (copy)", "name (copy 2)", …
 *  - style 'numeric' → "name (2)", "name (3)", …
 */
export function uniqueName(existing: Set<string>, desired: string, style: 'copy' | 'numeric'): string {
  if (!existing.has(desired)) return desired;
  for (let n = 1; n < 10_000; n++) {
    const candidate = style === 'copy' ? (n === 1 ? `${desired} (copy)` : `${desired} (copy ${n})`) : `${desired} (${n + 1})`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${desired} (${Date.now()})`;
}

/** The last path segment of a virtual/relative path (client-provided names are sanitized with this). */
export function baseNameOf(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] ?? '';
}

/** Reject names that cannot appear inside a directory (spec §2: rename/new names). */
export function isValidEntryName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    name !== '.' &&
    name !== '..' &&
    name.trim() === name
  );
}

/** Uniform parse failure response for POST JSON bodies. */
export function invalidOp(op: unknown): ReturnType<typeof fail> {
  return fail(
    'INVALID_PARAMS',
    `Unsupported or missing inspector op "${String(op ?? '')}" — see the NexTool FS Inspector API docs.`,
    400,
  );
}
