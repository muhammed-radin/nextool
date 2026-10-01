/**
 * Shared API route helpers — ApiEnvelope responses.
 */
import { NextResponse } from 'next/server';
import type { ApiEnvelope } from './types';

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
