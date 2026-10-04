/**
 * Built-in tool handlers — real implementations (node:os, crypto, safe math parser, Intl).
 */
import os from 'node:os';
import crypto from 'node:crypto';
import type { ToolHandler } from './handler';
import { ToolFailure } from './handler';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------- system.info ----------

export const systemInfo: ToolHandler = async () => {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    freeMemGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
    loadavg: os.loadavg().map((v) => Math.round(v * 100) / 100),
    uptimeSec: Math.round(os.uptime()),
    nodeVersion: process.version,
  };
};

// ---------- math.evaluate (safe recursive-descent parser — never eval/Function) ----------

export function evaluateExpression(input: string): number {
  const src = input.replace(/\s+/g, '');
  if (!src || src.length > 200) throw new ToolFailure('Expression empty or too long (max 200 chars).', 'INVALID_PARAMS');
  if (!/^[0-9+\-*/%().]+$/.test(src)) throw new ToolFailure('Expression contains illegal characters. Allowed: digits + - * / % ( ) .', 'INVALID_PARAMS');

  let pos = 0;
  const peek = () => src[pos];

  function parseExpr(): number {
    let value = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = src[pos++];
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  function parseTerm(): number {
    let value = parseFactor();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = src[pos++];
      const rhs = parseFactor();
      if ((op === '/' || op === '%') && rhs === 0) throw new ToolFailure('Division by zero.', 'INVALID_PARAMS');
      value = op === '*' ? value * rhs : op === '/' ? value / rhs : value % rhs;
    }
    return value;
  }

  function parseFactor(): number {
    if (peek() === '+') {
      pos++;
      return parseFactor();
    }
    if (peek() === '-') {
      pos++;
      return -parseFactor();
    }
    return parseAtom();
  }

  function parseAtom(): number {
    if (peek() === '(') {
      pos++;
      const value = parseExpr();
      if (peek() !== ')') throw new ToolFailure('Unbalanced parenthesis.', 'INVALID_PARAMS');
      pos++;
      return value;
    }
    const start = pos;
    while (pos < src.length && /[0-9.]/.test(src[pos])) pos++;
    if (start === pos) throw new ToolFailure(`Unexpected character at position ${pos}.`, 'INVALID_PARAMS');
    const num = Number(src.slice(start, pos));
    if (!Number.isFinite(num)) throw new ToolFailure(`Invalid number: ${src.slice(start, pos)}`, 'INVALID_PARAMS');
    return num;
  }

  const result = parseExpr();
  if (pos !== src.length) throw new ToolFailure(`Unexpected character at position ${pos}.`, 'INVALID_PARAMS');
  if (!Number.isFinite(result)) throw new ToolFailure('Expression result is not a finite number.', 'INVALID_PARAMS');
  return Math.round(result * 1e10) / 1e10;
}

export const mathEvaluate: ToolHandler = async (params) => {
  const expression = String(params.expression ?? '').trim();
  if (!expression) throw new ToolFailure('Missing required param: expression', 'INVALID_PARAMS');
  const result = evaluateExpression(expression);
  return { expression, result };
};

// ---------- text.analyze ----------

export const textAnalyze: ToolHandler = async (params) => {
  const text = String(params.text ?? '');
  if (!text.trim()) throw new ToolFailure('Missing required param: text', 'INVALID_PARAMS');
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const sentences = text.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0);
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

  const freq = new Map<string, number>();
  for (const w of words) {
    if (w.length < 3) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  const topWords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word, count]) => ({ word, count }));

  return {
    chars: text.length,
    words: words.length,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    topWords,
  };
};

// ---------- time.now ----------

export const timeNow: ToolHandler = async (params) => {
  const now = new Date();
  const timezone = params.timezone ? String(params.timezone) : 'UTC';
  let formatted: string;
  try {
    formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'long',
    }).format(now);
  } catch {
    throw new ToolFailure(`Unknown timezone: ${timezone}`, 'INVALID_PARAMS');
  }
  return {
    iso: now.toISOString(),
    unixMs: now.getTime(),
    timezone,
    formatted,
  };
};

// ---------- uuid.generate ----------

export const uuidGenerate: ToolHandler = async (params) => {
  const raw = params.count === undefined ? 1 : Number(params.count);
  if (!Number.isFinite(raw)) throw new ToolFailure('count must be a number', 'INVALID_PARAMS');
  const count = Math.min(Math.max(Math.round(raw), 1), 10);
  const uuids: string[] = [];
  for (let i = 0; i < count; i++) uuids.push(crypto.randomUUID());
  return { count, uuids };
};

// ---------- echo.echo ----------

export const echoEcho: ToolHandler = async (params) => {
  if (params.message === undefined) throw new ToolFailure('Missing required param: message', 'INVALID_PARAMS');
  return { echo: params.message };
};

// ---------- delay.wait ----------

export const delayWait: ToolHandler = async (params) => {
  const raw = params.ms === undefined ? 1000 : Number(params.ms);
  if (!Number.isFinite(raw)) throw new ToolFailure('ms must be a number', 'INVALID_PARAMS');
  const ms = Math.min(Math.max(Math.round(raw), 100), 10000);
  await sleep(ms);
  return { waitedMs: ms };
};
