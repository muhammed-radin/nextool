/**
 * NexTool v1.0.13 §2.5 — FS Inspector OPERATOR TERMINAL (real FS).
 *
 * POST /api/inspector/terminal  { cwd: string(relative), command: string }
 *   → { stdout, stderr, code, signal, truncated, timedOut, cwd }
 *
 * The operator explicitly opened the real-FS inspector (spec §19 — the fs /
 * freedom-node side of the environment model). This route executes the given
 * command through /bin/bash with:
 *  - cwd confined to the runtime working directory (SAME containment contract
 *    as the fs route: NUL refused, resolve()-normalized, realpath-pinned —
 *    symlinks that leave the cwd are refused with FS_ACCESS);
 *  - a minimal environment (PATH/HOME/TERM — no provider or runtime secrets);
 *  - a HARD 30 s timeout (SIGKILL) — a terminal command can never stall the
 *    runtime;
 *  - stdout/stderr capped at 256 KiB each (truncated flag set honestly).
 *
 * stdin is ignored (non-interactive). The MCP environment has NO route to
 * this terminal — MCP tools are confined to the shared VFS (spec §4.3), and
 * the VFS "terminal" in the console maps its commands onto the VFS API.
 */
import { spawn } from 'node:child_process';
import nodePath from 'node:path';
import fsSync from 'node:fs';
import { fail } from '@/lib/nexool/api-helpers';
import { FsInspectorError, resolveConfined, fsErrorStatus } from '@/lib/nexool/inspector/fs-containment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_OUTPUT_BYTES = 256 * 1024;
const HARD_TIMEOUT_MS = 30_000;

export async function GET() {
  // Availability probe for the UI (terminal tab badge).
  return Response.json({ ok: true, data: { available: true, shell: '/bin/bash', cwd: '.', timeoutMs: HARD_TIMEOUT_MS } });
}

export async function POST(req: Request) {
  let body: { cwd?: unknown; command?: unknown };
  try {
    body = (await req.json()) as { cwd?: unknown; command?: unknown };
  } catch {
    return fail('INVALID_PARAMS', 'Request body must be valid JSON.', 400);
  }

  const command = typeof body.command === 'string' ? body.command.trim() : '';
  if (!command) return fail('INVALID_PARAMS', '"command" must be a non-empty string.', 400);
  const cwdRel = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : '.';

  let cwd: string;
  try {
    // Containment: resolve the requested cwd inside the runtime working dir.
    if (cwdRel === '.' || cwdRel === '/') {
      cwd = fsSync.realpathSync(process.cwd());
    } else {
      const resolved = resolveConfined(cwdRel);
      if (!fsSync.existsSync(resolved.real) || !fsSync.statSync(resolved.real).isDirectory()) {
        throw new FsInspectorError('ENOTDIR', `Terminal working directory '${cwdRel}' is not a directory.`);
      }
      cwd = resolved.real;
    }
  } catch (err) {
    if (err instanceof FsInspectorError) return fail(err.code, err.message, fsErrorStatus(err.code));
    return fail('FS_ERROR', err instanceof Error ? err.message : 'cwd resolution failed', 400);
  }

  return new Promise<Response>((resolve) => {
    let child;
    try {
      child = spawn('/bin/bash', ['-c', command], {
        cwd,
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: cwd,
          TERM: 'dumb',
          LANG: 'C.UTF-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve(fail('FS_CMD_SPAWN_FAILED', err instanceof Error ? err.message : 'Failed to spawn the shell.', 500));
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    const capChunk = (current: string, chunk: Buffer): { text: string; truncated: boolean } => {
      if (current.length >= MAX_OUTPUT_BYTES) return { text: current, truncated: true };
      const room = MAX_OUTPUT_BYTES - current.length;
      if (chunk.length > room) return { text: current + chunk.subarray(0, room).toString('utf8'), truncated: true };
      return { text: current + chunk.toString('utf8'), truncated };
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, HARD_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout?.on('data', (c: Buffer) => {
      const r = capChunk(stdout, c);
      stdout = r.text;
      truncated = truncated || r.truncated;
    });
    child.stderr?.on('data', (c: Buffer) => {
      const r = capChunk(stderr, c);
      stderr = r.text;
      truncated = truncated || r.truncated;
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve(fail('FS_CMD_ERROR', err.message, 500));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Report the cwd as the RELATIVE display path (never the host absolute).
      const rel = nodePath.relative(fsSync.realpathSync(process.cwd()), cwd) || '.';
      resolve(
        Response.json(
          {
            ok: true,
            data: { stdout, stderr, code: code ?? null, signal: signal ?? null, truncated, timedOut, cwd: rel },
          },
          { status: 200 },
        ),
      );
    });
  });
}
