/**
 * Shared API route helpers — ApiEnvelope responses + zod body validation.
 */
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import type { ApiEnvelope } from './types';
import { zodMessage } from './schemas';

export function ok<T>(data: T, status = 200): NextResponse<ApiEnvelope<T>> {
  return NextResponse.json({ ok: true, data } as ApiEnvelope<T>, { status });
}

export function fail(code: string, message: string, status = 400): NextResponse<ApiEnvelope<never>> {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Parse + validate a JSON request body against a zod schema (v1.0.1 §54).
 * Returns either the parsed data or a ready-to-send 400 envelope response.
 * Malformed JSON and schema violations both surface as INVALID_PARAMS with a
 * readable, field-level message.
 */
export async function parseBody<S extends z.ZodType>(
  req: Request,
  schema: S,
  errorCode = 'INVALID_PARAMS',
): Promise<{ data: z.infer<S>; error?: never } | { data?: never; error: NextResponse<ApiEnvelope<never>> }> {
  const raw = await readJson<unknown>(req);
  if (raw === null) {
    return { error: fail(errorCode, 'Request body must be valid JSON', 400) };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return { error: fail(errorCode, `Invalid request — ${zodMessage(result.error)}`, 400) };
  }
  return { data: result.data as z.infer<S> };
}
